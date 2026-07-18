// 실제 classify.mjs normalizeCut 을 실행 — 모델이 dialogueTranslation 을 돌려줬을 때
// 코드가 그걸 cut.dialogueTranslation 으로 '받아오는가'. (모델 능력 아님 — 수신 경로 검증)
import { normalizeCut } from "../worker/classify.mjs";

const R = {
  typeIdSet: new Set(["person", "action", "object", "background_crowd", "transition", "text"]),
  koToId: new Map(),
  textKindIdSet: new Set(["dialogue", "caption", "sfx"]),
  tkKoToId: new Map(),
};

// gpt-4o 가 strict 스키마로 돌려줄 법한 raw 컷(번역 채워져서 옴)
const raw = {
  n: 1, type: "person", textKind: "none",
  characters: ["기사"], setting: "전장", objects: [],
  dialogue: "别动，其实还无伤大雅嘛……",
  dialogueTranslation: "움직이지 마, 사실 이 정도는 아무것도 아니야……",
  sfx: "", description: "부상 입은 기사", promptDraft: "wounded knight",
};

const c = normalizeCut(raw, R);
let pass = 0, fail = 0;
const ok = (n, v) => (v ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)));

console.log("[classify 수신 경로] 모델이 번역을 돌려주면 코드가 받아오는가");
ok("type 파싱", c.type === "person");
ok("원문 dialogue 수신", c.dialogue === "别动，其实还无伤大雅嘛……");
ok("★번역 dialogueTranslation 수신", c.dialogueTranslation === "움직이지 마, 사실 이 정도는 아무것도 아니야……");
console.log("  받은 값:", JSON.stringify({ dialogue: c.dialogue, dialogueTranslation: c.dialogueTranslation }));

// 번역 안 온 경우(빈 값)도 안전한가
const c2 = normalizeCut({ ...raw, dialogueTranslation: "" }, R);
ok("빈 번역이면 undefined/빈", !c2.dialogueTranslation);

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
