// 말풍선(대사) 저장 정리 — /api/cut 저장 시 신뢰 못 할 입력을 화이트리스트로 정리한다.
// ★한 곳에서만 정의(단일 원천) — 필드 추가 시 여기만 고치면 저장 경로 전체에 반영·테스트 가능.
//   translation(번역)이 여기서 빠지면 편집 저장 때 번역이 통째로 날아간다(과거 버그).
import { EMOTIONS, type DialogueBubble } from "./types";

const EMOTION_IDS = new Set(EMOTIONS.map((e) => e.id));

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
