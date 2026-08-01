// ============================================================================
// 번역 응답 파서 골든 테스트 — "번역을 몇 번을 돌려도 같은 줄이 안 채워진다" 재발 방지.
// ----------------------------------------------------------------------------
// 실제로 있었던 결함: salvageItems 가 괄호 균형으로 객체를 긁는데, 모델이 정상적으로
// 완결된 {"t":[{"i":0,"ja":"…"}]} 를 주면 '바깥 객체 하나' 만 잡혔다. 그 객체엔 i 가 없어
// 호출측 필터가 전부 버렸다 → 번역 0줄. 응답이 '잘렸을 때만' 동작하는 파서였다.
// 실행: node scripts/test-translate-parse.mjs
// ============================================================================
import { salvageItems } from "../worker/translate.mjs";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const ids = (arr) => arr.map((o) => o.i).join(",");

// 1) 정상 완결 응답(가장 흔한 경우 — 예전엔 여기서 0개였다)
const whole = '{"t":[{"i":0,"ja":"こんにちは"},{"i":1,"ja":"逃げろ"},{"i":2,"ja":"やめろ"}]}';
const a = salvageItems(whole);
check("완결된 {\"t\":[…]} 에서 항목 3개를 꺼낸다", a.length === 3, `${a.length}개(${ids(a)})`);
check("번역 값이 그대로 붙어 있다", a[1]?.ja === "逃げろ", JSON.stringify(a[1]));

// 2) 잘린 응답 — 앞부분은 살려야 한다(기존에 되던 동작, 회귀 금지)
const cut = '{"t":[{"i":0,"ja":"こんにちは"},{"i":1,"ja":"逃げろ"},{"i":2,"ja":"やめ';
const b = salvageItems(cut);
check("잘린 응답에서도 완결 항목 2개를 살린다", b.length === 2, `${b.length}개(${ids(b)})`);

// 3) 코드펜스·설명이 섞인 응답
const fenced = '설명입니다\n```json\n{"t":[{"i":0,"ja":"はい"}]}\n```';
const c = salvageItems(fenced);
check("코드펜스/설명이 섞여도 항목을 꺼낸다", c.length === 1 && c[0].ja === "はい", JSON.stringify(c));

// 4) 배열만 온 경우
const bare = '[{"i":0,"ja":"あ"},{"i":1,"ja":"い"}]';
const d = salvageItems(bare);
check("최상위가 배열이어도 꺼낸다", d.length === 2, `${d.length}개`);

// 5) 여러 언어 키
const multi = '{"t":[{"i":0,"ja":"はい","en":"yes"}]}';
const e = salvageItems(multi);
check("언어 키가 여러 개여도 항목 그대로", e.length === 1 && e[0].en === "yes", JSON.stringify(e));

// 6) 항목이 없는 응답은 빈 배열(오탐 금지)
check("번역 항목이 없으면 빈 배열", salvageItems('{"note":"없음"}').length === 0);

console.log(`\n결과: ${pass}/${pass + fail} 통과`);
process.exit(fail === 0 ? 0 : 1);
