// ============================================================================
// 대사 번역 — 외국어(중국어·일본어 등) 원문을 한국어로 곁들여 편집·화자 파악을 돕는다.
// ----------------------------------------------------------------------------
// ★원문(text)은 절대 안 건드린다 — 더빙은 계속 원문 언어로 읽는다([[reanimator-per-bubble-dialogue]]).
//   번역은 편집자용 주석(translation)일 뿐. 저가 모델·temperature 0·배치 1콜.
//   한국어 원문이면 스킵(언어 감지). 이미 번역 있으면 스킵(재실행 보존).
// ============================================================================

const PRICING = { "gpt-4o-mini": { input: 0.15, output: 0.6 } };

// 언어 감지 — Hangul 이 CJK 표의문자(한자)+일본어 가나보다 많으면 '한국어 원문'으로 보고 스킵.
// 한글이 하나도 없고 한자/가나가 있으면 번역 필요. 글자 없으면(기호·숫자만) 스킵.
export function needsTranslation(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  let hangul = 0;
  let foreign = 0; // 한자(CJK Unified/확장) + 일본어 히라가나·가타카나
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) hangul++; // 한글 음절
    else if (c >= 0x1100 && c <= 0x11ff) hangul++; // 한글 자모
    else if (c >= 0x4e00 && c <= 0x9fff) foreign++; // CJK 한자
    else if (c >= 0x3400 && c <= 0x4dbf) foreign++; // CJK 확장 A
    else if (c >= 0x3040 && c <= 0x30ff) foreign++; // 히라가나·가타카나
    else if (c >= 0xf900 && c <= 0xfaff) foreign++; // CJK 호환 한자
  }
  if (foreign === 0) return false; // 한글전용·영문·기호만 → 번역 불필요(편집자가 이미 읽음)
  return foreign > hangul; // 외국문자가 더 많을 때만(한글 섞인 한국어 문장 보호)
}

function costUsd(model, usage) {
  const p = PRICING[model] || PRICING["gpt-4o-mini"];
  return ((usage?.prompt_tokens ?? 0) * p.input + (usage?.completion_tokens ?? 0) * p.output) / 1e6;
}

// texts(원문 배열) → { translations: (string|null)[], cost }. 실패 시 translations 전부 null.
// 번역 필요 없는 항목(한국어·기호)은 null 로 반환(호출측이 스킵). 인덱스 대응 유지.
export async function translateTexts(texts, key, model = process.env.OPENAI_TRANSLATE_MODEL || "gpt-4o-mini") {
  const out = new Array(texts.length).fill(null);
  if (!key) return { translations: out, cost: 0 };
  const todo = [];
  texts.forEach((t, i) => {
    if (needsTranslation(t)) todo.push({ i, text: String(t) });
  });
  if (!todo.length) return { translations: out, cost: 0 };

  const numbered = todo.map((u, k) => `${k}: ${u.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
  const prompt =
    "다음은 만화(웹툰) 대사·자막들이다. 각 줄을 자연스러운 한국어로 번역하라. " +
    "번역만, 설명·따옴표·음역 금지. 이미 한국어면 그대로. 고유명사는 무리하게 바꾸지 마라. " +
    '오직 JSON: {"t":[{"i":줄번호,"k":"한국어 번역"}]}\n\n' +
    numbered;

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1500,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) return { translations: out, cost: 0 };
    const d = await r.json();
    const parsed = JSON.parse(d.choices?.[0]?.message?.content ?? "{}");
    for (const e of parsed.t ?? []) {
      const k = Number(e?.i);
      const kr = typeof e?.k === "string" ? e.k.trim() : "";
      if (Number.isInteger(k) && k >= 0 && k < todo.length && kr) out[todo[k].i] = kr.slice(0, 400);
    }
    return { translations: out, cost: costUsd(model, d.usage) };
  } catch {
    return { translations: out, cost: 0 };
  }
}

// bubbles 배열에 translation 을 채운다(원본 배열 in-place 수정). 이미 translation 있으면 스킵.
// 반환: { translated: 채운 개수, cost }.
export async function translateBubbles(bubbles, key) {
  const bs = bubbles || [];
  const idxs = [];
  bs.forEach((b, i) => {
    if (b && (b.text || "").trim() && !(b.translation || "").trim()) idxs.push(i);
  });
  if (!idxs.length) return { translated: 0, cost: 0 };
  const { translations, cost } = await translateTexts(idxs.map((i) => bs[i].text), key);
  let translated = 0;
  translations.forEach((kr, k) => {
    if (kr) {
      bs[idxs[k]].translation = kr;
      translated++;
    }
  });
  return { translated, cost };
}
