// 살아있는 gpt-4o가 우리 지시로 실제 한국어 번역을 채우는지 딱 한 번 확인(≈1센트).
// 풀 프로젝트 재분할 없이 검증용. 실행: `node scripts/probe-live-translation.mjs`
// 키는 .env.local 의 OPENAI_API_KEY 를 읽음(없으면 환경변수).
import { readFileSync } from "node:fs";

function readKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const m = env.match(/^\s*OPENAI_API_KEY\s*=\s*(.+)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, "").trim();
  } catch {}
  return null;
}

const key = readKey();
if (!key) {
  console.error("OPENAI_API_KEY 를 .env.local 이나 환경변수에 넣어주세요. (프로브만 하고 저장 안 함)");
  process.exit(2);
}

const model = process.env.OPENAI_VLM_MODEL || "gpt-4o";
// classify 와 동일한 번역 지시 + strict 스키마(dialogueTranslation 필수)로 텍스트만 테스트.
const samples = ["别动，其实还无伤大雅嘛……", "我会让你亲眼见证你所谓的胜利", "诸德将军！诺德将军心脏破碎，已经魂归上天了！"];
const schema = {
  name: "probe",
  strict: true,
  schema: {
    type: "object", additionalProperties: false,
    properties: { rows: { type: "array", items: {
      type: "object", additionalProperties: false,
      properties: { dialogue: { type: "string" }, dialogueTranslation: { type: "string" } },
      required: ["dialogue", "dialogueTranslation"],
    } } },
    required: ["rows"],
  },
};
const prompt =
  "다음 만화 대사들을 그대로 dialogue 에 넣고, dialogueTranslation 에 자연스러운 한국어 번역을 넣어라(화자 말투 반영, 밋밋한 직역 금지). 오직 JSON.\n" +
  samples.map((s, i) => `${i + 1}. ${s}`).join("\n");

const r = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({ model, temperature: 0, max_tokens: 1000, response_format: { type: "json_schema", json_schema: schema }, messages: [{ role: "user", content: prompt }] }),
});
if (!r.ok) { console.error("OpenAI 오류", r.status, (await r.text()).slice(0, 300)); process.exit(1); }
const d = await r.json();
const out = JSON.parse(d.choices?.[0]?.message?.content ?? "{}");
console.log(`모델=${model} · finish=${d.choices?.[0]?.finish_reason}\n`);
let ok = 0;
for (const row of out.rows ?? []) {
  const has = (row.dialogueTranslation || "").trim().length > 0;
  if (has) ok++;
  console.log(`  ${has ? "✅" : "❌"} ${row.dialogue}\n     역: ${row.dialogueTranslation || "(빈값!)"}`);
}
console.log(`\n번역 채워진 줄: ${ok}/${(out.rows ?? []).length}`);
process.exit(ok === samples.length ? 0 : 1);
