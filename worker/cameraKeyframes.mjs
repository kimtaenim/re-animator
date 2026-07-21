// ============================================================================
// re-animator — 카메라워크 수식 모듈 (스펙 §2)
// ★★ 이 파일은 lib/cameraKeyframes.mjs 의 **워커 로컬 복사본**이다. 논리적 단일 소스는
//    lib/(골든 테스트가 그걸 검증). Render 워커는 rootDir=worker 라 워커 밖(../lib)을
//    import 하면 로드가 깨져 모든 잡이 죽는다 → 워커는 이 로컬 복사본만 쓴다. 수식을
//    고칠 땐 lib/ 를 고치고 이 파일에 그대로 복사(cp lib/cameraKeyframes.mjs worker/).
// ----------------------------------------------------------------------------
// 순수 ESM · 무의존(no sharp/ffmpeg/DOM). 워커(.mjs)와 웹앱(.ts, allowJs)이
// **이 파일 하나만** 임포트해 소비한다. 수식을 두 벌 구현하지 않기 위함.
//   - 워커: import { buildKeyframeTable, sampleTrack, toPixelCrop } from "../lib/cameraKeyframes.mjs"
//   - 웹앱: import { buildKeyframeTable, toWebTransform } from "@/lib/cameraKeyframes.mjs"
//
// 좌표 모델
//   카메라는 (출력 비율로 conform 된) 원본 프레임 위의 "crop 창"이다. 창 상태 =
//   { scale>=1, cx, cy }. scale=줌 배율(1=원본, 2=2배 확대). 보이는 창 크기 =
//   프레임의 1/scale (가로·세로 동일 배율). cx,cy = 창 중심(정규화 0~1).
//   테이블은 **해상도 독립(정규화)**. 각 소비자가 자기 (W,H)로 픽셀 매핑.
//
// 계층(스펙 §2)
//   A: 단일 track "main" (push_in/pull_out/pan/static/shake/crash_zoom/whip)
//   B: 2 track "character"+"background" (parallax_push/vertigo — 배경만 더/역방향 스케일)
//   C: I2V 위임(orbit) — 여기선 후처리 없음(빈 테이블). 프롬프트 경로에서 처리.
// ============================================================================

/**
 * @typedef {{ x: number, y: number }} Vec2
 * @typedef {"linear"|"easeIn"|"easeOut"|"easeInOut"} Easing
 * @typedef {"push_in"|"pull_out"|"pan"|"static"|"shake"|"crash_zoom"|"whip"|"parallax_push"|"vertigo"|"orbit"} CameraPreset
 *
 * @typedef {Object} CameraWork  스펙 §2 camera_work 스키마
 * @property {CameraPreset} preset
 * @property {number} [zoom_rate_pct_per_s]      줌 속도(%/s). 양수=밀어들어감(push), 음수=빠짐(pull)
 * @property {Vec2} [drift_px_per_s]             팬 드리프트(px/s, refWidth/refHeight 기준)
 * @property {number} [bg_scale_delta_pct_per_s] 계층 B: 배경이 인물 대비 추가로 받는 스케일 속도(%p/s)
 * @property {Easing} [easing]                   시간 진행 가감속(기본 easeInOut)
 * @property {number} duration_s                 씬 길이(초)
 * @property {number} [shake_seed]               셰이크 시드(양쪽 동일 궤적). 0/undefined = 셰이크 없음
 * @property {number} [shake_amp_px]             셰이크 진폭(px, ref 기준). 기본 0
 * @property {number} [shake_damp]               셰이크 감쇠(1/s, exp(-damp*t)). 0=감쇠 없음(등진폭)
 * @property {number} [start_zoom]               시작 줌 배율(기본 1.0). pull_out 은 >1 로 시작
 *
 * @typedef {Object} CameraState  한 시점의 crop 창 상태(정규화)
 * @property {number} scale  줌 배율(>=1)
 * @property {number} cx     창 중심 x(0~1)
 * @property {number} cy     창 중심 y(0~1)
 *
 * @typedef {Object} Keyframe
 * @property {number} t       시각(초)
 * @property {number} off     정규화 진행(0~1) — Web Animations offset
 * @property {number} scale
 * @property {number} cx
 * @property {number} cy
 *
 * @typedef {Object} KeyframeTrack
 * @property {Keyframe[]} keys
 *
 * @typedef {Object} KeyframeTable
 * @property {number} version
 * @property {CameraPreset} preset
 * @property {number} duration_s
 * @property {number} fps
 * @property {number} frames         키 개수(= round(duration*fps)+1)
 * @property {"A"|"B"|"C"} layer
 * @property {number} refWidth
 * @property {number} refHeight
 * @property {Record<string, KeyframeTrack>} tracks  A:{main} B:{character,background} C:{}
 * @property {number} maxScale       테이블 내 최대 줌(업스케일 트리거 판단용)
 */

export const CAM_TABLE_VERSION = 1;

const REF_W = 1280;
const REF_H = 720;
const DEFAULT_FPS = 24;

// 계층 판정: preset → "A" | "B" | "C"
export const LAYER_B_PRESETS = new Set(["parallax_push", "vertigo"]);
export const LAYER_C_PRESETS = new Set(["orbit"]);
/** @param {CameraPreset} preset @returns {"A"|"B"|"C"} */
export function presetLayer(preset) {
  if (LAYER_C_PRESETS.has(preset)) return "C";
  if (LAYER_B_PRESETS.has(preset)) return "B";
  return "A";
}

// ── 시드 PRNG (mulberry32) — 워커·웹앱 동일 궤적 재현 ─────────────────────────
/** @param {number} seed @returns {() => number} 0~1 난수 */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── easing ───────────────────────────────────────────────────────────────────
/** @param {Easing} e @param {number} x 0~1 @returns {number} 0~1 */
export function ease(e, x) {
  const u = x < 0 ? 0 : x > 1 ? 1 : x;
  switch (e) {
    case "linear":
      return u;
    case "easeIn":
      return u * u;
    case "easeOut":
      return 1 - (1 - u) * (1 - u);
    case "easeInOut":
    default:
      return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// crop 창 중심을 scale 에서 프레임 내로 제한(창 반폭=0.5/scale). scale=1 → 중앙 고정.
/** @param {number} cx @param {number} cy @param {number} scale @returns {[number, number]} */
function clampCenter(cx, cy, scale) {
  const s = Math.max(1, scale);
  const half = 0.5 / s;
  return [clamp(cx, half, 1 - half), clamp(cy, half, 1 - half)];
}

// 오버스캔 한도(스펙 §1): 720p 작업 캔버스 = 120% 오버스캔 → 업스케일 없이 줌 상한 1.2배.
// 이를 넘으면 워커가 업스케일 패스로 해결(테이블은 그대로, maxScale 로 트리거만 노출).
export const OVERSCAN_ZOOM = 1.2;

/**
 * CameraWork → 정규화 키프레임 테이블. 순수 함수(결정적).
 * @param {CameraWork} cw
 * @param {{ fps?: number, refWidth?: number, refHeight?: number }} [opts]
 * @returns {KeyframeTable}
 */
export function buildKeyframeTable(cw, opts = {}) {
  const fps = opts.fps ?? DEFAULT_FPS;
  const refW = opts.refWidth ?? REF_W;
  const refH = opts.refHeight ?? REF_H;
  const preset = cw.preset;
  const layer = presetLayer(preset);
  const dur = Math.max(0.001, Number(cw.duration_s) || 0);
  const easing = cw.easing ?? "easeInOut";
  const frames = Math.max(1, Math.round(dur * fps)) + 1;

  /** @type {Record<string, KeyframeTrack>} */
  const tracks = {};
  let maxScale = 1;

  // 계층 C(orbit): 후처리 카메라 없음 — 빈 테이블(프롬프트 경로가 담당).
  if (layer === "C") {
    return {
      version: CAM_TABLE_VERSION, preset, duration_s: dur, fps, frames,
      layer, refWidth: refW, refHeight: refH, tracks: {}, maxScale: 1,
    };
  }

  // 줌 궤적: start → end. rate(%/s) × dur = 총 변화율.
  const startZoom = Math.max(1, Number(cw.start_zoom) || 1);
  const rate = Number(cw.zoom_rate_pct_per_s) || 0;
  let endZoom = startZoom * (1 + (rate / 100) * dur);
  endZoom = Math.max(1, endZoom); // crop 이 프레임을 벗어날 수 없음(scale>=1)

  // 드리프트(총 이동량, 정규화). px/s → ref 기준 정규화 후 dur 곱.
  const drift = cw.drift_px_per_s ?? { x: 0, y: 0 };
  const driftTotX = ((Number(drift.x) || 0) * dur) / refW;
  const driftTotY = ((Number(drift.y) || 0) * dur) / refH;

  // 셰이크: 시드 PRNG. amp(px) → 정규화. per-frame 지터(감쇠 옵션).
  const shakeSeed = Number(cw.shake_seed) || 0;
  const shakeAmpX = ((Number(cw.shake_amp_px) || 0)) / refW;
  const shakeAmpY = ((Number(cw.shake_amp_px) || 0)) / refH;
  const shakeDamp = Number(cw.shake_damp) || 0;
  const rng = shakeSeed ? mulberry32(shakeSeed) : null;

  // 계층 B: 배경 트랙은 인물 트랙 대비 bg_scale_delta_pct_per_s 만큼 스케일 가감.
  const bgDelta = Number(cw.bg_scale_delta_pct_per_s) || 0;

  /** @type {Keyframe[]} */
  const mainKeys = [];
  /** @type {Keyframe[]} */
  const charKeys = [];
  /** @type {Keyframe[]} */
  const bgKeys = [];

  for (let i = 0; i < frames; i++) {
    const t = (i / (frames - 1 || 1)) * dur;
    const off = frames > 1 ? i / (frames - 1) : 0;
    const p = ease(easing, off); // 가감속된 진행

    // 인물(=주) 줌·중심
    const scale = startZoom + (endZoom - startZoom) * p;
    let cx = 0.5 + driftTotX * p;
    let cy = 0.5 + driftTotY * p;

    // 셰이크: 프레임마다 소비(시드 결정적). 감쇠 exp(-damp*t).
    if (rng) {
      const env = shakeDamp > 0 ? Math.exp(-shakeDamp * t) : 1;
      cx += (rng() * 2 - 1) * shakeAmpX * env;
      cy += (rng() * 2 - 1) * shakeAmpY * env;
    }

    // ★가시범위 clamp: scale 에서 crop 창이 프레임을 벗어나지 않는 중심 범위로 제한.
    //   창 반폭(정규화)=0.5/scale → cx∈[0.5/s, 1-0.5/s]. scale=1 이면 중앙 고정.
    //   이렇게 물리적으로 실현 가능한 창만 저장해야 워커(clamp crop)와 웹(transform)이
    //   같은 중심을 본다(골든 테스트 2px). 여백 없는 셰이크/드리프트는 여기서 흡수된다.
    const [cxA, cyA] = clampCenter(cx, cy, scale);
    maxScale = Math.max(maxScale, scale);

    if (layer === "A") {
      mainKeys.push({ t: round4(t), off: round6(off), scale: round6(scale), cx: round6(cxA), cy: round6(cyA) });
    } else {
      // 계층 B: character = 위 궤적. background = 배경만 추가 스케일(역방향은 bgDelta 음수).
      // vertigo(달리줌): 인물 크기 유지 위해 character 는 거의 정지, background 가 크게 역방향.
      charKeys.push({ t: round4(t), off: round6(off), scale: round6(scale), cx: round6(cxA), cy: round6(cyA) });
      const bgRateScale = startZoom * (1 + ((rate + bgDelta) / 100) * dur);
      const bgEnd = Math.max(1, bgRateScale);
      const bgScale = Math.max(1, startZoom + (bgEnd - startZoom) * p);
      const [bcx, bcy] = clampCenter(cx, cy, bgScale);
      bgKeys.push({ t: round4(t), off: round6(off), scale: round6(bgScale), cx: round6(bcx), cy: round6(bcy) });
      maxScale = Math.max(maxScale, bgScale);
    }
  }

  if (layer === "A") {
    tracks.main = { keys: mainKeys };
  } else {
    tracks.character = { keys: charKeys };
    tracks.background = { keys: bgKeys };
  }

  return {
    version: CAM_TABLE_VERSION, preset, duration_s: dur, fps, frames,
    layer, refWidth: refW, refHeight: refH, tracks, maxScale: round6(maxScale),
  };
}

// ── 소비자 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * 트랙에서 진행 off(0~1) 위치의 상태를 선형보간. (웹앱 스크럽/워커 임의시점용)
 * @param {KeyframeTrack} track @param {number} off 0~1
 * @returns {CameraState}
 */
export function sampleTrack(track, off) {
  const ks = track.keys;
  if (!ks || !ks.length) return { scale: 1, cx: 0.5, cy: 0.5 };
  const u = clamp(off, 0, 1);
  if (u <= ks[0].off) return { scale: ks[0].scale, cx: ks[0].cx, cy: ks[0].cy };
  const last = ks[ks.length - 1];
  if (u >= last.off) return { scale: last.scale, cx: last.cx, cy: last.cy };
  for (let i = 1; i < ks.length; i++) {
    if (u <= ks[i].off) {
      const a = ks[i - 1], b = ks[i];
      const span = b.off - a.off || 1;
      const f = (u - a.off) / span;
      return {
        scale: a.scale + (b.scale - a.scale) * f,
        cx: a.cx + (b.cx - a.cx) * f,
        cy: a.cy + (b.cy - a.cy) * f,
      };
    }
  }
  return { scale: last.scale, cx: last.cx, cy: last.cy };
}

/**
 * 정규화 상태 → 픽셀 crop 사각형. 워커 ffmpeg crop 과 골든 테스트가 쓴다.
 * @param {CameraState} st @param {number} W @param {number} H
 * @param {{ even?: boolean }} [o]  even=true 면 코덱 요구(짝수)로 스냅
 * @returns {{ cropW: number, cropH: number, x: number, y: number }}
 */
export function toPixelCrop(st, W, H, o = {}) {
  const s = Math.max(1, st.scale);
  let cw = W / s;
  let ch = H / s;
  if (o.even) {
    cw = Math.floor(cw / 2) * 2;
    ch = Math.floor(ch / 2) * 2;
  }
  // 중심 → 좌상단, 프레임 내 클램프.
  let x = st.cx * W - cw / 2;
  let y = st.cy * H - ch / 2;
  x = clamp(x, 0, W - cw);
  y = clamp(y, 0, H - ch);
  if (o.even) {
    x = Math.round(x / 2) * 2;
    y = Math.round(y / 2) * 2;
    x = clamp(x, 0, W - cw);
    y = clamp(y, 0, H - ch);
  }
  return { cropW: cw, cropH: ch, x, y };
}

/**
 * 정규화 상태 → CSS transform(웹앱 프리뷰). 컨테이너에 꽉 찬(100%×100%) 이미지를
 * transform-origin: 0 0 로 두고 이 문자열을 주면 crop 창이 컨테이너를 채운다.
 * 유도: 화면점 = (원본점 - 좌상단)·scale. 좌상단 = (cx - 0.5/s, cy - 0.5/s).
 *   translate 는 %(컨테이너 기준) = -(cx·s - 0.5)·100 … 아래 식.
 * @param {CameraState} st
 * @returns {{ transform: string, transformOrigin: string }}
 */
export function toWebTransform(st) {
  const s = Math.max(1, st.scale);
  const tx = -(st.cx * s - 0.5) * 100;
  const ty = -(st.cy * s - 0.5) * 100;
  return {
    transform: `translate(${round4(tx)}%, ${round4(ty)}%) scale(${round6(s)})`,
    transformOrigin: "0 0",
  };
}

/**
 * 트랙 → Web Animations API keyframe 배열(웹앱 프리뷰가 element.animate 에 주입).
 * @param {KeyframeTrack} track
 * @returns {Array<{ offset: number, transform: string, transformOrigin: string }>}
 */
export function toWebKeyframes(track) {
  return (track.keys || []).map((k) => {
    const w = toWebTransform({ scale: k.scale, cx: k.cx, cy: k.cy });
    return { offset: clamp(k.off, 0, 1), transform: w.transform, transformOrigin: w.transformOrigin };
  });
}

/**
 * duration_final 확정(스펙 §5) 시 테이블 재계산. 순수 연산(무비용).
 * final 이 원 duration 과 다르면 같은 파라미터로 다시 생성하되 duration 만 교체.
 * @param {CameraWork} cw @param {number} finalDurationS
 * @param {{ fps?: number, refWidth?: number, refHeight?: number }} [opts]
 * @returns {KeyframeTable}
 */
export function rebuildForDuration(cw, finalDurationS, opts) {
  return buildKeyframeTable({ ...cw, duration_s: finalDurationS }, opts);
}

/** 업스케일 필요 판단(스펙 §1): 줌 총량>20% 또는 1080p 출력. */
export function needsUpscale(table, outputHeight = 720) {
  return table.maxScale > OVERSCAN_ZOOM || outputHeight >= 1080;
}

// ── 프리셋 기본값(스펙 §2) — 워커·웹앱 공통 어휘. resolveCameraWork 로 병합 ────────
/** @type {Record<CameraPreset, Partial<CameraWork>>} */
// ★기본값 = MV 스타일리시(사용자 반복 지정: 동작은 작게, 카메라워크는 스타일리시하게).
//   인물 동작 절제(SUBTLE_LIFE)는 buildVideoPrompt 담당 — 여기(카메라)는 과감하게 민다.
//   ★lib/cameraKeyframes.mjs 와 동일 값 유지(단일 소스 규칙 — 두 복제본이 어긋나면 프리뷰≠굽기).
export const CAMERA_PRESETS = {
  push_in: { zoom_rate_pct_per_s: 5.5, drift_px_per_s: { x: 8, y: -5 }, easing: "easeInOut" }, // 확실히 밀어들어가는 시네마틱 푸시
  pull_out: { zoom_rate_pct_per_s: -5.5, start_zoom: 1.42, easing: "easeOut" }, // 넓게 빠지는 리빌
  pan: { zoom_rate_pct_per_s: 1.5, start_zoom: 1.42, drift_px_per_s: { x: 44, y: 0 }, easing: "easeInOut" }, // 큰 여백(1.42) 안에서 빠른 트래킹 팬 + 살짝 푸시
  static: { zoom_rate_pct_per_s: 0, easing: "linear" },
  shake: { zoom_rate_pct_per_s: 0, start_zoom: 1.12, shake_seed: 1, shake_amp_px: 14, shake_damp: 0, easing: "linear" }, // 강한 핸드헬드 흔들
  crash_zoom: { zoom_rate_pct_per_s: 12, easing: "easeIn" }, // 확 파고드는 크래시(3프레이밍은 §7 별도, 단일 폴백)
  whip: { zoom_rate_pct_per_s: 0, easing: "linear" }, // 전환 속성(§2), 후처리는 전환 경로
  parallax_push: { zoom_rate_pct_per_s: 4.0, bg_scale_delta_pct_per_s: 3.0, drift_px_per_s: { x: 6, y: 0 }, easing: "easeInOut" },
  vertigo: { zoom_rate_pct_per_s: 1.0, bg_scale_delta_pct_per_s: -11, easing: "easeInOut" }, // 강한 달리줌
  orbit: {}, // I2V 위임
};

/**
 * 프리셋 기본값 + 사용자 오버라이드 → 완성된 CameraWork.
 * @param {CameraPreset} preset @param {Partial<CameraWork>} [override] @param {number} [durationS]
 * @returns {CameraWork}
 */
export function resolveCameraWork(preset, override = {}, durationS = 3.5) {
  const base = CAMERA_PRESETS[preset] || {};
  return {
    preset,
    duration_s: durationS,
    ...base,
    ...override,
    drift_px_per_s: { ...(base.drift_px_per_s || { x: 0, y: 0 }), ...(override.drift_px_per_s || {}) },
  };
}

// ── 소수 자리 고정(테이블 안정·직렬화 크기·양쪽 동일값) ─────────────────────────
function round4(v) { return Math.round(v * 1e4) / 1e4; }
function round6(v) { return Math.round(v * 1e6) / 1e6; }
