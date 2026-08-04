// ============================================================================
// TTS 줄 단위 언어 보정 골든 테스트 — "일본어판 중간의 영어 대사 줄이 무음" 재발 방지.
// ----------------------------------------------------------------------------
// 사용자 보고: 일본어 더빙 중간에 영어로 말하는 부분이 소리가 아예 안 들어감.
// 원인: 작업 언어(jpn)를 전 줄에 강제 → 영어 텍스트 줄이 TTS 에서 실패(그 줄만 무음으로 남음).
// 규칙(확정):
//   1) 가나가 있으면 ja(영단어 섞여도 일본어 문장).
//   2) CJK·한글 없이 라틴 문자뿐이면 en(영어 대사 줄).
//   3) 한글 우세면 ko.
//   4) 한자만(ja 한자 표기/zh 모호)·기호뿐이면 주어진 언어 유지.
//   5) ★원어판(lang="")은 절대 손대지 않는다(회귀 0).
// 실행: node scripts/test-tts-lang.mjs
// ============================================================================
import { effectiveTtsLang } from "../worker/tts.mjs";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (got === want) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(` FAIL  ${name} — got "${got}", want "${want}"`); }
};

console.log("[일본어판(ja) 안의 줄들]");
check("일본어 문장 → ja", effectiveTtsLang("やめて！どうしてここに？", "ja"), "ja");
check("★영어 대사 줄 → en (예전엔 jpn 강제로 무음)", effectiveTtsLang("OK! Let's go, right now!", "ja"), "en");
check("가나+영단어 혼합 → ja", effectiveTtsLang("OKだ、行くぞ！", "ja"), "ja");
check("한자만(일본어 한자 표기) → ja 유지", effectiveTtsLang("了解。", "ja"), "ja");
check("기호·숫자뿐 → ja 유지", effectiveTtsLang("…!? 119", "ja"), "ja");
check("한글 줄 → ko", effectiveTtsLang("살려줘!", "ja"), "ko");

console.log("[영어판(en) 안의 줄들]");
check("영어 문장 → en", effectiveTtsLang("Stop right there.", "en"), "en");
check("가나 섞임 → ja", effectiveTtsLang("やめて!", "en"), "ja");
check("한자만 → en 유지(모호)", effectiveTtsLang("了解", "en"), "en");

console.log("[원어판(lang=\"\") — 기존 동작 유지(회귀 0)]");
check("중국어 원문 → \"\" 그대로", effectiveTtsLang("你怎么在这里？", ""), "");
check("영어 원문도 → \"\" 그대로(원어판은 보정 안 함)", effectiveTtsLang("OK! Let's go!", ""), "");
check("빈 텍스트 → \"\" 그대로", effectiveTtsLang("", ""), "");

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
