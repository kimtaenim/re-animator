// ============================================================================
// 대사 번역 — 외국어 원문을 한국어로 곁들여 편집·화자 파악을 돕는다. ★번역은 Claude 로 한다
//   (사용자 지시). 워커에 이미 ANTHROPIC_API_KEY 있음(director 와 공유). 원문(text)은 안 건드림 —
//   번역은 편집 주석(translation)일 뿐, 더빙은 원문 언어. 화자 말투를 살려서 옮긴다.
// ============================================================================

const MODEL = process.env.CLAUDE_TRANSLATE_MODEL || "claude-haiku-4-5";
const IN_USD = 1 / 1e6; // haiku-4-5 $1/$5 per MTok
const OUT_USD = 5 / 1e6;

// 언어 감지 — 한글만 모국어. 한글보다 비한글 글자가 많으면(외국어 위주) 번역. 숫자·기호·한글전용은 스킵.
export function needsTranslation(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  const letters = t.match(/\p{L}/gu) || [];
  if (letters.length === 0) return false;
  const hangul = (t.match(/\p{Script=Hangul}/gu) || []).length;
  const other = letters.length - hangul;
  if (other === 0) return false;
  return other > hangul;
}

let _client = null;
async function getClient() {
  if (_client !== null) return _client;
  if (!process.env.ANTHROPIC_API_KEY) return (_client = false);
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return (_client = new Anthropic());
}

// texts(원문 배열) → { translations: (string|null)[], cost }. 한국어·기호는 null(스킵). 인덱스 대응 유지.
// 화자 말투(반말/존댓말·거친/부드러운·놀람 등)를 살려 자연스러운 한국어로. Claude(Anthropic).
export async function translateTexts(texts) {
  const out = new Array(texts.length).fill(null);
  const client = await getClient();
  if (!client) return { translations: out, cost: 0 };
  const todo = [];
  texts.forEach((t, i) => {
    if (needsTranslation(t)) todo.push({ i, text: String(t) });
  });
  if (!todo.length) return { translations: out, cost: 0 };

  const numbered = todo.map((u, k) => `${k}. ${u.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
  const prompt =
    "다음은 만화(웹툰) 대사·자막이다. 각 줄을 자연스러운 한국어로 번역하라. " +
    "누가 하는 말인지(인물 대사인지 내레이터 해설인지) 감안해 그 화자 말투로 옮겨라 — 반말/존댓말, 거친/부드러운, " +
    "놀람·다급함 등 반영. 밋밋한 직역 금지, 설명·따옴표 금지. 고유명사는 무리하게 바꾸지 마라.\n" +
    '오직 JSON 으로만 답하라: {"t":[{"i":줄번호,"k":"한국어 번역"}]}\n\n' +
    numbered;

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    if (res.stop_reason === "refusal") return { translations: out, cost: 0 };
    let raw = res.content?.find((b) => b.type === "text")?.text ?? "{}";
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s >= 0 && e > s) raw = raw.slice(s, e + 1); // 앞뒤 잡소리 있어도 JSON 만 추림
    const parsed = JSON.parse(raw);
    for (const item of parsed.t ?? []) {
      const k = Number(item?.i);
      const kr = typeof item?.k === "string" ? item.k.trim() : "";
      if (Number.isInteger(k) && k >= 0 && k < todo.length && kr) out[todo[k].i] = kr.slice(0, 400);
    }
    const cost = (res.usage?.input_tokens ?? 0) * IN_USD + (res.usage?.output_tokens ?? 0) * OUT_USD;
    return { translations: out, cost };
  } catch {
    return { translations: out, cost: 0 };
  }
}

// bubbles 배열에 translation 채움(in-place). 이미 있으면 스킵. 반환 { translated, cost }.
export async function translateBubbles(bubbles) {
  const bs = bubbles || [];
  const idxs = [];
  bs.forEach((b, i) => {
    if (b && (b.text || "").trim() && !(b.translation || "").trim() && b.speakerId !== "__sfx__") idxs.push(i);
  });
  if (!idxs.length) return { translated: 0, cost: 0 };
  const { translations, cost } = await translateTexts(idxs.map((i) => bs[i].text));
  let translated = 0;
  translations.forEach((kr, k) => {
    if (kr) {
      bs[idxs[k]].translation = kr;
      translated++;
    }
  });
  return { translated, cost };
}

// ★프로젝트 전체를 한 번의 Claude 호출로 번역(비용·지연 최소). 컷 대사(dialogue→dialogueTranslation)
//   + 모든 말풍선(text→translation, 효과음 제외)을 다 모아 1콜. Claude 가 준 번역만 덮어쓴다
//   (실패해 null 이면 기존값 유지 = gpt-4o 폴백 보존). 반환 { translated, cost }.
export async function translateScenes(scenes) {
  const items = []; // { text, apply(kr) }
  for (const s of scenes ?? []) {
    const cut = s?.cut;
    if (!cut) continue;
    const d = (cut.dialogue || "").trim();
    if (needsTranslation(d)) items.push({ text: d, apply: (kr) => (cut.dialogueTranslation = kr) });
    for (const b of cut.bubbles ?? []) {
      if (b.speakerId === "__sfx__") continue;
      const t = (b.text || "").trim();
      if (needsTranslation(t)) items.push({ text: t, apply: (kr) => (b.translation = kr) });
    }
  }
  if (!items.length) return { translated: 0, cost: 0 };
  // 너무 많으면 400줄씩 쪼개 여러 콜(응답 잘림 방지).
  let translated = 0;
  let cost = 0;
  const CHUNK = 60;
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    const { translations, cost: c } = await translateTexts(slice.map((it) => it.text));
    cost += c;
    translations.forEach((kr, k) => {
      if (kr) {
        slice[k].apply(kr);
        translated++;
      }
    });
  }
  return { translated, cost };
}
