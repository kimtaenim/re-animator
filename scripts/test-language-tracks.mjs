// ============================================================================
// 언어판(§10) 규칙 골든 테스트 — "일본어판인데 중국어 소리·중국어 자막" 재발 방지.
// ----------------------------------------------------------------------------
// 이 규칙이 몇 번이나 되돌아가 납품을 막았다:
//   · 일본어판 합성인데 그 줄에 일본어 음성이 없으면 원어(중국어) 음성을 대신 넣었다.
//   · 자막도 따라서 원문(중국어)이 나갔다.
// 규칙(확정):
//   1) 그 언어 음성이 있으면 그 음성 + 그 언어 자막.
//   2) 번역만 있고 음성이 없으면 → 무음 + 그 언어 자막(원어 소리 금지).
//   3) 번역도 음성도 없으면 → 그 줄은 언어판에 넣지 않는다(원문 유출 금지).
//   4) 효과음(__sfx__)은 언어 무관 — 그대로 사용.
//   5) 원어판(lang="")은 예전 그대로(회귀 0).
// 실행: node scripts/test-language-tracks.mjs
// ============================================================================
// compose.mjs 는 store.mjs(Redis) 를 물고 온다 — 키 없이도 돌게 더미 값을 넣고 동적 import.
process.env.UPSTASH_REDIS_REST_URL ||= "http://dummy";
process.env.UPSTASH_REDIS_REST_TOKEN ||= "dummy";
const { audioUnits } = await import("../worker/compose.mjs");

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  OK   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const cut = {
  bubbles: [
    // 1) 일본어 음성 있음
    { text: "你好", audioUrl: "https://x/zh-1.mp3", tracks: { ja: { text: "こんにちは", audioUrl: "https://x/ja-1.mp3" } } },
    // 2) 일본어 번역만 있고 음성 없음
    { text: "快跑", audioUrl: "https://x/zh-2.mp3", tracks: { ja: { text: "逃げろ" } } },
    // 3) 일본어 번역도 음성도 없음
    { text: "住手", audioUrl: "https://x/zh-3.mp3", tracks: {} },
    // 4) 효과음(언어 무관)
    { text: "쾅", speakerId: "__sfx__", audioUrl: "https://x/sfx.mp3" },
  ],
};

console.log("언어판(ja) 규칙:");
const ja = audioUnits(structuredClone(cut), "ja");
const urls = ja.map((u) => u.audioUrl || "(무음)");
const texts = ja.map((u) => u.subText);

check("원어(중국어) 음성이 하나도 섞이지 않는다", !urls.some((u) => String(u).includes("/zh-")), urls.join(","));
check("일본어 음성이 있는 줄은 그 음성을 쓴다", urls.includes("https://x/ja-1.mp3"));
check("일본어 자막이 나간다", texts.includes("こんにちは"));
check("번역만 있는 줄은 무음 + 일본어 자막", ja.some((u) => u.silent && u.subText === "逃げろ"));
check("번역 없는 줄은 원문(住手)으로 새어나가지 않는다", !texts.includes("住手"));
check("효과음은 언어 무관하게 유지", urls.includes("https://x/sfx.mp3"));

console.log("원어판(lang=\"\") 회귀:");
const src = audioUnits(structuredClone(cut), "");
const srcUrls = src.map((u) => u.audioUrl);
check("원어 음성 3줄 + 효과음 그대로", srcUrls.length === 4 && srcUrls.every((u) => !!u), srcUrls.join(","));
check("원어 자막(원문)이 나간다", src.map((u) => u.subText).includes("你好"));
check("원어판엔 무음 유닛이 없다", !src.some((u) => u.silent));

console.log(`\n결과: ${pass}/${pass + fail} 통과`);
process.exit(fail === 0 ? 0 : 1);
