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
export const CAMERA_PROMPTS = {
  "crash-in":
    "CRASH ZOOM IN: the camera creeps forward very slowly, then suddenly ACCELERATES and slams toward the subject at high speed — an explosive speed ramp ending in a tight dramatic close-up. Large, fast frame movement is intended.",
  "crash-out":
    "CRASH ZOOM OUT: the camera explosively pulls far away from the subject in one fast continuous motion, revealing the whole scene — the frame changes dramatically from close-up to wide.",
  "speed-ramp":
    "SPEED RAMP: dreamy slow motion at first, then the camera suddenly rushes toward the subject with rapidly increasing speed — music-video energy, big frame change.",
  vertigo:
    "DOLLY ZOOM (vertigo effect): the camera pushes in while the lens zooms out — the subject stays the same size while the background stretches and warps dramatically around them.",
  "whip-pan":
    "WHIP PAN: the camera whips sideways extremely fast with heavy motion blur streaks, then snaps to a stop on the subject.",
  "orbit-180":
    "FAST ORBIT: the camera sweeps a fast 180-degree arc around the subject with motion blur, showy and dynamic.",
  "orbit-120":
    "ELEGANT ORBIT: the camera glides smoothly in a wide 120-degree arc around the subject, slow and luxurious like a high-end commercial.",
  "orbit-spin":
    "ENDLESS SPIN: the camera keeps circling around the subject continuously without stopping, hypnotic and stylish.",
  "impact-shake":
    "IMPACT SHAKE: a sudden violent camera shake like a shockwave hit — hard jolt, quick rattling decay, then still.",
  // 완급 조절용 — '의도된 정적/느림'(앨범 커버 프레임 톤).
  static:
    "DELIBERATE STATIC SHOT: locked-off camera, completely still framing like a striking album-cover frame — only subtle ambient motion (drifting particles, hair, cloth, flickering light). The stillness is intentional and stylish.",
  "slow-in":
    "SLOW CINEMATIC PUSH-IN: the camera glides forward very slowly and steadily toward the subject, calm and controlled, building quiet tension — smooth and elegant, no sudden speed changes.",
};
const CAMERA_IDS = [...Object.keys(CAMERA_PROMPTS), "none"];
const EMOTION_IDS = ["shout", "angry", "cry", "whisper", "laugh", "shock", "excited", "sigh", "none"];

// 구조화 출력 스키마 — 카메라 1개 + 줄별 감정.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["camera", "emotions"],
  properties: {
    camera: { type: "string", enum: CAMERA_IDS },
    emotions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "emotion"],
        properties: {
          index: { type: "integer" },
          emotion: { type: "string", enum: EMOTION_IDS },
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

// 한 컷 연출: png(컷 이미지 버퍼)+cut → { camera, emotions, costUsd } 또는 null(스킵/실패).
// lines = 감정 대상 줄들 [{ index, speaker, text }] (효과음 제외, 호출측이 구성).
export async function directCut(png, cut, lines) {
  const client = await getClient();
  if (!client) return null;
  try {
    // 이미지 축소(폭 512 jpeg) — 토큰·비용 절감, 연출 판단엔 충분.
    const img = await sharp(png).resize({ width: 512, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
    const lineDesc = lines.length
      ? lines.map((l) => `${l.index}. [${l.speaker}] ${l.text}`).join("\n")
      : "(no dialogue lines)";
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
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
                `For this cut (type: ${cut?.type ?? "unknown"}), pick the single most fitting EXAGGERATED cliché camera move, ` +
                `and for each dialogue line pick an exaggerated voice-acting emotion.\n\n` +
                `Camera options: crash-in (slow creep then explosive zoom in), crash-out (explosive pull-back reveal), ` +
                `speed-ramp (slow-motion bursting into a rush), vertigo (dolly-zoom background warp), whip-pan, ` +
                `orbit-180 (fast half orbit), orbit-120 (slow elegant orbit), orbit-spin (endless spinning), ` +
                `impact-shake (shockwave hit), static (deliberate album-cover stillness), slow-in (slow elegant push-in). ` +
                `Use "none" only when the cut is pure text/UI.\n` +
                `Prefer BOLD dramatic choices, but VARY THE RHYTHM — a music video alternates fast and slow: ` +
                `impact-shake for hits/surprise, crash-in for reveals/declarations, vertigo for dread, orbit for ` +
                `showcase moments, static/slow-in for quiet, emotional or lingering beats (do not make every cut fast).\n\n` +
                `Dialogue lines (index. [speaker] text):\n${lineDesc}\n\n` +
                `Emotion options: shout, angry, cry, whisper, laugh, shock, excited, sigh. ` +
                `Use "none" for flat informational lines. Prefer expressive choices when the text has any charge ` +
                `(exclamation marks, ellipses, interjections). Return one entry per dialogue line index.`,
            },
          ],
        },
      ],
    });
    if (res.stop_reason === "refusal") return null;
    const out = res.parsed_output ?? JSON.parse(res.content.find((b) => b.type === "text")?.text ?? "{}");
    const costUsd = (res.usage?.input_tokens ?? 0) * IN_USD + (res.usage?.output_tokens ?? 0) * OUT_USD;
    if (!out || !CAMERA_IDS.includes(out.camera)) return null;
    return { camera: out.camera, emotions: Array.isArray(out.emotions) ? out.emotions : [], costUsd };
  } catch (e) {
    // 연출 실패는 추출을 막지 않는다 — 호출측이 로그.
    throw new Error(`AI 연출 실패: ${String(e?.message ?? e).slice(0, 120)}`);
  }
}
