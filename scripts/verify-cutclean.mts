// 실제 lib/cutClean.ts 의 cleanBubbles 를 실행 검증 — 저장 정리가 번역을 버리는지.
import { cleanBubbles } from "../lib/cutClean";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => (c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)));

// 편집 저장 시 UI가 보내는 모양(번역·화자·감정·자막위치 포함)
const input = [
  { text: "你怎么在这里？", translation: "네가 왜 여기 있어?", speakerId: "char_1", emotion: "shock", subtitleY: 0.7 },
  { text: "住手！", translation: "멈춰!", speakerId: null }, // 내레이터(null)
  { text: "no-translation line", speakerId: "char_2" },       // 번역 없는 줄
  { text: "bad-translation", translation: 12345 },            // 잘못된 타입 → 무시
];
const out = cleanBubbles(input);

console.log("[저장 정리(cleanBubbles) 실행 결과]");
ok("풍선 개수 유지(4)", out.length === 4);
ok("번역 보존 [0]", out[0].translation === "네가 왜 여기 있어?");
ok("원문 보존 [0]", out[0].text === "你怎么在这里？");
ok("화자 보존 [0]", out[0].speakerId === "char_1");
ok("감정 보존 [0]", out[0].emotion === "shock");
ok("자막위치 보존 [0]", out[0].subtitleY === 0.7);
ok("내레이터(null) 보존 [1]", out[1].speakerId === null && out[1].translation === "멈춰!");
ok("번역 없는 줄은 undefined [2]", out[2].translation === undefined);
ok("잘못된 타입 번역 무시 [3]", out[3].translation === undefined);
console.log("  예시 [0]:", JSON.stringify(out[0]));

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
