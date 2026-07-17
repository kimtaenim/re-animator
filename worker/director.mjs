// ============================================================================
// AI 연출(디렉터) — 컷 이미지+대사를 Claude 비전으로 읽고 '과장 카메라워크'와
// '줄별 감정 연기'의 디폴트를 채운다(사람이 하나하나 고르는 수고 제거).
// - 추출(runExtract)의 OCR 직후에 컷당 1회 호출. 사용자가 이미 지정한 값은 안 건드림.
// - ANTHROPIC_API_KEY 없으면 조용히 스킵(추출은 정상 진행).
// - 구조화 출력(output_config.format)로 JSON 보장 → 파싱 실패 없음.
// ============================================================================

import sharp from "sharp";

// 카메라 프리셋 — Studio CAMERA_MOVES 와 동기(id·영문 프롬프트 동일해야 함).
// ★"subject barely moves"류 정지 앵커 금지 — 과장 지시와 충돌해 밋밋하게 타협됨.
// ★시간 구조(느림/빠름 구간) 명시형 — Studio CAMERA_MOVES 와 문구 동일해야 함.
export const CAMERA_PROMPTS = {
  "crash-in":
    "Camera direction — CRASH ZOOM IN, two speeds only: for most of the clip the camera pushes in almost imperceptibly slowly; then at the very end it SNAPS forward in one instant burst to a tight dramatic close-up. The acceleration is sudden, not gradual.",
  "crash-out":
    "Camera direction — CRASH ZOOM OUT: hold a tight close-up almost still for a beat; then in one instant burst the camera snaps far back, revealing the whole scene. A single sudden burst, not a gradual pull.",
  "speed-ramp":
    "Camera direction — SPEED RAMP IN: the camera starts gliding forward very slowly, then smoothly but rapidly accelerates, arriving fast and close to the subject right at the end. One continuous accelerating move.",
  vertigo:
    "Camera direction — DOLLY ZOOM (vertigo): the camera slowly pushes in while the lens zooms out, so the subject stays the same size while the background stretches and warps. Slow, continuous, unsettling.",
  "whip-pan":
    "Camera direction — WHIP PAN: the camera holds still for a beat, then whips sideways extremely fast with motion blur and snaps to a stop. One single whip.",
  "orbit-180":
    "Camera direction — FAST ORBIT: the camera sweeps one fast 180-degree arc around the subject in a single smooth motion with slight motion blur.",
  "orbit-120":
    "Camera direction — ELEGANT ORBIT: the camera glides in a slow, smooth 120-degree arc around the subject, luxurious and steady like a high-end commercial.",
  "orbit-spin":
    "Camera direction — ENDLESS SPIN: the camera circles the subject continuously at a steady speed without stopping, hypnotic and stylish.",
  "impact-shake":
    "Camera direction — IMPACT SHAKE: one sudden violent jolt like a shockwave, a fast rattling decay within half a second, then completely still.",
  static:
    "Camera direction — DELIBERATE STATIC SHOT: locked-off camera, completely still framing like a striking album-cover frame — only subtle ambient motion (drifting particles, hair, cloth, flickering light).",
  "slow-in":
    "Camera direction — SLOW CINEMATIC PUSH-IN: the camera glides forward very slowly and steadily toward the subject, calm and controlled, no sudden speed changes.",
};
const CAMERA_IDS = [...Object.keys(CAMERA_PROMPTS), "none"];
const EMOTION_IDS = ["shout", "angry", "cry", "whisper", "laugh", "shock", "excited", "sigh", "none"];
// 컷 끝 전환 — lib/types CutOntology.transition · /api/cut 화이트리스트와 일치해야 함.
const TRANSITION_IDS = ["none", "fadeout", "fadein", "black", "dissolve"];
// 자막 세로 위치 — Studio SUB_Y(9분할 토글)와 동일 값이어야 자동값이 UI 하이라이트와 맞는다.
// 0.3=위, 0.5=가운데, 0.7=아래(가장자리 회피).
const SUBTITLE_Y = [0.3, 0.5, 0.7];

// 구조화 출력 스키마 — 풀 연출안: 카메라 + 컷길이 + 전환 + 인물동작(이어가기) + 줄별(감정·자막위치).
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["camera", "durationSec", "transition", "action", "emotions"],
  properties: {
    camera: { type: "string", enum: CAMERA_IDS },
    durationSec: { type: "number" }, // 이 컷 권장 길이(초)
    transition: { type: "string", enum: TRANSITION_IDS },
    action: { type: "string" }, // 인물/피사체 동작 — ★그림에 이미 있는 동작의 '이어가기'만. 없으면 빈 문자열.
    emotions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "emotion", "subtitleY"],
        properties: {
          index: { type: "integer" },
          emotion: { type: "string", enum: EMOTION_IDS },
          subtitleY: { type: "number", enum: SUBTITLE_Y }, // 이 줄 자막 세로 위치
        },
      },
    },
  },
};

let _client = null; // Anthropic SDK 클라이언트(lazy)
async function getClient() {
  if (_client !== null) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    _client = false;
    return _client;
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  _client = new Anthropic();
  return _client;
}

const MODEL = process.env.CLAUDE_DIRECTOR_MODEL || "claude-opus-4-8";
// Opus 4.8 $5/$25 per MTok — recordCost 용 개산.
const IN_USD = 5 / 1e6;
const OUT_USD = 25 / 1e6;

// 한 컷 연출: png(컷 이미지 버퍼)+cut → { camera, durationSec, transition, action, emotions, costUsd }
// 또는 null(스킵/실패). lines = 대상 줄들 [{ index, speaker, text, translation }] (효과음 제외, 호출측 구성).
// translation(있으면)을 함께 줘 '내용을 읽고' 연출하게 한다(외국어 원문만으론 뜻을 모름).
export async function directCut(png, cut, lines) {
  const client = await getClient();
  if (!client) return null;
  try {
    // 이미지 축소(폭 512 jpeg) — 토큰·비용 절감, 연출 판단엔 충분.
    const img = await sharp(png).resize({ width: 512, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
    const lineDesc = lines.length
      ? lines
          .map((l) => `${l.index}. [${l.speaker}] ${l.text}${l.translation ? ` (meaning: ${l.translation})` : ""}`)
          .join("\n")
      : "(no dialogue lines)";
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 900,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: img.toString("base64") } },
            {
              type: "text",
              text:
                `You are the director of a high-end music-video-style adaptation of a webtoon. ` +
                `READ the dialogue meaning and the image, then design the full shot for this cut (type: ${cut?.type ?? "unknown"}).\n\n` +
                `1) camera — pick the single most fitting EXAGGERATED cliché move. Options: ` +
                `crash-in (slow creep then explosive zoom in), crash-out (explosive pull-back reveal), ` +
                `speed-ramp (slow-motion bursting into a rush), vertigo (dolly-zoom background warp), whip-pan, ` +
                `orbit-180 (fast half orbit), orbit-120 (slow elegant orbit), orbit-spin (endless spinning), ` +
                `impact-shake (shockwave hit), static (deliberate album-cover stillness), slow-in (slow elegant push-in). ` +
                `Use "none" only when the cut is pure text/UI. ` +
                `Prefer BOLD choices but VARY THE RHYTHM — a music video alternates fast and slow: ` +
                `impact-shake for hits/surprise, crash-in for reveals/declarations, vertigo for dread, orbit for ` +
                `showcase moments, static/slow-in for quiet, emotional or lingering beats (do not make every cut fast).\n\n` +
                `2) durationSec — how long this cut should stay on screen (a number of seconds). ` +
                `Base it on the dialogue length (roughly enough time to read/speak it) and the beat: ` +
                `quick reaction 1-1.5s, a normal line 2-3s, a long or dramatic lingering beat up to 6-8s.\n\n` +
                `3) transition — the cut-END transition. Options: none (hard cut, the default for most cuts), ` +
                `fadeout (fade to black at the end, for a scene/chapter break), fadein, black, ` +
                `dissolve (soft cross-blend, for a time skip or dreamy shift). Use "none" unless a break is clearly called for.\n\n` +
                `4) action — ★STRICT RULE★: describe ONLY the continuation of an action ALREADY visibly happening in the still ` +
                `(e.g. "the man keeps walking forward", "her hair keeps blowing"). If nothing is clearly mid-action, return "". ` +
                `NEVER invent a new action, gesture, or movement that is not already depicted — that ruins the shot. Keep it one short clause.\n\n` +
                `Dialogue lines (index. [speaker] text (meaning)):\n${lineDesc}\n\n` +
                `5) For EACH dialogue line return: emotion — an exaggerated voice-acting emotion from ` +
                `shout, angry, cry, whisper, laugh, shock, excited, sigh, or "none" for flat informational lines ` +
                `(prefer expressive when the meaning has charge). ` +
                `subtitleY — where to place that line's subtitle vertically so it does NOT cover the speaker's face/mouth: ` +
                `0.3 = top, 0.5 = middle, 0.7 = bottom (prefer 0.7/bottom by default; use 0.3/top only if the lower area holds the face). ` +
                `Return one entry per dialogue line index.`,
            },
          ],
        },
      ],
    });
    if (res.stop_reason === "refusal") return null;
    const out = res.parsed_output ?? JSON.parse(res.content.find((b) => b.type === "text")?.text ?? "{}");
    const costUsd = (res.usage?.input_tokens ?? 0) * IN_USD + (res.usage?.output_tokens ?? 0) * OUT_USD;
    if (!out || !CAMERA_IDS.includes(out.camera)) return null;
    const dur = Number(out.durationSec);
    return {
      camera: out.camera,
      durationSec: Number.isFinite(dur) && dur > 0 ? Math.max(0.5, Math.min(15, Math.round(dur * 2) / 2)) : null,
      transition: TRANSITION_IDS.includes(out.transition) ? out.transition : "none",
      action: typeof out.action === "string" ? out.action.trim().slice(0, 200) : "",
      emotions: Array.isArray(out.emotions) ? out.emotions : [],
      costUsd,
    };
  } catch (e) {
    // 연출 실패는 추출을 막지 않는다 — 호출측이 로그.
    throw new Error(`AI 연출 실패: ${String(e?.message ?? e).slice(0, 120)}`);
  }
}
