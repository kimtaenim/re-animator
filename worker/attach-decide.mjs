// ============================================================================
// 갭 내레이션 부착 결정 — 컷 사이 '글자만 있는 공간'의 서술이 위 장면(prev)에 속하는지
// 아래 장면(next)에 속하는지 gpt-4o 가 그림 내용을 보고 판단한다.
// ----------------------------------------------------------------------------
// 입력: 갭 글자 + 위/아래 컷 썸네일(작게). 출력: "prev" | "next". 실패하면 null → 호출측 폴백.
// ============================================================================

const PRICING = { "gpt-4o": { input: 2.5, output: 10 } };
function costUsd(model, usage) {
  const p = PRICING[model] || PRICING["gpt-4o"];
  return ((usage?.prompt_tokens ?? 0) * p.input + (usage?.completion_tokens ?? 0) * p.output) / 1e6;
}

const SCHEMA = {
  name: "attach_side",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      side: { type: "string", enum: ["prev", "next"] },
    },
    required: ["side"],
  },
};

// gapText 서술이 위 장면(첫 이미지)과 아래 장면(둘째 이미지) 중 어디 흐름에 속하나.
// prevThumb/nextThumb = jpeg Buffer. 둘 중 하나가 없으면 있는 쪽을 그대로 반환.
export async function decideAttachSide(gapText, prevThumb, nextThumb, key, model = "gpt-4o") {
  if (!key) return { side: null, cost: 0 };
  if (!prevThumb && !nextThumb) return { side: null, cost: 0 };
  if (!prevThumb) return { side: "next", cost: 0 };
  if (!nextThumb) return { side: "prev", cost: 0 };
  const prompt =
    "웹툰에서 컷과 컷 사이 '글자만 있는 공간'의 서술(내레이션/캡션)이야: \n" +
    `「${(gapText || "").slice(0, 300)}」\n` +
    "첫 번째 이미지는 이 글 ★바로 위★ 장면, 두 번째 이미지는 ★바로 아래★ 장면이야. " +
    "이 서술이 위 장면의 흐름에 속하면 \"prev\", 아래 장면을 여는(설명하는) 흐름이면 \"next\". " +
    "장면 내용을 보고 더 자연스러운 쪽을 골라. 오직 JSON.";
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
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${prevThumb.toString("base64")}`, detail: "low" } },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${nextThumb.toString("base64")}`, detail: "low" } },
            ],
          },
        ],
        response_format: { type: "json_schema", json_schema: SCHEMA },
        max_tokens: 40,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) return { side: null, cost: 0 };
    const d = await r.json();
    const parsed = JSON.parse(d.choices?.[0]?.message?.content ?? "{}");
    const side = parsed.side === "prev" || parsed.side === "next" ? parsed.side : null;
    return { side, cost: costUsd(model, d.usage) };
  } catch {
    return { side: null, cost: 0 };
  }
}
