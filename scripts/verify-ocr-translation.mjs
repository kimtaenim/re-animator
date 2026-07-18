// 실제 worker/ocr.mjs readCutText 실행 검증 — 모델 응답만 모의. `node scripts/verify-ocr-translation.mjs`
import { readCutText } from "../worker/ocr.mjs";

const bubbles12 = Array.from({ length: 12 }, (_, i) => ({
  text: `第${i + 1}句中文台词，内容比较长用来测试截断风险`,
  translation: `${i + 1}번째 중국어 대사 — 화자 말투를 살린 한국어 번역(길게 넣어 잘림 위험 확인)`,
  left: 0.1, top: 0.1 + i * 0.05, right: 0.9, bottom: 0.15 + i * 0.05,
}));
const mockFetch = (finish_reason) => async () => ({
  ok: true,
  text: async () => "",
  json: async () => ({
    choices: [{ finish_reason, message: { content: JSON.stringify({ bubbles: bubbles12, sfx: "쾅", boxes: [] }) } }],
    usage: { prompt_tokens: 2000, completion_tokens: 1200 },
  }),
});
const png = Buffer.from("not-a-real-png");
let pass = 0, fail = 0;
const ok = (n, c) => (c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)));

console.log("[1] 정상 응답(12풍선) — 번역이 풍선마다 실리는가");
globalThis.fetch = mockFetch("stop");
const r = await readCutText(png, "dummy", "gpt-4o");
ok("풍선 12개", r.bubbles.length === 12);
ok("모든 풍선 translation 존재", r.bubbles.every((b) => (b.translation || "").trim()));
ok("원문 보존", r.bubbles.every((b) => b.text.includes("中文台词")));

console.log("[2] 응답 잘림 — 조용히 넘기지 않고 에러");
globalThis.fetch = mockFetch("length");
try { await readCutText(png, "dummy", "gpt-4o"); ok("잘림 throw", false); }
catch (e) { ok("잘림 throw", /잘림|max_tokens/.test(e.message)); }

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
