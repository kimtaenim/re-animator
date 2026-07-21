// ============================================================================
// 시퀀스 자동 나누기 — 컷들을 '서사 시퀀스'로 묶어 섹션 경계(시작 컷 인덱스)를 제안.
// ----------------------------------------------------------------------------
// 텍스트만(type/setting/description/dialogue) Claude 에 주고 경계를 받는다(이미지 없음=저렴·빠름).
// ★워커 자기완결(../lib import 금지) + 타임아웃 90초(단일 스레드 매달림 방지, translate 와 동일 규약).
// ============================================================================

const MODEL = process.env.CLAUDE_SEQUENCE_MODEL || process.env.CLAUDE_TRANSLATE_MODEL || "claude-haiku-4-5";

let _client = null;
async function getClient() {
  if (_client !== null) return _client;
  if (!process.env.ANTHROPIC_API_KEY) return (_client = false);
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return (_client = new Anthropic({ timeout: 90_000, maxRetries: 1 }));
}

// items: [{ i, type, setting, desc }] (순서=이야기 순서). targetCount(선택)=대략 몇 시퀀스.
// 반환: { starts: number[](새 시퀀스 시작 컷 인덱스, 0 포함 오름차순), cost, error? }. 실패 시 starts=[].
export async function groupIntoSequences(items, targetCount) {
  const client = await getClient();
  if (!client) return { starts: [], cost: 0, error: "ANTHROPIC_API_KEY 없음(워커 env)" };
  const n = items.length;
  if (n < 2) return { starts: [], cost: 0 };
  const lines = items
    .map((it) => `${it.i}: [${it.type || "?"}] ${it.setting || ""}${it.desc ? " — " + it.desc : ""}`.slice(0, 160))
    .join("\n");
  const aim = targetCount && targetCount > 1 ? `대략 ${targetCount}개 안팎의 ` : "";
  const prompt =
    "다음은 웹툰 한 회분의 컷들이다(위→아래 = 이야기 순서). 각 줄은 '컷번호: [타입] 배경 — 설명'.\n" +
    `이 컷들을 ${aim}자연스러운 서사 시퀀스(장소·시간·상황·이야기 흐름이 바뀌는 단위)로 묶어라. ` +
    "각 시퀀스가 '시작하는 컷 번호'만 골라라(첫 시퀀스는 0에서 시작). 한 시퀀스가 너무 잘게 쪼개지지 않게, " +
    "장면/장소가 실제로 바뀌는 지점에서만 나눠라.\n" +
    `오직 JSON 으로만: {"starts":[0, ...]} (오름차순, 0 포함, 컷번호는 0~${n - 1}).\n\n` +
    lines;
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });
    if (res.stop_reason === "refusal") return { starts: [], cost: 0, error: "거부(refusal)" };
    let raw = res.content?.find((b) => b.type === "text")?.text ?? "{}";
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) raw = m[0];
    const parsed = JSON.parse(raw);
    const starts = Array.isArray(parsed.starts)
      ? [...new Set(parsed.starts.filter((x) => Number.isInteger(x) && x >= 0 && x < n))].sort((a, b) => a - b)
      : [];
    const u = res.usage || {};
    const cost = ((u.input_tokens || 0) * 1 + (u.output_tokens || 0) * 5) / 1e6; // haiku $1/$5
    return { starts, cost };
  } catch (e) {
    return { starts: [], cost: 0, error: String(e?.message ?? e).slice(0, 200) };
  }
}
