// ============================================================================
// 글씨 읽기(OCR) — 추출된 풀해상도 컷 이미지에서 대사·효과음을 정확히 전사 + 글씨 박스.
// ----------------------------------------------------------------------------
// 대조표 썸네일이 아니라 '풀해상도 컷 하나'를 gpt-4o(detail high)에 준다 → 한글 정확.
// 박스(0~1)는 마스크 재생성에서 '글씨 지울 곳'으로 재사용.
// ============================================================================

import sharp from "sharp";

const PRICING = { "gpt-4o": { input: 2.5, output: 10 } };

// OCR 전 컷을 확대 — 작은 말풍선 글자를 키워 gpt-4o 타일링에서 더 잘 읽히게.
// 폭이 좁으면 최대 1600px까지 업스케일(정보는 안 늘지만 타일당 디테일↑).
async function upscaleForOcr(pngBuf) {
  try {
    const m = await sharp(pngBuf).metadata();
    const w = m.width || 0;
    if (w > 0 && w < 1600) {
      return await sharp(pngBuf)
        .resize({ width: 1600, withoutEnlargement: false, kernel: "lanczos3" })
        .png()
        .toBuffer();
    }
  } catch {
    /* 원본 그대로 */
  }
  return pngBuf;
}
function costUsd(model, usage) {
  const p = PRICING[model] || PRICING["gpt-4o"];
  return ((usage?.prompt_tokens ?? 0) * p.input + (usage?.completion_tokens ?? 0) * p.output) / 1e6;
}

const BOX_PROPS = {
  left: { type: "number" },
  top: { type: "number" },
  right: { type: "number" },
  bottom: { type: "number" },
};
const OCR_SCHEMA = {
  name: "cut_text",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      // 말풍선(대사) 단위 — 각 풍선의 글자 + 그 풍선 영역. 화자를 풍선마다 붙일 수 있게.
      bubbles: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            left: { type: "number" },
            top: { type: "number" },
            right: { type: "number" },
            bottom: { type: "number" },
          },
          required: ["text", "left", "top", "right", "bottom"],
        },
      },
      sfx: { type: "string" },
      // 마스크 재생성용 — 모든 글자(말풍선·자막·효과음) 영역.
      boxes: {
        type: "array",
        items: { type: "object", additionalProperties: false, properties: BOX_PROPS, required: ["left", "top", "right", "bottom"] },
      },
    },
    required: ["bubbles", "sfx", "boxes"],
  },
};

const PROMPT =
  "이 만화 컷 이미지의 모든 글자를 읽어라. " +
  "bubbles = 말풍선/대사/자막을 ★말풍선(글상자) 단위로 하나씩★ 배열로. 각 항목: text(그 풍선 글자를 ★보이는 그대로 한 글자도 안 틀리게★ — 확실히 안 읽히면 빈 문자열, 절대 지어내지 마라)와 그 풍선 영역 박스(left,top,right,bottom, 이미지 대비 0~1). 서로 다른 인물의 말풍선은 반드시 다른 항목으로 나눠라. 글자 없으면 빈 배열. " +
  "sfx = 효과음/의성어 글자(있으면 그대로, 없으면 빈 문자열). " +
  "boxes = 마스크용 — 모든 글자(말풍선·자막·효과음)가 차지한 영역들을 0~1 박스로. 글자 없으면 빈 배열. " +
  "오직 JSON.";

// pngBuf(풀해상도 컷) → { dialogue, sfx, boxes, cost }. 실패 시 throw.
export async function readCutText(pngBuf, key, model = "gpt-4o") {
  const img = await upscaleForOcr(pngBuf);
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${img.toString("base64")}`,
                detail: "high",
              },
            },
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: OCR_SCHEMA },
      max_tokens: 1500,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  const d = await r.json();
  const parsed = JSON.parse(d.choices?.[0]?.message?.content ?? "{}");
  const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  const validBox = (b) => b.right > b.left && b.bottom > b.top;
  const boxes = (parsed.boxes || [])
    .map((b) => ({ left: clamp(b.left), top: clamp(b.top), right: clamp(b.right), bottom: clamp(b.bottom) }))
    .filter(validBox);
  const bubbles = (parsed.bubbles || [])
    .map((b) => ({
      text: typeof b.text === "string" ? b.text.slice(0, 400) : "",
      box: { left: clamp(b.left), top: clamp(b.top), right: clamp(b.right), bottom: clamp(b.bottom) },
    }))
    .filter((b) => b.text.trim() !== "") // 글자 없는 풍선은 버림
    .slice(0, 12);
  // 하위호환: dialogue = 풍선 글자들 합침. textBoxes 는 boxes(없으면 풍선 박스)로.
  const dialogue = bubbles.map((b) => b.text.trim()).filter(Boolean).join("\n").slice(0, 500);
  const textBoxes = (boxes.length ? boxes : bubbles.map((b) => b.box).filter(validBox)).slice(0, 12);
  return {
    bubbles,
    dialogue,
    sfx: typeof parsed.sfx === "string" ? parsed.sfx.slice(0, 200) : "",
    boxes: textBoxes,
    cost: costUsd(model, d.usage),
  };
}
