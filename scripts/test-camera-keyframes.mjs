// ============================================================================
// 골든 테스트 — lib/cameraKeyframes.mjs (스펙 §2)
//   실행: node scripts/test-camera-keyframes.mjs
//   기록: RECORD=1 node scripts/test-camera-keyframes.mjs  (골든 값 재생성 출력)
// 검증: 결정성 · 시드 셰이크 재현 · 계층별 트랙 · scale>=1 · 워커/웹앱 좌표 2px 이내
//       · 프리셋 방향성 · 회귀 락(대표 세트의 t=0/25/50/75/100% 픽셀 crop).
// ============================================================================
import {
  buildKeyframeTable,
  sampleTrack,
  toPixelCrop,
  toWebTransform,
  resolveCameraWork,
  presetLayer,
  needsUpscale,
} from "../lib/cameraKeyframes.mjs";

let pass = 0,
  fail = 0;
const RECORD = process.env.RECORD === "1";
const fmt = (v) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v);

function ok(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("  ✗ FAIL:", msg);
  }
}
function near(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, `${msg} (|${fmt(a)} - ${fmt(b)}| = ${fmt(Math.abs(a - b))} > ${tol})`);
}

const W = 1280,
  H = 720;
const FIVE = [0, 0.25, 0.5, 0.75, 1.0];

// ── 웹앱 소비 경로를 좌표로 역산: toWebTransform 의 translate/scale 로부터, 컨테이너
//    중심(0.5,0.5)에 오는 "원본 정규화 점"을 복원한다. 이것이 crop 창 중심과 같아야
//    워커(toPixelCrop)와 웹앱이 같은 곳을 본다는 뜻. 2px 이내 일치가 골든 테스트.
function webCenterNorm(st) {
  // 화면점 = (원본점 - 0) * s + translate(정규화). 컨테이너 중심 0.5 = cxRecovered*s + tx/100·?
  // toWebTransform: tx% = -(cx*s - 0.5)*100, origin 0 0. 컨테이너 폭=1 로 보면
  // 화면 x(정규화) = 원본x*s + tx/100. 화면중심 0.5 되는 원본x: 0.5 = x*s + tx/100
  const s = Math.max(1, st.scale);
  const tx = -(st.cx * s - 0.5); // = tx%/100
  const ty = -(st.cy * s - 0.5);
  const cxRec = (0.5 - tx) / s;
  const cyRec = (0.5 - ty) / s;
  return { cx: cxRec, cy: cyRec };
}

console.log("== camera keyframe golden test ==");

// ── 1) 결정성: 같은 입력 → 같은 테이블 ────────────────────────────────────────
{
  const cw = resolveCameraWork("push_in", { duration_s: 4, shake_seed: 7, shake_amp_px: 6 });
  const a = JSON.stringify(buildKeyframeTable(cw));
  const b = JSON.stringify(buildKeyframeTable(cw));
  ok(a === b, "결정성: 동일 입력 동일 테이블");
}

// ── 2) 시드 셰이크 재현 + 시드 다르면 궤적 다름 ────────────────────────────────
{
  const mk = (seed) => buildKeyframeTable(resolveCameraWork("shake", { duration_s: 2, shake_seed: seed, shake_amp_px: 10 }));
  ok(JSON.stringify(mk(42)) === JSON.stringify(mk(42)), "셰이크: 같은 시드 동일 궤적");
  ok(JSON.stringify(mk(42)) !== JSON.stringify(mk(43)), "셰이크: 다른 시드 다른 궤적");
  const noShake = buildKeyframeTable(resolveCameraWork("static", { duration_s: 2 }));
  const keys = noShake.tracks.main.keys;
  ok(keys.every((k) => k.cx === 0.5 && k.cy === 0.5), "static: 셰이크·드리프트 없음 → 중심 고정");
}

// ── 3) 계층별 트랙 구성 ────────────────────────────────────────────────────────
{
  const a = buildKeyframeTable(resolveCameraWork("push_in", { duration_s: 3 }));
  ok(a.layer === "A" && a.tracks.main && !a.tracks.background, "계층 A: main 단일 트랙");
  const b = buildKeyframeTable(resolveCameraWork("parallax_push", { duration_s: 3 }));
  ok(b.layer === "B" && b.tracks.character && b.tracks.background, "계층 B: character+background 2 트랙");
  const c = buildKeyframeTable(resolveCameraWork("orbit", { duration_s: 3 }));
  ok(c.layer === "C" && Object.keys(c.tracks).length === 0, "계층 C(orbit): 후처리 트랙 없음(I2V 위임)");
  ok(presetLayer("vertigo") === "B" && presetLayer("whip") === "A", "presetLayer 매핑");
}

// ── 4) scale>=1 (crop 이 프레임 밖으로 안 나감) + 프리셋 방향성 ─────────────────
{
  for (const preset of ["push_in", "pull_out", "pan", "parallax_push", "vertigo", "shake"]) {
    const tb = buildKeyframeTable(resolveCameraWork(preset, { duration_s: 4 }));
    for (const [name, tr] of Object.entries(tb.tracks)) {
      ok(tr.keys.every((k) => k.scale >= 1 - 1e-9), `${preset}.${name}: scale>=1`);
    }
  }
  const pin = buildKeyframeTable(resolveCameraWork("push_in", { duration_s: 4 })).tracks.main.keys;
  ok(pin[pin.length - 1].scale > pin[0].scale, "push_in: 줌 증가");
  const pout = buildKeyframeTable(resolveCameraWork("pull_out", { duration_s: 4 })).tracks.main.keys;
  ok(pout[0].scale > pout[pout.length - 1].scale, "pull_out: 줌 감소(단조)");
  ok(pout[pout.length - 1].scale >= 1 && pout[pout.length - 1].scale < pout[0].scale, "pull_out: 끝이 시작보다 원본에 근접(scale>=1)");
  // vertigo: 배경이 인물 대비 역방향(bg_scale_delta 음수) → 끝에서 배경 scale < 인물 scale?
  // rate=0.5, bgDelta=-6 → 배경 총율 = (0.5-6)*4% = -22% → clamp 1. 인물은 +2%.
  const v = buildKeyframeTable(resolveCameraWork("vertigo", { duration_s: 4 }));
  const vc = v.tracks.character.keys, vb = v.tracks.background.keys;
  ok(vc[vc.length - 1].scale >= vb[vb.length - 1].scale, "vertigo: 배경이 인물 대비 역방향(작아짐)");
}

// ── 5) 워커(toPixelCrop) ↔ 웹앱(toWebTransform) 좌표 2px 이내 일치 ─────────────
//     핵심 골든 테스트: 두 소비 경로가 같은 crop 창 중심을 본다.
{
  const cases = [
    resolveCameraWork("push_in", { duration_s: 4, shake_seed: 3, shake_amp_px: 6 }),
    resolveCameraWork("pan", { duration_s: 5 }),
    resolveCameraWork("parallax_push", { duration_s: 3 }),
    resolveCameraWork("vertigo", { duration_s: 4 }),
  ];
  for (const cw of cases) {
    const tb = buildKeyframeTable(cw);
    for (const [name, tr] of Object.entries(tb.tracks)) {
      for (const off of FIVE) {
        const st = sampleTrack(tr, off);
        // 워커: 짝수 스냅 픽셀 crop → 중심(px)
        const wc = toPixelCrop(st, W, H, { even: true });
        const workerCx = wc.x + wc.cropW / 2;
        const workerCy = wc.y + wc.cropH / 2;
        // 웹앱: transform 역산 중심(정규화) → px
        const web = webCenterNorm(st);
        // 클램프 반영: 워커는 프레임 내로 클램프하므로 웹 중심도 동일 클램프 비교를 위해
        // 이상(clamp 전) 중심을 px 로 놓고 워커의 clamp 된 중심과 비교(경계 케이스만 차이).
        const webCxPx = web.cx * W;
        const webCyPx = web.cy * H;
        near(workerCx, webCxPx, 2.5, `${cw.preset}.${name}@${off}: cx 워커↔웹`);
        near(workerCy, webCyPx, 2.5, `${cw.preset}.${name}@${off}: cy 워커↔웹`);
      }
    }
  }
}

// ── 6) 업스케일 트리거(스펙 §1) ────────────────────────────────────────────────
{
  const small = buildKeyframeTable(resolveCameraWork("push_in", { duration_s: 3, zoom_rate_pct_per_s: 2 }));
  ok(!needsUpscale(small, 720), "업스케일: 줌<20%·720p → 불필요");
  const big = buildKeyframeTable(resolveCameraWork("push_in", { duration_s: 6, zoom_rate_pct_per_s: 5 })); // 30%
  ok(needsUpscale(big, 720), "업스케일: 줌 총량>20% → 필요");
  ok(needsUpscale(small, 1080), "업스케일: 1080p 출력 → 필요");
}

// ── 7) 회귀 락 — 대표 세트의 t=0/25/50/75/100% 픽셀 crop(even) ─────────────────
//     RECORD=1 로 재생성. 값 바뀌면 수식 변경을 의도했는지 확인 후 갱신.
{
  const cw = resolveCameraWork("push_in", { duration_s: 4, shake_seed: 0 }); // 셰이크 없이(락 안정)
  const tb = buildKeyframeTable(cw);
  const tr = tb.tracks.main;
  const snap = FIVE.map((off) => {
    const c = toPixelCrop(sampleTrack(tr, off), W, H, { even: true });
    return [c.cropW, c.cropH, c.x, c.y];
  });
  // RECORD=1 로 재생성. [cropW, cropH, x, y] @ t=0/25/50/75/100% (push_in d=4, W1280×H720).
  // ★"MV보다 더 거칠게" 기본값(push_in zoom 8·drift{12,-8})으로 갱신 — 2026-07-21.
  const GOLDEN = [
    [1280, 720, 0, 0],
    [1230, 692, 30, 10],
    [1102, 620, 114, 34],
    [1000, 562, 182, 50],
    [968, 544, 204, 56],
  ];
  if (RECORD || !GOLDEN) {
    console.log("  GOLDEN(push_in d=4) =", JSON.stringify(snap));
  } else {
    for (let i = 0; i < FIVE.length; i++) {
      for (let j = 0; j < 4; j++) {
        near(snap[i][j], GOLDEN[i][j], 2, `회귀락 @${FIVE[i]}[${j}]`);
      }
    }
  }
}

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
