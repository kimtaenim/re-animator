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

// ★OCR 교정(보수적) — 컷마다 따로 OCR 해서 같은 고유명사를 다르게 읽거나(诺德/诸德/浩德) 비슷한
//   글자를 오독하는 걸, 전체 대사를 Claude 에 '한 번에' 줘서 문맥으로 바로잡는다. per-cut OCR엔 없는
//   문맥이 여기 있다. ★번역·의역 아님 — 원문 언어 그대로, 확실한 것만 고치고 멀쩡한 건 안 건드림.
//   bubbles.text 를 제자리(in-place) 교정. 반환 { fixed, cost }. 실패/키없음이면 무변경.
export async function proofreadScenes(scenes) {
  const client = await getClient();
  if (!client) return { fixed: 0, cost: 0 };
  const items = []; // { b, text }
  for (const s of scenes ?? []) {
    for (const b of s?.cut?.bubbles ?? []) {
      if (b.speakerId === "__sfx__") continue;
      const t = (b.text || "").trim();
      if (t && needsTranslation(t)) items.push({ b, text: t }); // 외국어 원문만(한국어는 이미 정상)
    }
  }
  if (items.length < 2) return { fixed: 0, cost: 0 }; // 통일·대조하려면 여러 줄 필요

  const numbered = items.map((it, k) => `${k}. ${it.text.replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
  const prompt =
    "다음은 웹툰을 컷별로 따로 OCR 한 대사 줄들이라 오독이 섞여 있을 수 있다. ★아주 보수적으로★ 교정하라:\n" +
    "(1) 명백히 같은 고유명사(인물·지명 등)를 컷마다 다르게 읽은 변형은 가장 그럴듯한 하나로 통일하라. 예: 诺德/诸德/浩德 → 诺德.\n" +
    "(2) 문맥상 명백한 OCR 오독(모양 비슷한 글자 오인)만 고쳐라.\n" +
    "★그 외 멀쩡한 글자는 절대 바꾸지 마라. 확신 없으면 원문 그대로 둬라. 번역·의역·문장 다듬기·부호 정리 전부 금지. 원문 언어 그대로.★\n" +
    '오직 JSON 으로만 답하라. 고친 줄만 넣어라(안 고친 줄은 빼라): {"c":[{"i":줄번호,"t":"교정된 원문"}]}\n\n' +
    numbered;

  try {
    const res = await client.messages.create({ model: MODEL, max_tokens: 4000, messages: [{ role: "user", content: prompt }] });
    if (res.stop_reason === "refusal") return { fixed: 0, cost: 0 };
    let raw = res.content?.find((x) => x.type === "text")?.text ?? "{}";
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
    const parsed = JSON.parse(raw);
    let fixed = 0;
    for (const c of parsed.c ?? []) {
      const k = Number(c?.i);
      const nt = typeof c?.t === "string" ? c.t.trim() : "";
      if (!Number.isInteger(k) || k < 0 || k >= items.length || !nt) continue;
      const old = items[k].text;
      if (nt === old) continue;
      // ★안전장치: 통째로 바꿔치기(길이 급변) 방지 — 보수적 교정만 반영.
      if (Math.abs(nt.length - old.length) > Math.max(4, Math.ceil(old.length * 0.4))) continue;
      items[k].b.text = nt.slice(0, 400);
      fixed++;
    }
    const cost = (res.usage?.input_tokens ?? 0) * IN_USD + (res.usage?.output_tokens ?? 0) * OUT_USD;
    return { fixed, cost };
  } catch {
    return { fixed: 0, cost: 0 };
  }
}

// ── 다국어 번역(스펙 §10) — 원어 → 선택된 각 언어(ja/en…)를 한 콜에 동시 번역. ──────────
//   결과는 말풍선 tracks[lang].text 로. 원어(text)·한국어(translation)는 건드리지 않는다(가산).
const LANG_NAMES = { ja: "일본어(Japanese)", en: "영어(English)", ko: "한국어(Korean)", zh: "중국어(Chinese)", es: "스페인어(Spanish)" };

// texts → { result: { [lang]: (string|null)[] }, cost }. 인덱스 대응 유지. 빈 줄은 null.
export async function translateToLanguages(texts, langs) {
  const result = {};
  (langs || []).forEach((l) => (result[l] = new Array(texts.length).fill(null)));
  const client = await getClient();
  if (!client || !langs?.length) return { result, cost: 0 };
  const todo = [];
  texts.forEach((t, i) => {
    if ((t || "").trim()) todo.push({ i, text: String(t) });
  });
  if (!todo.length) return { result, cost: 0 };

  const langList = langs.map((l) => `"${l}"(${LANG_NAMES[l] || l})`).join(", ");
  const keyList = langs.map((l) => `"${l}":"${l} 번역"`).join(", ");
  const numbered = todo.map((u, k) => `${k}. ${u.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
  const prompt =
    `다음은 만화(웹툰) 대사·자막이다. 각 줄을 아래 언어들로 각각 자연스럽게 번역하라: ${langList}. ` +
    "누가 하는 말인지(인물 대사/내레이터) 감안해 화자 말투를 살려라(반말/존댓말·거칠/부드러움·놀람 등). " +
    "밋밋한 직역·설명·따옴표 금지. 고유명사는 무리하게 바꾸지 마라.\n" +
    `오직 JSON 으로만 답하라: {"t":[{"i":줄번호, ${keyList}}]}\n\n` +
    numbered;

  try {
    const res = await client.messages.create({ model: MODEL, max_tokens: 4000, messages: [{ role: "user", content: prompt }] });
    if (res.stop_reason === "refusal") return { result, cost: 0 };
    let raw = res.content?.find((b) => b.type === "text")?.text ?? "{}";
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
    const parsed = JSON.parse(raw);
    for (const item of parsed.t ?? []) {
      const k = Number(item?.i);
      if (!Number.isInteger(k) || k < 0 || k >= todo.length) continue;
      for (const l of langs) {
        const v = typeof item?.[l] === "string" ? item[l].trim() : "";
        if (v) result[l][todo[k].i] = v.slice(0, 400);
      }
    }
    const cost = (res.usage?.input_tokens ?? 0) * IN_USD + (res.usage?.output_tokens ?? 0) * OUT_USD;
    return { result, cost };
  } catch {
    return { result, cost: 0 };
  }
}

// scenes 의 말풍선(text, 효과음 제외) → 각 언어 tracks[lang].text 채움(in-place). 이미 있으면 스킵.
// 원어가 한국어여도 ja/en 은 필요하므로 번역한다(§10). 반환 { translated, cost }.
export async function translateScenesMultilang(scenes, langs) {
  if (!langs?.length) return { translated: 0, cost: 0 };
  const items = []; // { b, text }
  for (const s of scenes ?? []) {
    for (const b of s?.cut?.bubbles ?? []) {
      if (!b || b.speakerId === "__sfx__") continue;
      const t = (b.text || "").trim();
      if (!t) continue;
      const need = langs.some((l) => !(b.tracks?.[l]?.text)); // 하나라도 빠진 언어 있으면 대상
      if (need) items.push({ b, text: t });
    }
  }
  if (!items.length) return { translated: 0, cost: 0 };
  let translated = 0;
  let cost = 0;
  const CHUNK = 50;
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    const { result, cost: c } = await translateToLanguages(slice.map((it) => it.text), langs);
    cost += c;
    slice.forEach((it, k) => {
      let any = false;
      it.b.tracks = it.b.tracks || {};
      for (const l of langs) {
        const v = result[l]?.[k];
        if (v) {
          it.b.tracks[l] = { ...(it.b.tracks[l] || {}), text: v, status: "translated" };
          any = true;
        }
      }
      if (any) translated++;
    });
  }
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
