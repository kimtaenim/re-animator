// ============================================================================
// 얼굴·손 박스 감지 — 자막을 '얼굴/손 위'에 얹지 않으려고 그 위치만 가볍게 묻는다.
// ----------------------------------------------------------------------------
// OCR 과 같은 gpt-4o(json_schema strict). 정밀 검출 아님 — 자막 회피용 대략 박스면 충분.
// 이미지는 작게(≤768) 줘서 싸고 빠르게. 실패하면 {faces:[],hands:[]} → 자막은 정상 진행.
// ============================================================================

import sharp from "sharp";

const PRICING = { "gpt-4o": { input: 2.5, output: 10 } };
function costUsd(model, usage) {
  const p = PRICING[model] || PRICING["gpt-4o"];
  return ((usage?.prompt_tokens ?? 0) * p.input + (usage?.completion_tokens ?? 0) * p.output) / 1e6;
}

const BOX = {
  type: "object",
  additionalProperties: false,
  properties: {
    left: { type: "number" },
    top: { type: "number" },
    right: { type: "number" },
    bottom: { type: "number" },
  },
  required: ["left", "top", "right", "bottom"],
};
const SCHEMA = {
  name: "face_hand_boxes",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      faces: { type: "array", items: BOX },
      hands: { type: "array", items: BOX },
    },
    required: ["faces", "hands"],
  },
};

const PROMPT =
  "이 이미지에서 ★사람(또는 캐릭터)의 얼굴★과 ★손★이 차지한 영역만 박스로 알려줘. " +
  "faces = 얼굴(머리 포함) 영역들, hands = 손 영역들. " +
  "각 박스는 이미지 대비 0~1 좌표(left,top,right,bottom). " +
  "얼굴/손이 없으면 빈 배열. 대략적이어도 되지만 얼굴은 빠뜨리지 마. 오직 JSON.";

// imgBuf → { faces:[{left,top,right,bottom}], hands:[…], cost }. 실패해도 throw 안 함.
export async function detectFaceHandBoxes(imgBuf, key, model = "gpt-4o") {
  const empty = { faces: [], hands: [], cost: 0 };
  if (!key) return empty;
  let small = imgBuf;
  try {
    small = await sharp(imgBuf).resize(768, 768, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  } catch {
    /* 원본 그대로 시도 */
  }
  try {
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
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${small.toString("base64")}`, detail: "low" } },
            ],
          },
        ],
        response_format: { type: "json_schema", json_schema: SCHEMA },
        max_tokens: 600,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) return empty;
    const d = await r.json();
    const parsed = JSON.parse(d.choices?.[0]?.message?.content ?? "{}");
    const cl = (v) => Math.max(0, Math.min(1, Number(v) || 0));
    const norm = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .map((b) => ({ left: cl(b.left), top: cl(b.top), right: cl(b.right), bottom: cl(b.bottom) }))
        .filter((b) => b.right > b.left && b.bottom > b.top)
        .slice(0, 12);
    return { faces: norm(parsed.faces), hands: norm(parsed.hands), cost: costUsd(model, d.usage) };
  } catch {
    return empty;
  }
}
