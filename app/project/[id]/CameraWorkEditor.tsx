"use client";
// ============================================================================
// 카메라워크 편집기 (스펙 §8 ① 클라이언트 시뮬레이션 · Phase 3)
// ----------------------------------------------------------------------------
// 씬 정지 이미지 위에 키프레임 테이블을 Web Animations API 로 재생(무비용 근사).
// 파라미터 슬라이더 즉시 반영, 저장은 camera_work JSON 만(onChange→updateCut). "적용"은
// 워커 camerafx 잡(정확 렌더). 수식은 lib/cameraKeyframes.mjs 단일 소스.
//   계층 B(parallax/vertigo)는 인물/배경 매트 미구현 → 프리뷰는 근사(단일 레이어),
//   굽기는 매트 준비 후. orbit(계층 C)은 클라이언트 프리뷰 불가 → "프록시 렌더 필수".
// ============================================================================
import { useEffect, useRef, useState } from "react";
import type { CameraWork, CameraPreset } from "@/lib/types";
// allowJs — 순수 ESM 모듈(무의존)을 그대로 import.
import { buildKeyframeTable, toWebKeyframes, resolveCameraWork, presetLayer } from "@/lib/cameraKeyframes.mjs";

const PRESETS: { id: CameraPreset; label: string; layer: "A" | "B" | "C" }[] = [
  { id: "static", label: "정지(카메라 없음)", layer: "A" },
  { id: "push_in", label: "밀어들어가기 push-in", layer: "A" },
  { id: "pull_out", label: "빠지기 pull-out", layer: "A" },
  { id: "pan", label: "팬 pan", layer: "A" },
  { id: "shake", label: "흔들기 shake", layer: "A" },
  { id: "crash_zoom", label: "크래시 줌", layer: "A" },
  { id: "whip", label: "휩 whip(전환)", layer: "A" },
  { id: "parallax_push", label: "패럴랙스(계층B·매트 후)", layer: "B" },
  { id: "vertigo", label: "버티고 달리줌(계층B·매트 후)", layer: "B" },
  { id: "orbit", label: "오빗 orbit(I2V·프록시 필수)", layer: "C" },
];

function Slider({
  label, value, min, max, step, onChange, suffix,
}: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; suffix?: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[10px]">
      <span className="w-14 shrink-0 text-[var(--muted)]">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 flex-1 accent-[var(--accent)]"
      />
      <span className="w-10 shrink-0 text-right tabular-nums">{value}{suffix ?? ""}</span>
    </label>
  );
}

export default function CameraWorkEditor({
  cameraWork, motionTier, proxyUrl, onProxy, imageUrl, videoUrl, onChange, onApply, onPreview, applying, busy,
}: {
  cameraWork?: CameraWork;
  motionTier?: string;
  proxyUrl?: string; // 480p 정확 미리보기 결과(§8②)
  onProxy?: () => void; // "정확 미리보기" 요청 // 티어별 기본 카메라 결정용(§3·§9 — 비어 있으면 자동 적용)
  imageUrl?: string;
  videoUrl?: string; // 있으면: 마우스 올릴 때 '정지 이미지' 대신 '실제 영상(raw)' 위에 카메라를 얹어 재생(굽기 전 실제에 가장 가까움).
  onChange: (cw: CameraWork) => void;
  onApply: () => void;
  onPreview?: () => void; // 프리뷰 박스 클릭 시 — 큰 결과 미리보기 모달 열기(있을 때만 클릭 가능).
  applying: boolean;
  busy: boolean;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const vidRef = useRef<HTMLVideoElement>(null);
  // ★실영상 프리뷰는 hover 시에만 <video> 를 mount(떼면 언마운트) — 컷 많을 때 수십 개 동시 디코딩=크롬 먹통 방지.
  const [hover, setHover] = useState(false);
  // ★★카메라워크가 비어 있으면 '정지'가 아니라 티어에 맞는 기본 카메라를 자동 적용한다.
  //   스펙 §9: "연출 설정은 전부 자동으로 채워지며, 사람은 예외만 만진다."
  //   예전엔 cameraWork 가 없으면 preset=static → 프리뷰가 아무것도 안 움직였고, 기존
  //   프로젝트는 재추출을 해야만 채워졌다(사용자: 카메라워크가 왜 안 보이냐 — 열흘).
  //   여기서 티어별 기본을 주면 재추출 없이 모든 컷에 카메라가 생긴다. 사람이 고르면 그게 우선.
  const tierDefault: CameraPreset =
    motionTier === "action" ? "crash_zoom" : motionTier === "emote" ? "push_in" : motionTier === "idle" ? "pan" : "push_in";
  const cw = cameraWork ?? resolveCameraWork(tierDefault, {}, 3.5);
  const isAuto = !cameraWork; // 자동 적용된 기본값인지(라벨로 정직하게 표시)
  const preset: CameraPreset = cw?.preset ?? "static";
  const layer = presetLayer(preset) as "A" | "B" | "C";
  const cwKey = JSON.stringify(cw ?? {});
  // ★프록시가 있으면 그걸 그대로 재생한다 — 이미 카메라워크가 구워진 '정확' 영상이라
  //   오버레이(근사 변환)를 얹지 않는다. orbit·계층B 도 이 경로로 실제 결과를 볼 수 있다.
  // ★오빗도 실영상 위에 프리뷰한다 — 궤도는 이미 그 영상에 들어 있고(I2V), 여기 얹는 것은
  //   후처리 줌·드리프트다. 예전엔 layer C 를 통째로 막아 오빗 컷은 미리보기가 아예 없었다.
  const liveVideo = !!videoUrl && hover;
  const showProxy = !!proxyUrl && hover;

  // Web Animations 프리뷰 — cameraWork/대상(이미지↔실영상) 바뀌면 재생성(즉시 반영).
  //   수식은 lib/cameraKeyframes.mjs 단일 소스라 굽기(ffmpeg crop)와 궤적이 일치(골든 테스트 ~2px).
  useEffect(() => {
    const el: HTMLImageElement | HTMLVideoElement | null = liveVideo ? vidRef.current : imgRef.current;
    if (!el) return;
    const start = () => {
      el.getAnimations().forEach((a) => a.cancel());
      if (!cw) return;
      // ★오빗: 궤도 자체는 근사할 수 없지만(그건 영상에 이미 있음), 후처리 줌·드리프트는
      //   그대로 미리 볼 수 있다. 테이블에 main 트랙이 없으면(후처리 성분 0) 아무것도 안 한다.
      const rw = (el as HTMLVideoElement).videoWidth || (el as HTMLImageElement).naturalWidth || 1280;
      const rh = (el as HTMLVideoElement).videoHeight || (el as HTMLImageElement).naturalHeight || 720;
      const table = buildKeyframeTable(cw, { fps: 24, refWidth: rw, refHeight: rh });
      const track = table.tracks.main ?? table.tracks.character; // 계층 B 는 character 트랙으로 근사
      if (!track) return;
      const kfs = toWebKeyframes(track).map((k) => ({ offset: k.offset, transform: k.transform, transformOrigin: k.transformOrigin }));
      if (kfs.length < 2) return;
      el.animate(kfs, { duration: Math.max(300, (cw.duration_s || 3) * 1000), iterations: Infinity, easing: "linear", fill: "both" });
    };
    if (liveVideo) {
      const v = el as HTMLVideoElement;
      const onReady = () => { v.play().catch(() => {}); start(); };
      if (v.readyState >= 2) onReady();
      else {
        v.addEventListener("loadeddata", onReady, { once: true });
        return () => v.removeEventListener("loadeddata", onReady);
      }
    } else {
      const img = el as HTMLImageElement;
      if (img.complete) start();
      else {
        img.addEventListener("load", start, { once: true });
        return () => img.removeEventListener("load", start);
      }
    }
  }, [cwKey, layer, imageUrl, videoUrl, liveVideo, cw]);

  const set = (patch: Partial<CameraWork>) => {
    const base = cw ?? resolveCameraWork(preset, {}, 3.5);
    onChange({ ...base, ...patch });
  };
  const pickPreset = (p: CameraPreset) => onChange(resolveCameraWork(p, { duration_s: cw?.duration_s ?? 3.5 }, cw?.duration_s ?? 3.5));

  const drift = cw?.drift_px_per_s ?? { x: 0, y: 0 };

  return (
    <div className="flex flex-col gap-1.5 rounded border border-[var(--border)] bg-[var(--panel-2)] p-2 text-[10px]">
      <div className="flex items-center gap-1">
        <span className="font-medium text-[var(--muted)]">🎥 카메라워크</span>
        <span className="rounded bg-[var(--panel)] px-1 text-[9px] text-[var(--muted)]" title="클라이언트 미리보기는 근사입니다. 최종 픽셀은 '적용(굽기)'로 워커가 렌더합니다.">근사</span>
        {isAuto && (
          <span className="rounded bg-[var(--panel)] px-1 text-[9px] text-[var(--accent)]" title="이 컷은 카메라워크를 따로 지정하지 않아 모션 티어에 맞는 기본값이 자동 적용됩니다. 프리셋을 고르면 그 값이 저장됩니다.">
            자동
          </span>
        )}
        {layer === "C" && (
          <span
            className="text-[var(--warn,#c90)]"
            title="궤도(오빗)는 영상 생성(I2V)이 만듭니다. 여기서 준 줌·드리프트·흔들림은 후처리로 그 위에 얹혀 굽습니다 — 미리보기의 줌은 실제와 같고, 궤도는 생성된 영상에 이미 들어 있습니다."
          >
            궤도=생성 · 줌=후처리
          </span>
        )}
        {layer === "B" && <span className="text-[var(--muted)]" title="인물/배경 매트가 준비되면 2레이어로 굽습니다(현재 프리뷰는 근사).">계층 B · 매트 준비 후 굽기</span>}
      </div>

      {/* 프리뷰 — 정지 이미지 위 카메라(항상) + 마우스 올리면 실제 영상(raw) 위 카메라로 전환(굽기 전 실제에 가장 가까움). */}
      {imageUrl && (
        <div
          onMouseEnter={() => videoUrl && setHover(true)}
          onMouseLeave={() => setHover(false)}
          onClick={onPreview}
          className={`relative w-full overflow-hidden rounded bg-black ${onPreview ? "cursor-zoom-in" : ""}`}
          style={{ aspectRatio: "16 / 9" }}
          title={videoUrl ? "마우스=실제 영상 위 카메라 재생 · 클릭=큰 결과 미리보기(계층B·orbit 제외)" : onPreview ? "클릭하면 큰 미리보기" : undefined}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img ref={imgRef} src={imageUrl} alt="camera preview" className="absolute inset-0 h-full w-full object-cover" style={{ willChange: "transform" }} />
          {liveVideo && (
            <video ref={vidRef} key={videoUrl} src={videoUrl} muted loop playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover" style={{ willChange: "transform" }} />
          )}
          <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/55 px-1 text-[9px] text-white/85">
            {videoUrl
              ? hover
                ? layer === "C"
                  ? "실영상(궤도 포함) · 줌은 근사"
                  : "실영상 · 굽기 전 미리보기"
                : "▶ 올리면 실영상"
              : layer === "C"
                ? "궤도는 영상 생성 후 보입니다 · 줌만 근사"
                : "정지 이미지 근사"}
          </span>
        </div>
      )}

      <select
        value={preset}
        onChange={(e) => pickPreset(e.target.value as CameraPreset)}
        className="rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-0.5"
      >
        {PRESETS.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>

      {/* ★오빗(layer C)도 슬라이더를 연다 — '오빗 + 줌' 동시 지정(사용자 지정).
          궤도는 영상 생성(I2V)이, 줌·드리프트·흔들림은 후처리가 담당한다. */}
      {preset !== "static" && (
        <div className="flex flex-col gap-1">
          <Slider label="길이" value={cw?.duration_s ?? 3.5} min={0.5} max={12} step={0.5} suffix="s" onChange={(v) => set({ duration_s: v })} />
          {/* ★줌 폭을 ±40%/s 까지 — 가속만 올리고 폭이 작으면 "확 들어가는" 느낌이 안 난다.
              가속(뒤 슬라이더)과 함께 써야 '거의 멈췄다가 순간적으로 파고드는' 줌이 된다. */}
          <Slider label="줌 속도" value={cw?.zoom_rate_pct_per_s ?? 0} min={-40} max={40} step={0.5} suffix="%/s" onChange={(v) => set({ zoom_rate_pct_per_s: v })} />
          <Slider label="드리프트X" value={drift.x} min={-100} max={100} step={5} onChange={(v) => set({ drift_px_per_s: { x: v, y: drift.y } })} />
          <Slider label="드리프트Y" value={drift.y} min={-100} max={100} step={5} onChange={(v) => set({ drift_px_per_s: { x: drift.x, y: v } })} />
          {(preset === "pull_out" || preset === "pan" || preset === "shake") && (
            <Slider label="시작 줌" value={cw?.start_zoom ?? 1} min={1} max={2} step={0.05} suffix="x" onChange={(v) => set({ start_zoom: v })} />
          )}
          {layer === "B" && (
            <Slider label="배경 델타" value={cw?.bg_scale_delta_pct_per_s ?? 0} min={-10} max={10} step={0.5} suffix="%p/s" onChange={(v) => set({ bg_scale_delta_pct_per_s: v })} />
          )}
          {/* ★가속 줌 — 사용자 지정 "처음엔 거의 멈춰 있다가 갑자기 엄청난 속도로 파고든다".
              0=일정 속도. 12 면 전체 시간의 90% 동안 겨우 25% 만 움직이고 마지막에 몰아친다.
              가속만으로는 부족하고 '줌 속도'(폭)도 같이 올려야 확 들어간다. */}
          {/* ★버티고(달리줌)·패럴랙스도 같은 진행값을 쓰므로 가속이 그대로 걸린다(사용자 지정) —
              슬라이더가 안 보여서 조절을 못 했을 뿐이다. */}
          {preset !== "whip" && preset !== "shake" && (
            <>
              {/* ★정지 구간 — 지수 가속만으로는 움직임이 끝 10% 에 몰려 뒷부분이 짧다(사용자 지적).
                  0.5 면 "앞 절반 정지 · 뒤 절반에 줌 전체". 구간을 사람이 직접 나눈다. */}
              <Slider
                label="느린 구간"
                value={cw?.accel_hold ?? 0}
                min={0}
                max={0.9}
                step={0.05}
                suffix="비율"
                onChange={(v) => set({ accel_hold: v })}
              />
              {/* 그 느린 구간에서 얼마나 움직일지 — 0 이면 완전 정지(정지컷처럼 보임), 0.15 기본. */}
              {(cw?.accel_hold ?? 0) > 0 && (
                <Slider
                  label="느린 구간 이동"
                  value={cw?.accel_hold_creep ?? 0.15}
                  min={0}
                  max={0.6}
                  step={0.05}
                  suffix="비율"
                  onChange={(v) => set({ accel_hold_creep: v })}
                />
              )}
              <Slider
                label="가속"
                value={cw?.zoom_accel ?? 0}
                min={0}
                max={12}
                step={0.5}
                onChange={(v) => set({ zoom_accel: v })}
              />
            </>
          )}
          {/* 흔들 진폭 — ★기본 0. 예전엔 push/pan/crash 에 기본으로 들어가 '모든 화면이 흔들렸다'. */}
          {(preset === "shake" || preset === "push_in" || preset === "pan" || preset === "crash_zoom") && (
            <Slider label="흔들 진폭" value={cw?.shake_amp_px ?? 0} min={0} max={40} step={1} suffix="px" onChange={(v) => set({ shake_amp_px: v, shake_seed: cw?.shake_seed || 1 })} />
          )}
          {/* 흔들 속도(Hz) — 낮으면 느리게 출렁, 높으면 잔진동. 0=프레임마다(가장 빠름). */}
          {(preset === "shake" || preset === "push_in" || preset === "pan" || preset === "crash_zoom") && (
            <Slider label="흔들 속도" value={cw?.shake_hz ?? 0} min={0} max={20} step={0.5} suffix="Hz" onChange={(v) => set({ shake_hz: v, shake_seed: cw?.shake_seed || 1 })} />
          )}
        </div>
      )}

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => pickPreset(preset)}
          className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--muted)] hover:bg-[var(--panel)]"
          title="이 프리셋의 기본 파라미터로 되돌립니다"
        >
          기본값
        </button>
        {onProxy && (
          <button
            type="button"
            onClick={onProxy}
            disabled={busy || applying || !videoUrl || preset === "static"}
            className="rounded border border-[var(--accent)] px-2 py-0.5 text-[var(--accent)] disabled:opacity-40 hover:bg-[var(--panel)]"
            title="480p 로 빠르게 구워 '실제 결과'를 봅니다(스펙 §8②). 본 굽기 결과(fxUrl)는 건드리지 않습니다. orbit·계층B 도 이걸로 확인."
          >
            {applying ? "…" : "🔍 정확 미리보기"}
          </button>
        )}
        <button
          type="button"
          onClick={onApply}
          // ★오빗도 '줌 등 후처리 성분이 있으면' 굽는다(궤도는 이미 영상에 있음). 성분이 0 이면
          //   워커가 스킵하므로 눌러도 손해는 없지만, 버튼은 열어 둔다(기능을 감추지 않는다).
          disabled={busy || applying || layer === "B" || preset === "static"}
          title={
            layer === "C" ? "오빗의 줌·드리프트·흔들림을 실제 픽셀에 굽습니다(궤도는 생성된 영상에 이미 있습니다). 줌을 0 으로 두면 구울 게 없어 그대로 둡니다."
            : layer === "B" ? "인물/배경 매트 준비 후 굽기 지원"
            : preset === "static" ? "정지는 굽지 않습니다(원본 사용)"
            : "이 카메라워크를 실제 픽셀에 굽습니다(컷당 ~20-40초). 굽고 나면 미리보기가 최종 픽셀입니다."
          }
          className="rounded bg-[var(--accent)] px-2 py-0.5 font-medium text-white disabled:opacity-40"
        >
          {applying ? "굽는 중…" : "🎥 적용(굽기)"}
        </button>
      </div>
    </div>
  );
}
