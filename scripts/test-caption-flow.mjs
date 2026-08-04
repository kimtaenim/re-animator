// ============================================================================
// 흘려얹기 자막 골든 테스트 — "긴 대사(짧은 컷) 자막이 소리처럼 컷을 넘어 이어지는가".
// ----------------------------------------------------------------------------
// 사용자 보고: "자막 길이랑 영상 길이랑 잘 안 맞는다. 긴 대사인데 짧은 컷도 많고."
// 원인(확정): 자막을 세그먼트(-t finalDur) 안에만 구워서, 소리는 다음 컷 위로 흘러가는데
// 자막은 컷 끝에서 잘렸고, 앞 컷 소리에 밀린(delay) 자막은 컷 길이를 넘는 부분이 안 떴다.
// 규칙(확정): 자막 구간 = 그 줄 소리 구간(전역 시각). 각 세그먼트는 겹치는 부분만 이어 그린다.
//             그룹(섹션) 경계는 홀드가 소리를 그 안에서 끝내므로 자막도 경계를 안 넘는다.
// 실행: node scripts/test-caption-flow.mjs
// ============================================================================
process.env.UPSTASH_REDIS_REST_URL ||= "http://dummy";
process.env.UPSTASH_REDIS_REST_TOKEN ||= "dummy";
const { placeFlowAudio, segmentCapWindows } = await import("../worker/compose.mjs");

let pass = 0, fail = 0;
const eq = (a, b) => Math.abs(a - b) < 1e-6;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(` FAIL  ${name}${detail ? " — " + detail : ""}`); }
};
const mk = (vd, audioLen, order) => ({ vd, audioLen, holdSec: 0, s: { order }, start: 0, delay: 0 });
// 컷의 자막(소리와 같은 구간) → 전역 시각. compose 의 globalCaps 계산과 동일 수식.
const gcap = (pt, start, end, text) => ({ text, gStart: pt.start + pt.delay + start, gEnd: pt.start + pt.delay + end });

console.log("[1] 긴 대사(7s)·짧은 컷(3s) 3연속 — 자막이 소리를 따라 다음 컷으로 이어진다");
{
  const A = mk(3, 7, 0), B = mk(3, 2, 1), C = mk(3, 0, 2);
  const total = placeFlowAudio([A, B, C], new Set());
  check("배치: A 지연 0·B 지연 4·C 지연 3", eq(A.delay, 0) && eq(B.delay, 4) && eq(C.delay, 3));
  check("전체 길이 9(소리가 정확히 끝남 → 홀드 0)", eq(total, 9) && eq(C.holdSec, 0));
  const caps = [gcap(A, 0, 7, "A대사"), gcap(B, 0, 2, "B대사")];
  const segA = segmentCapWindows(caps, A.start, A.vd + A.holdSec);
  const segB = segmentCapWindows(caps, B.start, B.vd + B.holdSec);
  const segC = segmentCapWindows(caps, C.start, C.vd + C.holdSec);
  check("세그A: A자막 [0,3]", segA.length === 1 && eq(segA[0].start, 0) && eq(segA[0].end, 3));
  check("세그B: A자막이 이어짐 [0,3] (예전엔 여기서 사라졌다)", segB.length === 1 && segB[0].g.text === "A대사" && eq(segB[0].start, 0) && eq(segB[0].end, 3));
  check("세그C: A자막 꼬리 [0,1] + B자막 [1,3]",
    segC.length === 2 && eq(segC[0].start, 0) && eq(segC[0].end, 1) && segC[1].g.text === "B대사" && eq(segC[1].start, 1) && eq(segC[1].end, 3));
  const aCover = segA[0].end - segA[0].start + segB[0].end - segB[0].start + segC[0].end - segC[0].start;
  check("A자막 총 노출 = 소리 길이 7s(끊김 0)", eq(aCover, 7));
  check("A자막 끝 = B자막 시작(겹침 0)", eq(segC[0].end, segC[1].start));
}

console.log("[2] 섹션 경계 — 소리도 자막도 경계를 안 넘는다(직전 컷 홀드로 마무리)");
{
  const A = mk(2, 5, 0), B = mk(2, 1, 1);
  const total = placeFlowAudio([A, B], new Set([1]));
  check("A 홀드 3(5s 소리를 자기 그룹 안에서 끝냄)·전체 7", eq(A.holdSec, 3) && eq(total, 7));
  check("B 는 새 그룹 — 지연 0·시작 5", eq(B.delay, 0) && eq(B.start, 5));
  const caps = [gcap(A, 0, 5, "A대사")];
  const segA = segmentCapWindows(caps, A.start, A.vd + A.holdSec);
  const segB = segmentCapWindows(caps, B.start, B.vd + B.holdSec);
  check("세그A: A자막 [0,5](홀드 구간 포함)", segA.length === 1 && eq(segA[0].start, 0) && eq(segA[0].end, 5));
  check("세그B: A자막 없음(경계 안 넘음)", segB.length === 0);
}

console.log("[3] 마지막 꼬리 홀드 — 밀린 자막이 홀드 구간에서 끝까지 나온다");
{
  const A = mk(2, 4, 0), B = mk(2, 1, 1);
  const total = placeFlowAudio([A, B], new Set());
  check("B 지연 2·B 홀드 1·전체 5", eq(B.delay, 2) && eq(B.holdSec, 1) && eq(total, 5));
  const caps = [gcap(A, 0, 4, "A대사"), gcap(B, 0, 1, "B대사")];
  const segA = segmentCapWindows(caps, A.start, A.vd + A.holdSec);
  const segB = segmentCapWindows(caps, B.start, B.vd + B.holdSec);
  check("세그A: A자막 [0,2]", segA.length === 1 && eq(segA[0].end, 2));
  check("세그B: A자막 [0,2] + B자막 [2,3](홀드에서 완주)",
    segB.length === 2 && eq(segB[0].start, 0) && eq(segB[0].end, 2) && eq(segB[1].start, 2) && eq(segB[1].end, 3));
}

console.log("[4] 스침 방지 — 0.05s 미만으로 걸치는 자막은 그 세그먼트에 안 넣는다(깜빡임 방지)");
{
  const caps = [{ text: "x", gStart: 0, gEnd: 3.02 }, { text: "y", gStart: 5.98, gEnd: 8 }];
  const seg = segmentCapWindows(caps, 3, 3); // 세그 [3,6)
  check("양끝 스침 제외", seg.length === 0);
}

console.log("[5] 자막 없음 — 빈 입력은 빈 결과(회귀 0)");
{
  const A = mk(3, 0, 0);
  const total = placeFlowAudio([A], new Set());
  check("무대사 1컷: 전체 = 영상 길이", eq(total, 3));
  check("빈 자막", segmentCapWindows([], 0, 3).length === 0);
}

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
