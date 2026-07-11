// ============================================================================
// TTS 합성 — 더빙용. provider(typecast|eleven) + voice_id + 텍스트 → 오디오 버퍼.
// ----------------------------------------------------------------------------
// Typecast: POST /v1/text-to-speech, X-API-KEY, wav. ElevenLabs: /v1/text-to-speech/{id}, xi-api-key, mp3.
// 키는 워커 env(TYPECAST_API_KEY / ELEVENLABS_API_KEY). 실패 시 에러 throw(호출측이 컷 로그).
// ============================================================================

import { stripMarks } from "./emphasis.mjs";

const TC_KEY = () => process.env.TYPECAST_API_KEY;
const EL_KEY = () => process.env.ELEVENLABS_API_KEY;

// 감정 id → ElevenLabs v3 오디오 태그(lib/types EMOTIONS 와 동기). Typecast 는 태그 미지원 → 무시.
const EMOTION_TAGS = {
  shout: "shouting",
  angry: "angry",
  cry: "crying",
  whisper: "whispering",
  laugh: "laughing",
  shock: "shocked",
  excited: "excited",
  sigh: "sighs",
};

// { buf, ext, contentType } 반환. text 는 1~2000자.
// 스마트(둥근) 따옴표를 straight 로 정규화 — 일부 TTS 가 특수 문자에서 실패하는 걸 방어.
// speed = 말 속도 배수(1=기본, 1.2=조금 빠르게). Typecast=audio_tempo, ElevenLabs=voice_settings.speed.
// emotion = 감정 연기 id(EMOTION_TAGS) — ElevenLabs 에만 [태그] 로 전달(과장 연기).
export async function synthesize(provider, voiceId, text, speed = 1, emotion = "") {
  const t = stripMarks(String(text || "")) // 자막 강조 마커 [[..]] 는 읽지 않는다
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .trim()
    .slice(0, 1900);
  if (!t) throw new Error("빈 텍스트");
  if (!voiceId) throw new Error("voice_id 없음");
  const sp = Math.max(0.5, Math.min(2, Number(speed) || 1));
  if (provider === "typecast") return synthTypecast(voiceId, t, sp);
  return synthEleven(voiceId, t, sp, EMOTION_TAGS[emotion]);
}

async function synthTypecast(voiceId, text, speed) {
  const key = TC_KEY();
  if (!key) throw new Error("TYPECAST_API_KEY 미설정");
  const r = await fetch("https://api.typecast.ai/v1/text-to-speech", {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-KEY": key },
    body: JSON.stringify({
      voice_id: voiceId,
      text,
      model: "ssfm-v30",
      language: "kor",
      output: { audio_format: "wav", audio_tempo: speed }, // 0.5~2.0
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`Typecast ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return { buf: Buffer.from(await r.arrayBuffer()), ext: "wav", contentType: "audio/wav" };
}

async function synthEleven(voiceId, text, speed, emotionTag) {
  const key = EL_KEY();
  if (!key) throw new Error("ELEVENLABS_API_KEY 미설정");
  // ★기본 모델을 표현력 특화 eleven_v3 로 — 오디오 태그([shouting] 등)로 과장 연기.
  //   문제 생기면 env ELEVEN_TTS_MODEL=eleven_multilingual_v2 로 즉시 롤백 가능.
  const model = process.env.ELEVEN_TTS_MODEL || "eleven_v3";
  const isV3 = model.startsWith("eleven_v3");
  // 감정 태그는 텍스트 앞에 인라인 — 자막에는 안 나감(더빙 텍스트에만 여기서 붙임).
  const t = emotionTag ? `[${emotionTag}] ${text}` : text;
  const body = { text: t, model_id: model };
  // stability: v3 는 이산값(0=Creative 과장연기/0.5/1). v2 는 연속값 — 낮을수록 감정 기복 큼.
  const vs = { stability: isV3 ? Number(process.env.ELEVEN_STABILITY ?? 0) : 0.3 };
  if (!isV3) vs.style = 0.8; // v2 계열 폴백 시 스타일 과장(v3 는 미지원 파라미터라 제외)
  // ElevenLabs speed 는 voice_settings.speed(0.7~1.2). 1 이 아닐 때만 실어 보낸다.
  if (speed && speed !== 1) vs.speed = Math.max(0.7, Math.min(1.2, speed));
  body.voice_settings = vs;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000), // v3 는 v2 보다 느릴 수 있어 여유
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return { buf: Buffer.from(await r.arrayBuffer()), ext: "mp3", contentType: "audio/mpeg" };
}

// ElevenLabs Sound Effects — 영어 사운드 묘사(description) → 효과음 오디오(mp3).
// 효과음은 ElevenLabs 만 지원(Typecast 는 TTS 전용). durationSec 지정 가능(0.5~22s).
export async function synthSfx(description, durationSec) {
  const key = EL_KEY();
  if (!key) throw new Error("ELEVENLABS_API_KEY 미설정");
  const body = { text: String(description || "").slice(0, 200) };
  if (durationSec) body.duration_seconds = Math.max(0.5, Math.min(22, durationSec));
  const r = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`ElevenLabs SFX ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return { buf: Buffer.from(await r.arrayBuffer()), ext: "mp3", contentType: "audio/mpeg" };
}
