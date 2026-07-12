// ============================================================================
// AI 연출(디렉터) — 컷 이미지+대사를 Claude 비전으로 읽고 '과장 카메라워크'와
// '줄별 감정 연기'의 디폴트를 채운다(사람이 하나하나 고르는 수고 제거).
// - 추출(runExtract)의 OCR 직후에 컷당 1회 호출. 사용자가 이미 지정한 값은 안 건드림.
// - ANTHROPIC_API_KEY 없으면 조용히 스킵(추출은 정상 진행).
// - 구조화 출력(output_config.format)로 JSON 보장 → 파싱 실패 없음.
// ============================================================================

import sharp from "sharp";

// 카메라 프리셋 — Studio CAMERA_MOVES 와 동기(id·영문 프롬프트 동일해야 함).
export const CAMERA_PROMPTS = {
  "crash-in":
    "Camera creeps forward slowly, then suddenly accelerates into a dramatic crash zoom slamming toward the subject — explosive speed ramp from very slow to very fast. Camera only; the subject barely moves.",
  "crash-out":
    "Camera suddenly whips backward in a dramatic crash zoom out, rapidly pulling far away to reveal the whole scene in one explosive motion. Camera only; the subject barely moves.",
  "speed-ramp":
    "Speed-ramped dolly-in: starts in dreamy slow motion, then bursts into a rapid accelerating rush toward the subject — cinematic action-movie energy. Camera only; the subject barely moves.",
  vertigo:
    "Extreme dolly zoom vertigo effect: aggressive dolly-in while zooming out, the background warping and stretching dramatically around the subject who stays the same size. Camera only.",
  "whip-pan":
    "Fast whip pan with heavy motion blur streaking across the scene, aggressive and energetic. Camera only; the subject stays mostly still.",
  "orbit-180":
    "Fast dramatic 180-degree orbit whipping around the subject with slight motion blur, dynamic and showy. Camera moves; the subject stays still.",
  "orbit-120":
    "Smooth elegant 120-degree orbit gliding around the subject, slow and cinematic like a luxury commercial. Camera moves; the subject stays still.",
  "orbit-spin":
    "Continuous spinning orbit circling around the subject without stopping, round and round in a stylish hypnotic loop. Camera moves; the subject stays still.",
  "impact-shake":
    "Sudden violent camera shake like a shockwave impact, then the camera quickly settles — punchy and dramatic. Camera only; the subject stays still.",
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
                `impact-shake (shockwave hit). Use "none" only when the cut is pure text/UI.\n` +
                `Prefer BOLD dramatic choices — match the cut's content and mood (impact-shake for hits/surprise, ` +
                `crash-in for reveals/declarations, vertigo for dread, orbit for showcase moments).\n\n` +
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
