// 말풍선(대사) 저장 정리 — /api/cut 저장 시 신뢰 못 할 입력을 화이트리스트로 정리한다.
// ★한 곳에서만 정의(단일 원천) — 필드 추가 시 여기만 고치면 저장 경로 전체에 반영·테스트 가능.
//   translation(번역)이 여기서 빠지면 편집 저장 때 번역이 통째로 날아간다(과거 버그).
import { EMOTIONS, type DialogueBubble, type CameraWork, type CameraPreset, type CameraEasing, type AudioSuggestion } from "./types";

const EMOTION_IDS = new Set(EMOTIONS.map((e) => e.id));

// 카메라워크(스펙 §2) 저장 정리 — 저장 경로가 화이트리스트라 여기 없으면 통째로 날아간다.
const CAM_PRESETS = new Set<CameraPreset>([
  "push_in", "pull_out", "pan", "static", "shake", "crash_zoom", "whip", "parallax_push", "vertigo", "orbit",
]);
const CAM_EASINGS = new Set<CameraEasing>(["linear", "easeIn", "easeOut", "easeInOut"]);
const clampNum = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === "number" && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined;

export function cleanCameraWork(raw: unknown): CameraWork | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.preset !== "string" || !CAM_PRESETS.has(r.preset as CameraPreset)) return undefined;
  const cw: CameraWork = {
    preset: r.preset as CameraPreset,
    duration_s: clampNum(r.duration_s, 0.3, 20) ?? 3.5,
  };
  const zr = clampNum(r.zoom_rate_pct_per_s, -15, 15);
  if (zr !== undefined) cw.zoom_rate_pct_per_s = zr;
  if (r.drift_px_per_s && typeof r.drift_px_per_s === "object") {
    const d = r.drift_px_per_s as Record<string, unknown>;
    cw.drift_px_per_s = { x: clampNum(d.x, -300, 300) ?? 0, y: clampNum(d.y, -300, 300) ?? 0 };
  }
  const bg = clampNum(r.bg_scale_delta_pct_per_s, -15, 15);
  if (bg !== undefined) cw.bg_scale_delta_pct_per_s = bg;
  if (typeof r.easing === "string" && CAM_EASINGS.has(r.easing as CameraEasing)) cw.easing = r.easing as CameraEasing;
  const ss = clampNum(r.shake_seed, 0, 1e9);
  if (ss !== undefined) cw.shake_seed = Math.round(ss);
  const sa = clampNum(r.shake_amp_px, 0, 40);
  if (sa !== undefined) cw.shake_amp_px = sa;
  const sd = clampNum(r.shake_damp, 0, 20);
  if (sd !== undefined) cw.shake_damp = sd;
  const sz = clampNum(r.start_zoom, 1, 3);
  if (sz !== undefined) cw.start_zoom = sz;
  return cw;
}

export function cleanBubble(raw: unknown): DialogueBubble {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const box = b.box && typeof b.box === "object" ? (b.box as Record<string, unknown>) : null;
  return {
    text: typeof b.text === "string" ? b.text.slice(0, 400) : "",
    translation: typeof b.translation === "string" ? b.translation.slice(0, 400) : undefined, // 번역 보존
    speakerId: typeof b.speakerId === "string" ? b.speakerId : b.speakerId === null ? null : undefined,
    box: box
      ? {
          left: Number(box.left) || 0,
          top: Number(box.top) || 0,
          right: Number(box.right) || 0,
          bottom: Number(box.bottom) || 0,
        }
      : undefined,
    audioUrl: typeof b.audioUrl === "string" ? b.audioUrl : undefined,
    subtitleX:
      typeof b.subtitleX === "number" && isFinite(b.subtitleX)
        ? Math.max(0.05, Math.min(0.95, b.subtitleX))
        : undefined,
    subtitleY:
      typeof b.subtitleY === "number" && isFinite(b.subtitleY)
        ? Math.max(0.05, Math.min(0.95, b.subtitleY))
        : undefined,
    emotion: EMOTION_IDS.has(String(b.emotion)) ? String(b.emotion) : undefined,
    volume:
      typeof b.volume === "number" && isFinite(b.volume) && b.volume > 0 && b.volume !== 1
        ? Math.max(0.1, Math.min(3, b.volume))
        : undefined, // 목소리 크기 배수(합성 적용)
    distant: b.distant === true ? true : undefined, // 거리감(멀리서)
    noSubtitle: b.noSubtitle === true ? true : undefined, // 자막 제외(소리는 유지)
  } as DialogueBubble;
}

export function cleanBubbles(raw: unknown): DialogueBubble[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((b) => !!b && typeof b === "object").map(cleanBubble).slice(0, 12);
}

// 오디오 채움 제안(스펙 §6) 저장 정리 — 화이트리스트.
const SUG_TYPES = new Set(["sfx", "vocal_reaction", "insert_line"]);
const SUG_TIMING = new Set(["start", "mid", "end"]);
export function cleanAudioSuggestions(raw: unknown): AudioSuggestion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && SUG_TYPES.has(String((s as Record<string, unknown>).type)))
    .map((s) => {
      const sug: AudioSuggestion = {
        type: s.type as AudioSuggestion["type"],
        text: typeof s.text === "string" ? s.text.slice(0, 300) : "",
      };
      if (typeof s.speaker === "string") sug.speaker = s.speaker;
      else if (s.speaker === null) sug.speaker = null;
      if (typeof s.timing === "string" && SUG_TIMING.has(s.timing)) sug.timing = s.timing as AudioSuggestion["timing"];
      if (typeof s.confidence === "number" && isFinite(s.confidence)) sug.confidence = Math.max(0, Math.min(1, s.confidence));
      if (s.enabled === false) sug.enabled = false;
      if (typeof s.ko === "string") sug.ko = s.ko.slice(0, 300);
      if (typeof s.audioUrl === "string") sug.audioUrl = s.audioUrl; // 생성 오디오 보존
      return sug;
    })
    .slice(0, 8);
  return out;
}
