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
import { useEffect, useRef } from "react";
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
  cameraWork, imageUrl, onChange, onApply, applying, busy,
}: {
  cameraWork?: CameraWork;
  imageUrl?: string;
  onChange: (cw: CameraWork) => void;
  onApply: () => void;
  applying: boolean;
  busy: boolean;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const cw = cameraWork;
  const preset: CameraPreset = cw?.preset ?? "static";
  const layer = presetLayer(preset) as "A" | "B" | "C";
  const cwKey = JSON.stringify(cw ?? {});

  // Web Animations 프리뷰 — cameraWork 바뀌면 재생성(즉시 반영).
  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    const start = () => {
      el.getAnimations().forEach((a) => a.cancel());
      if (!cw || layer === "C") return; // orbit: 클라이언트 프리뷰 불가
      const rw = el.naturalWidth || 1280;
      const rh = el.naturalHeight || 720;
      const table = buildKeyframeTable(cw, { fps: 24, refWidth: rw, refHeight: rh });
      const track = table.tracks.main ?? table.tracks.character; // 계층 B 는 character 트랙으로 근사
      if (!track) return;
      const kfs = toWebKeyframes(track).map((k) => ({ offset: k.offset, transform: k.transform, transformOrigin: k.transformOrigin }));
      if (kfs.length < 2) return;
      el.animate(kfs, { duration: Math.max(300, (cw.duration_s || 3) * 1000), iterations: Infinity, easing: "linear", fill: "both" });
    };
    if (el.complete) start();
    else {
      el.addEventListener("load", start, { once: true });
      return () => el.removeEventListener("load", start);
    }
  }, [cwKey, layer, imageUrl, cw]);

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

      {/* 프리뷰 — 이미지 위 카메라워크(overflow hidden + transform) */}
      {imageUrl && (
        <div className="relative w-full overflow-hidden rounded bg-black" style={{ aspectRatio: "16 / 9" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img ref={imgRef} src={imageUrl} alt="camera preview" className="absolute inset-0 h-full w-full object-cover" style={{ willChange: "transform" }} />
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
          <Slider label="줌 속도" value={cw?.zoom_rate_pct_per_s ?? 0} min={-8} max={8} step={0.5} suffix="%/s" onChange={(v) => set({ zoom_rate_pct_per_s: v })} />
          <Slider label="드리프트X" value={drift.x} min={-100} max={100} step={5} onChange={(v) => set({ drift_px_per_s: { x: v, y: drift.y } })} />
          <Slider label="드리프트Y" value={drift.y} min={-100} max={100} step={5} onChange={(v) => set({ drift_px_per_s: { x: drift.x, y: v } })} />
          {(preset === "pull_out" || preset === "pan" || preset === "shake") && (
            <Slider label="시작 줌" value={cw?.start_zoom ?? 1} min={1} max={2} step={0.05} suffix="x" onChange={(v) => set({ start_zoom: v })} />
          )}
          {layer === "B" && (
            <Slider label="배경 델타" value={cw?.bg_scale_delta_pct_per_s ?? 0} min={-10} max={10} step={0.5} suffix="%p/s" onChange={(v) => set({ bg_scale_delta_pct_per_s: v })} />
          )}
          {preset === "shake" && (
            <Slider label="흔들 진폭" value={cw?.shake_amp_px ?? 8} min={0} max={20} step={1} suffix="px" onChange={(v) => set({ shake_amp_px: v, shake_seed: cw?.shake_seed || 1 })} />
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
