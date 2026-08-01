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
  // ★타임아웃·재시도 상한 — 기본값(10분·재시도2)이면 번역 호출 하나가 느리거나 막힐 때
  //   워커(한 번에 한 잡)가 몇 분씩 매달려 '먹통'이 된다. 90초·재시도1 로 캡(막히면 빨리 실패).
  return (_client = new Anthropic({ timeout: 90_000, maxRetries: 1 }));
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
      max_tokens: MAX_OUT, // ★2000 이면 60줄 요청 시 응답이 잘려 그 덩어리가 통째로 버려졌다
      messages: [{ role: "user", content: prompt }],
    });
    if (res.stop_reason === "refusal") return { translations: out, cost: 0, truncated: false };
    const truncated = res.stop_reason === "max_tokens";
    const raw = res.content?.find((b) => b.type === "text")?.text ?? "{}";
    // 잘려도 완결된 항목까지는 건진다(예전엔 JSON.parse 실패로 전부 버림).
    let got = 0;
    for (const item of salvageItems(raw)) {
      const k = Number(item?.i);
      const kr = typeof item?.k === "string" ? item.k.trim() : "";
      if (Number.isInteger(k) && k >= 0 && k < todo.length && kr) {
        out[todo[k].i] = kr.slice(0, 400);
        got++;
      }
    }
    const cost = (res.usage?.input_tokens ?? 0) * IN_USD + (res.usage?.output_tokens ?? 0) * OUT_USD;
    return { translations: out, cost, truncated: truncated || got < todo.length };
  } catch (e) {
    return { translations: out, cost: 0, truncated: false, error: String(e?.message ?? e) };
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
    const res = await client.messages.create({ model: MODEL, max_tokens: MAX_OUT, messages: [{ role: "user", content: prompt }] });
    if (res.stop_reason === "refusal") return { fixed: 0, cost: 0 };
    const raw = res.content?.find((x) => x.type === "text")?.text ?? "{}";
    let fixed = 0;
    for (const c of salvageItems(raw)) {
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
// ★번역이 "나오다 말다" 했던 진짜 원인 처리 —
//   50줄 × 여러 언어를 max_tokens 4000 으로 요청하면 응답 JSON 이 중간에서 잘리고,
//   JSON.parse 실패 → catch 가 그 덩어리(수십 줄)를 통째로 조용히 버렸다.
//   잘린 덩어리는 번역이 아예 없고 안 잘린 덩어리는 채워져 들쭉날쭉해졌다.
//   → (1) 잘림을 감지하고 (2) 잘려도 완성된 항목까지는 건져내고 (3) 호출측이 분할 재시도한다.
const MAX_OUT = Number(process.env.TRANSLATE_MAX_TOKENS || 8000);

// 잘린 JSON 에서 완성된 객체들만 건져 배열로. 실패하면 [].
// 파싱된 값에서 '번역 항목'(i 를 가진 객체)만 꺼낸다. {"t":[…]} 처럼 감싸여 있어도 펼친다.
function collect(o, out, depth = 0) {
  if (!o || typeof o !== "object" || depth > 4) return;
  if (Array.isArray(o)) {
    for (const e of o) collect(e, out, depth + 1);
    return;
  }
  if (o.i !== undefined) {
    out.push(o);
    return;
  }
  for (const v of Object.values(o)) if (v && typeof v === "object") collect(v, out, depth + 1);
}

// ★export = 테스트용(scripts/test-translate-parse.mjs). 이 파서가 조용히 0줄을 돌려주는 바람에
//   "번역을 몇 번을 돌려도 같은 줄이 안 채워진다" 가 몇 주간 반복됐다 → 테스트로 못박는다.
export function salvageItems(raw) {
  const out = [];
  const text = String(raw ?? "");
  // ① 통째로 파싱되면 그걸 쓴다 — 정상 응답 {"t":[…]} 은 여기서 다 꺼내진다.
  //   ★예전 파서는 '바깥 괄호가 depth 0 으로 닫히는 객체' 만 담았다. 그래서
  //     (a) 정상 응답이면 i 없는 바깥 객체 하나만 담겨 호출측이 전부 버렸고
  //     (b) 응답이 잘리면 바깥 괄호가 안 닫혀 아무것도 못 건졌다.
  //     결국 모델이 배열만 돌려준 우연한 경우에만 동작했다 = "번역이 들쭉날쭉".
  try {
    collect(JSON.parse(text.replace(/```(?:json)?/gi, "").trim()), out);
  } catch {}
  if (out.length) return out;

  // ② 통째 파싱이 안 되면(잘림·설명 섞임) 중첩 깊이와 무관하게 '완결된 객체' 를 전부 긁는다.
  //   문자열 안의 중괄호는 건너뛴다(대사에 { } 가 있어도 깨지지 않게).
  const stack = [];
  const seen = new Set();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "{") stack.push(i);
    else if (ch === "}" && stack.length) {
      const s = stack.pop();
      try {
        const o = JSON.parse(text.slice(s, i + 1));
        if (o && typeof o === "object" && !Array.isArray(o) && o.i !== undefined && !seen.has(o.i)) {
          seen.add(o.i);
          out.push(o);
        }
      } catch {}
    }
  }
  return out;
}

// opts._call = 테스트용 주입점(모델 호출만 가짜로 바꿔 '번역을 채우는 코드 전체'를 실제로 실행).
// ★이 경로가 한 달간 조용히 0줄을 돌려줬는데, 네트워크가 필요해서 아무도 실행해보지 않았다.
export async function translateToLanguages(texts, langs, opts = {}) {
  const result = {};
  (langs || []).forEach((l) => (result[l] = new Array(texts.length).fill(null)));
  const client = opts._call ? { messages: { create: opts._call } } : await getClient();
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
    const res = await client.messages.create({ model: MODEL, max_tokens: MAX_OUT, messages: [{ role: "user", content: prompt }] });
    // ★거부도 '조용한 0줄' 이 아니라 이유로 돌려준다 — 예전엔 그냥 빈 결과라 원인을 알 수 없었다.
    if (res.stop_reason === "refusal")
      return { result, cost: 0, truncated: false, error: "모델이 이 대사 번역을 거부했습니다(refusal)" };
    const truncated = res.stop_reason === "max_tokens";
    const raw = res.content?.find((b) => b.type === "text")?.text ?? "{}";
    // ★잘렸든 아니든 '완결된 항목'만 골라 담는다 → 잘려도 앞부분은 살린다(예전엔 전부 버렸다).
    const items = salvageItems(raw).filter((o) => o.i !== undefined);
    let got = 0;
    for (const item of items) {
      const k = Number(item?.i);
      if (!Number.isInteger(k) || k < 0 || k >= todo.length) continue;
      for (const l of langs) {
        const v = typeof item?.[l] === "string" ? item[l].trim() : "";
        if (v) {
          result[l][todo[k].i] = v.slice(0, 400);
          got++;
        }
      }
    }
    const cost = (res.usage?.input_tokens ?? 0) * IN_USD + (res.usage?.output_tokens ?? 0) * OUT_USD;
    // 잘렸거나 받은 게 요청보다 적으면 호출측이 쪼개 재시도하도록 알린다.
    return { result, cost, truncated: truncated || got < todo.length * langs.length };
  } catch (e) {
    return { result, cost: 0, truncated: false, error: String(e?.message ?? e) };
  }
}

// scenes 의 말풍선(text, 효과음 제외) → 각 언어 tracks[lang].text 채움(in-place). 이미 있으면 스킵.
// 원어가 한국어여도 ja/en 은 필요하므로 번역한다(§10). 반환 { translated, cost }.
export async function translateScenesMultilang(scenes, langs, opts = {}) {
  if (!langs?.length) return { translated: 0, cost: 0 };
  const items = []; // { b, text }
  let copied = 0; // 번역할 글자가 없어 원문을 그대로 채운 줄(…·!? 등)
  for (const s of scenes ?? []) {
    for (const b of s?.cut?.bubbles ?? []) {
      if (!b || b.speakerId === "__sfx__") continue;
      const t = (b.text || "").trim();
      if (!t) continue;
      const need = langs.some((l) => !(b.tracks?.[l]?.text)); // 하나라도 빠진 언어 있으면 대상
      if (!need) continue;
      // ★번역할 '글자' 가 없는 줄(…, !?, ♪ 같은 기호·문장부호뿐)은 모델이 빈 값을 돌려준다.
      //   그러면 tracks 가 영영 안 채워지고, 그 줄 때문에 더빙이 "번역이 아직 없어요" 로 계속
      //   막혔다(사용자: 번역을 몇 번이나 다시 돌려도 같은 자리). 번역할 게 없으므로 원문을
      //   그대로 채운다 — 조용한 '원문 폴백' 이 아니라, 문자가 없는 줄에 한정된 명시 규칙이다.
      if (!/[\p{Letter}\p{Number}]/u.test(t)) {
        b.tracks = b.tracks || {};
        for (const l of langs) if (!b.tracks[l]?.text) b.tracks[l] = { ...(b.tracks[l] || {}), text: t, status: "copied" };
        copied++;
        continue;
      }
      items.push({ b, text: t });
    }
  }
  if (!items.length) return { translated: copied, cost: 0, errors: [] };
  let translated = copied;
  let cost = 0;
  const errors = []; // 번역이 0줄일 때 '왜' 를 호출측이 사용자에게 보여줄 수 있게
  // ★덩어리 크기를 언어 수로 나눈다 — 50줄 × 2언어면 출력이 max_tokens 를 넘겨 잘렸다.
  //   (잘리면 그 덩어리 전체가 버려져 번역이 들쭉날쭉해졌다 = 사용자 보고의 원인.)
  const CHUNK = Math.max(6, Math.floor(Number(process.env.TRANSLATE_CHUNK || 40) / Math.max(1, langs.length)));

  const apply = (slice, result) => {
    let n = 0;
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
      if (any) n++;
    });
    return n;
  };

  // 한 덩어리 처리 — 잘리거나 빠진 줄이 있으면 반으로 쪼개 재귀 재시도(끝까지 채운다).
  const run = async (slice, depth = 0) => {
    if (!slice.length) return;
    const { result, cost: c, truncated, error } = await translateToLanguages(slice.map((it) => it.text), langs, opts);
    // ★에러를 버리지 않는다 — 예전엔 호출측이 error 를 안 읽어서 "0줄 채움" 만 남고
    //   왜 안 됐는지(키·거부·과부하·타임아웃)를 아무도 알 수 없었다.
    if (error && !errors.includes(error)) errors.push(error);
    cost += c;
    translated += apply(slice, result);
    // 아직 안 채워진 줄만 모아 재시도. 쪼개면 출력이 짧아져 잘림이 해소된다.
    const missing = slice.filter((it) => langs.some((l) => !(it.b.tracks?.[l]?.text)));
    if (!missing.length || depth >= 4) return;
    if (!truncated && missing.length === slice.length) return; // 진전이 전혀 없으면 무한재귀 방지
    const half = Math.max(1, Math.ceil(missing.length / 2));
    await run(missing.slice(0, half), depth + 1);
    await run(missing.slice(half), depth + 1);
  };

  for (let i = 0; i < items.length; i += CHUNK) await run(items.slice(i, i + CHUNK));
  // 한 줄도 못 채웠는데 이유도 없으면 그것 자체가 단서다(모델이 빈 응답 = 형식 불일치).
  if (translated === copied && !errors.length)
    errors.push("모델이 번역 결과를 돌려주지 않았습니다(빈 응답 또는 형식 불일치)");
  return { translated, cost, errors };
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
  const CHUNK = Number(process.env.TRANSLATE_KO_CHUNK || 25); // ★60 은 응답이 잘렸다(들쭉날쭉의 원인)
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
