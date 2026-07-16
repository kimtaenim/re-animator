// ============================================================================
// 글씨 읽기(OCR) — 추출된 풀해상도 컷 이미지에서 대사·효과음을 정확히 전사 + 글씨 박스.
// ----------------------------------------------------------------------------
// 대조표 썸네일이 아니라 '풀해상도 컷 하나'를 gpt-4o(detail high)에 준다 → 한글 정확.
// 박스(0~1)는 마스크 재생성에서 '글씨 지울 곳'으로 재사용.
// ============================================================================

import sharp from "sharp";

const PRICING = { "gpt-4o": { input: 2.5, output: 10 } };

// OCR 전 리사이즈 — '긴 변'을 2048(gpt-4o high-detail 창 최대치)에 맞춘다. 작으면 확대,
// 크면 lanczos 로 깔끔히 축소. ★ 예전엔 '폭'만 1600으로 키워서, 세로로 긴 컷은 높이가
// 6000+ 가 되고 OpenAI 가 2048로 되축소 → 글자가 더 작아져 OCR 엉터리였음. 긴 변 기준이면
// 특히 대사 밴드(짧고 넓음)가 크게 확대돼 정확. + 샤픈으로 글자 또렷하게.
async function upscaleForOcr(pngBuf) {
  try {
    const m = await sharp(pngBuf).metadata();
    const w = m.width || 0;
    const h = m.height || 0;
    if (!w || !h) return pngBuf;
    const TARGET = Number(process.env.OCR_MAX_SIDE || 2048);
    const longest = Math.max(w, h);
    if (Math.abs(longest - TARGET) > 8) {
      const scale = TARGET / longest;
      return await sharp(pngBuf)
        .resize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), {
          kernel: "lanczos3",
        })
        .sharpen()
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
  "bubbles = 말풍선/대사/자막을 ★말풍선(글상자) 단위로 하나씩★ 배열로. 각 항목: text(그 풍선 글자를 ★원문 언어 그대로, 보이는 그대로 정확히★ — 번역·음역 금지, 빠뜨리거나 지어내지 마라, 확실히 안 읽히면 빈 문자열. 한국어일 때만 띄어쓰기를 표준 맞춤법에 맞게 정리. 세로쓰기·줄바꿈은 한 줄로 이어라)와 그 풍선 영역 박스(left,top,right,bottom, 이미지 대비 0~1). 서로 다른 인물의 말풍선은 반드시 다른 항목으로 나눠라. 글자 없으면 빈 배열. " +
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
