// 말풍선(대사) 저장 정리 — /api/cut 저장 시 신뢰 못 할 입력을 화이트리스트로 정리한다.
// ★한 곳에서만 정의(단일 원천) — 필드 추가 시 여기만 고치면 저장 경로 전체에 반영·테스트 가능.
//   translation(번역)이 여기서 빠지면 편집 저장 때 번역이 통째로 날아간다(과거 버그).
import { EMOTIONS, type DialogueBubble, type BubbleTrack, type CameraWork, type CameraPreset, type CameraEasing, type AudioSuggestion, type CutOntology } from "./types";

const EMOTION_IDS = new Set(EMOTIONS.map((e) => e.id));

// 언어별 대사 트랙(스펙 §10) 저장 정리 — 화이트리스트 빠지면 저장 때 tracks 증발(text/translation 은 아래 별도 보존).
const TRACK_STATUS = new Set(["pending", "translated", "tts", "done"]);
function cleanTracks(raw: unknown): Record<string, BubbleTrack> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, BubbleTrack> = {};
  for (const [lang, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z]{2,5}$/.test(lang) || !v || typeof v !== "object") continue;
    const t = v as Record<string, unknown>;
    const tr: BubbleTrack = {};
    if (typeof t.text === "string") tr.text = t.text.slice(0, 400);
    if (typeof t.audioUrl === "string") tr.audioUrl = t.audioUrl; // TTS 오디오 보존
    if (typeof t.durationFinal === "number" && isFinite(t.durationFinal)) tr.durationFinal = Math.max(0, Math.min(60, t.durationFinal));
    if (typeof t.status === "string" && TRACK_STATUS.has(t.status)) tr.status = t.status as BubbleTrack["status"];
    if (Object.keys(tr).length) out[lang] = tr;
  }
  return Object.keys(out).length ? out : undefined;
}

// 카메라워크(스펙 §2) 저장 정리 — 저장 경로가 화이트리스트라 여기 없으면 통째로 날아간다.
const CAM_PRESETS = new Set<CameraPreset>([
  "push_in", "pull_out", "pan", "static", "shake", "crash_zoom", "whip", "parallax_push", "vertigo", "orbit",
]);
const CAM_EASINGS = new Set<CameraEasing>(["linear", "easeIn", "easeOut", "easeInOut"]);
const clampNum = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === "number" && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined;

// 카메라워크 지문 — "이 컷이 지금 설정대로 이미 구워져 있나"를 판단한다.
// ★worker/jobs.mjs 의 camSig 와 같은 규칙이어야 한다(다르면 매번 다시 굽거나, 바뀐 걸 놓친다).
export function camSig(cw?: CameraWork | null): string {
  if (!cw || !cw.preset) return "";
  const s = JSON.stringify(cw);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${cw.preset}:${h.toString(36)}`;
}

export function cleanCameraWork(raw: unknown): CameraWork | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.preset !== "string" || !CAM_PRESETS.has(r.preset as CameraPreset)) return undefined;
  const cw: CameraWork = {
    preset: r.preset as CameraPreset,
    duration_s: clampNum(r.duration_s, 0.3, 20) ?? 3.5,
  };
  // ★±40%/s — 가속 줌("거의 멈췄다가 확")은 폭이 커야 체감된다(사용자 지정).
  const zr = clampNum(r.zoom_rate_pct_per_s, -40, 40);
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
  // ★가속 줌·흔들림 속도 — 화이트리스트에서 빠지면 저장 시 사라진다(이 프로젝트 단골 사고).
  const za = clampNum(r.zoom_accel, 0, 12);
  if (za !== undefined) cw.zoom_accel = za;
  const ah = clampNum(r.accel_hold, 0, 0.9);
  if (ah !== undefined) cw.accel_hold = ah;
  const ac = clampNum(r.accel_hold_creep, 0, 0.6);
  if (ac !== undefined) cw.accel_hold_creep = ac;
  const sh = clampNum(r.shake_hz, 0, 30);
  if (sh !== undefined) cw.shake_hz = sh;
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
    tracks: cleanTracks(b.tracks), // 언어별 번역·TTS(§10) 보존
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
      // ★어떻게(gen: 효과음/목소리)·어느 언어(lang)로 만든 오디오인지 — 화이트리스트에서 빠지면
      //   앱이 저장할 때 사라지고, 합성이 '일본어판에 영어 음성' 을 다시 섞게 된다.
      if (s.gen === "sfx" || s.gen === "tts") sug.gen = s.gen;
      if (typeof s.lang === "string") sug.lang = s.lang.slice(0, 5);
      return sug;
    })
    .slice(0, 8);
  return out;
}

// ★대사·효과음 '텍스트'를 고치면 그 줄의 기존 소리를 자동 무효화 — 더빙 증분은 '소리 있음'만
//   보므로(worker/jobs.mjs runDub existing 판정), 안 지우면 텍스트를 고쳐도 옛 텍스트의 소리가
//   영영 남는다. 목소리 변경 무효화(8e3c671)와 같은 규칙의 텍스트판. 지우면 다음 더빙(일괄·이 컷)이
//   그 줄만 새로 만든다(안 고친 줄은 그대로 = 비용 최소). /api/cut 저장에서 preserveWorkerAudio
//   '다음에' 호출한다(복원은 인덱스+텍스트 일치일 때만이라 복원분은 여기서 절대 안 지워짐).
//   ★줄 이동·삽입으로 인덱스가 밀린 경우: 소리 URL 로 '이 소리가 태어난 줄'을 prev 에서 찾아
//   그 줄의 텍스트와 비교한다 — 멀쩡한 소리를 인덱스 어긋남으로 오폭하지 않는다.
export function invalidateEditedAudio(cleaned: CutOntology, prev: CutOntology | undefined): CutOntology {
  if (!prev) return cleaned;
  // 내레이션·컷 효과음(레거시 단일 필드): 텍스트가 바뀌면 그 소리는 낡은 것
  if ((cleaned.narration ?? "") !== (prev.narration ?? "")) cleaned.narrationAudioUrl = undefined;
  if ((cleaned.sfx ?? "") !== (prev.sfx ?? "")) cleaned.sfxAudioUrl = undefined;
  const pb = prev.bubbles ?? [];
  (cleaned.bubbles ?? []).forEach((b, i) => {
    // 이 줄의 '이전 모습' — 소리 URL 이 prev 어느 줄과 일치하면 그 줄(이동 안전), 아니면 같은 인덱스
    const origin =
      pb.find(
        (p) =>
          (b.audioUrl != null && p.audioUrl === b.audioUrl) ||
          Object.entries(b.tracks ?? {}).some(
            ([l, t]) => t?.audioUrl != null && p.tracks?.[l]?.audioUrl === t.audioUrl
          )
      ) ?? pb[i];
    if (!origin) return; // 새 줄 — 무효화할 옛 소리가 없다
    const textChanged = (origin.text ?? "") !== (b.text ?? "");
    if (textChanged && b.audioUrl != null) b.audioUrl = undefined; // 원어 소리(대사·__sfx__ 효과음 줄 공통)
    for (const [lang, t] of Object.entries(b.tracks ?? {})) {
      if (!t || t.audioUrl == null) continue;
      // 언어 소리는 그 언어 번역 텍스트에서 태어난다 — 원문이 바뀌면(번역이 낡음) 또는
      // 번역 텍스트를 직접 고쳤으면 그 언어 소리를 지운다(번역 텍스트 자체는 보존 — 사람 수정 존중).
      const ot = origin.tracks?.[lang];
      const trackTextChanged = ot ? (ot.text ?? "") !== (t.text ?? "") : false;
      if (textChanged || trackTextChanged) {
        t.audioUrl = undefined;
        t.durationFinal = undefined;
        if (t.status === "tts" || t.status === "done") t.status = t.text ? "translated" : "pending";
      }
    }
  });
  // 오디오 제안(효과음·삽입 대사): 텍스트를 고치면 생성음 무효화(인덱스 대응 — preserve 와 동일 규칙)
  const ps = prev.audioSuggestions ?? [];
  (cleaned.audioSuggestions ?? []).forEach((s, i) => {
    const o = ps[i];
    if (o && (o.text ?? "") !== (s.text ?? "") && s.audioUrl != null) s.audioUrl = undefined;
  });
  return cleaned;
}
