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
// ★I2V 프롬프트는 '엔진만 할 수 있는 무브'만 — 줌·셰이크 계열은 굽기(cameraWork)가 확정적으로
//   처리하므로 생성 프롬프트를 겹쳐 넣지 않는다(생성·굽기 중복 제거, 사용자 지시 2026-08-03).
//   크래시인/아웃·램프·임팩트·푸시인 id 는 아래 매핑으로 '굽기 프리셋'만 배정된다.
//   (🌀 vertigo 는 완전 폐기 — I2V 도 후처리도 실패, 다시 넣지 말 것.)
export const CAMERA_PROMPTS = {
  "whip-pan":
    "Camera direction — WHIP PAN: the camera holds still for a beat, then whips sideways extremely fast with motion blur and snaps to a stop. One single whip.",
  "orbit-180":
    "Camera direction — FAST ORBIT: the camera sweeps one fast 180-degree arc around the subject in a single smooth motion with slight motion blur.",
  "orbit-120":
    "Camera direction — ELEGANT ORBIT: the camera glides in a slow, smooth 120-degree arc around the subject, luxurious and steady like a high-end commercial.",
  "orbit-spin":
    "Camera direction — ENDLESS SPIN: the camera circles the subject continuously at a steady speed without stopping, hypnotic and stylish.",
  static:
    "Camera direction — DELIBERATE STATIC SHOT: locked-off camera, completely still framing like a striking album-cover frame — only subtle ambient motion (drifting particles, hair, cloth, flickering light).",
};
// ★★연출 카메라 id → 카메라워크 프리셋(스펙 §2) 매핑.
//   열흘간 "카메라 미리보기에 카메라워크가 안 보인다" 의 원인: AI 연출은 카메라를
//   cut.motion(영문 프롬프트 문자열)에만 넣었고, 미리보기·굽기는 cut.cameraWork(구조체)를
//   읽는다 → 두 필드가 연결돼 있지 않아 cameraWork 가 늘 비어 프리뷰가 정지였다.
//   여기서 연출 결정을 프리뷰·굽기가 쓰는 어휘로 변환한다.
export const DIRECTOR_CAMERA_TO_PRESET = {
  "crash-in": "crash_zoom",
  "crash-out": "pull_out",
  "speed-ramp": "push_in",
  "whip-pan": "whip",
  "orbit-180": "orbit",
  "orbit-120": "orbit",
  "orbit-spin": "orbit",
  "impact-shake": "shake",
  static: "static",
  "slow-in": "push_in",
};
// ★연출 어휘는 유지 — CAMERA_PROMPTS 에 없는 id(줌·셰이크 계열)는 굽기 프리셋으로만 배정된다.
const CAMERA_IDS = ["crash-in", "crash-out", "speed-ramp", "whip-pan", "orbit-180", "orbit-120", "orbit-spin", "impact-shake", "static", "slow-in", "none"];
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
                `speed-ramp (slow-motion bursting into a rush), whip-pan, ` +
                `orbit-180 (fast half orbit), orbit-120 (slow elegant orbit), orbit-spin (endless spinning), ` +
                `impact-shake (shockwave hit), static (deliberate album-cover stillness), slow-in (slow elegant push-in). ` +
                `Use "none" only when the cut is pure text/UI. ` +
                `Prefer BOLD choices but VARY THE RHYTHM — a music video alternates fast and slow: ` +
                `impact-shake for hits/surprise, crash-in for reveals/declarations, orbit for ` +
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
