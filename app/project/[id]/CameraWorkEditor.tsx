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
  cameraWork, imageUrl, videoUrl, onChange, onApply, onPreview, applying, busy,
}: {
  cameraWork?: CameraWork;
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
  const cw = cameraWork;
  const preset: CameraPreset = cw?.preset ?? "static";
  const layer = presetLayer(preset) as "A" | "B" | "C";
  const cwKey = JSON.stringify(cw ?? {});
  const liveVideo = !!videoUrl && hover && layer !== "C"; // orbit 은 2D 오버레이로 표현 불가

  // Web Animations 프리뷰 — cameraWork/대상(이미지↔실영상) 바뀌면 재생성(즉시 반영).
  //   수식은 lib/cameraKeyframes.mjs 단일 소스라 굽기(ffmpeg crop)와 궤적이 일치(골든 테스트 ~2px).
  useEffect(() => {
    const el: HTMLImageElement | HTMLVideoElement | null = liveVideo ? vidRef.current : imgRef.current;
    if (!el) return;
    const start = () => {
      el.getAnimations().forEach((a) => a.cancel());
      if (!cw || layer === "C") return; // orbit: 클라이언트 프리뷰 불가
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
        {layer === "C" && <span className="text-[var(--warn,#c90)]" title="orbit 은 2D 후처리로 불가 — I2V 위임. 클라이언트 미리보기 없이 프록시 렌더가 필요합니다.">프록시 렌더 필수</span>}
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
            {layer === "C" ? "orbit — 굽기/생성 후 확인" : videoUrl ? (hover ? "실영상 · 굽기 전 미리보기" : "▶ 올리면 실영상") : "정지 이미지 근사"}
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

      {preset !== "static" && layer !== "C" && (
        <div className="flex flex-col gap-1">
          <Slider label="길이" value={cw?.duration_s ?? 3.5} min={0.5} max={12} step={0.5} suffix="s" onChange={(v) => set({ duration_s: v })} />
          <Slider label="줌 속도" value={cw?.zoom_rate_pct_per_s ?? 0} min={-15} max={15} step={0.5} suffix="%/s" onChange={(v) => set({ zoom_rate_pct_per_s: v })} />
          <Slider label="드리프트X" value={drift.x} min={-100} max={100} step={5} onChange={(v) => set({ drift_px_per_s: { x: v, y: drift.y } })} />
          <Slider label="드리프트Y" value={drift.y} min={-100} max={100} step={5} onChange={(v) => set({ drift_px_per_s: { x: drift.x, y: v } })} />
          {(preset === "pull_out" || preset === "pan" || preset === "shake") && (
            <Slider label="시작 줌" value={cw?.start_zoom ?? 1} min={1} max={2} step={0.05} suffix="x" onChange={(v) => set({ start_zoom: v })} />
          )}
          {layer === "B" && (
            <Slider label="배경 델타" value={cw?.bg_scale_delta_pct_per_s ?? 0} min={-10} max={10} step={0.5} suffix="%p/s" onChange={(v) => set({ bg_scale_delta_pct_per_s: v })} />
          )}
          {/* 흔들 진폭(핸드헬드 그레인) — shake 뿐 아니라 push/pan/crash 에도 노출해 '거칠기'를 직접 조절·제거. */}
          {(preset === "shake" || preset === "push_in" || preset === "pan" || preset === "crash_zoom") && (
            <Slider label="흔들 진폭" value={cw?.shake_amp_px ?? 0} min={0} max={40} step={1} suffix="px" onChange={(v) => set({ shake_amp_px: v, shake_seed: cw?.shake_seed || 1 })} />
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
        <button
          type="button"
          onClick={onApply}
          disabled={busy || applying || layer === "B" || layer === "C" || preset === "static"}
          title={
            layer === "C" ? "orbit 은 I2V 위임 — 후처리 굽기 대상 아님(프록시 렌더 필요)"
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
