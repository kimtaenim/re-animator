// 실제 worker/translate.mjs 의 Claude 번역(translateTexts)을 직접 호출해 결과를 찍는다.
// .env.local 의 ANTHROPIC_API_KEY 를 읽음(채팅에 붙이지 말 것). 실행: node scripts/probe-claude-translate.mjs
import { readFileSync } from "node:fs";

if (!process.env.ANTHROPIC_API_KEY) {
  try {
    const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const m = env.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+)\s*$/m);
    if (m) process.env.ANTHROPIC_API_KEY = m[1].replace(/^["']|["']$/g, "").trim();
  } catch {}
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY 가 .env.local 에 없습니다. 한 줄 추가 후 다시 실행하세요.");
  process.exit(2);
}

const { translateTexts } = await import("../worker/translate.mjs");
const samples = [
  "别动，其实还无伤大雅嘛……",
  "如何，你会满意自己的这个结局吗?",
  "被诅咒的东西就得有被诅咒的样子",
  "이미 한국어인 줄",       // 스킵돼야 함
];
const { translations, cost } = await translateTexts(samples);
console.log(`Claude 번역 결과 (~$${cost.toFixed(4)}):\n`);
let ok = 0;
samples.forEach((s, i) => {
  const t = translations[i];
  const mark = i === 3 ? (t === null ? "✅(한국어=스킵)" : "❌") : t ? "✅" : "❌";
  if ((i === 3 && t === null) || (i !== 3 && t)) ok++;
  console.log(`  ${mark} ${s}\n       → ${t ?? "(스킵/실패)"}`);
});
console.log(`\n번역 성공 ${ok}/${samples.length}`);
process.exit(ok === samples.length ? 0 : 1);
