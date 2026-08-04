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

// ★줄 단위 실제 언어 감지 — 일본어판 안에 '영어로 말하는 줄'(원작이 영어 대사·번역이 영어 유지)이
//   있으면 그 줄만 영어로 읽어야 한다. 예전엔 작업 언어를 전 줄에 강제해(Typecast language=jpn)
//   영어 텍스트 줄이 실패하거나 발음이 뭉개졌고, 실패한 줄은 소리 없이 남았다
//   (사용자 보고: "일본어 하다가 중간에 영어 하는 부분이 소리가 아예 안 들어가 있다").
//   확실한 문자 근거가 있을 때만 바꾼다: 가나→ja, 한글 우세→ko, CJK·한글이 전혀 없고 라틴 우세→en.
//   한자만 있는 줄(ja 한자 표기/zh 모호)·기호뿐인 줄은 주어진 언어 유지.
//   ★원어판(lang="")은 손대지 않는다 — 기존 동작 유지(회귀 금지).
export function effectiveTtsLang(text, lang = "") {
  if (!lang) return lang; // 원어판: 기존 동작 그대로
  const t = String(text || "");
  const kana = (t.match(/[぀-ヿ]/g) || []).length; // 히라가나·가타카나
  const hangul = (t.match(/\p{Script=Hangul}/gu) || []).length;
  const han = (t.match(/\p{Script=Han}/gu) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  if (kana > 0) return "ja"; // 가나가 하나라도 있으면 일본어 문장(영단어 섞여도 ja 로 읽음)
  if (hangul > 0 && hangul >= latin) return "ko";
  if (han > 0) return lang; // 한자만: ja(한자 표기)/zh 모호 — 주어진 언어 유지
  if (latin > 0) return "en"; // CJK·한글 없이 라틴 문자뿐 = 영어 대사 줄
  return lang; // 기호·숫자뿐 — 주어진 언어 유지
}

// { buf, ext, contentType } 반환. text 는 1~2000자.
// 스마트(둥근) 따옴표를 straight 로 정규화 — 일부 TTS 가 특수 문자에서 실패하는 걸 방어.
// speed = 말 속도 배수(1=기본, 1.2=조금 빠르게). Typecast=audio_tempo, ElevenLabs=voice_settings.speed.
// emotion = 감정 연기 id(EMOTION_TAGS) — ElevenLabs 에만 [태그] 로 전달(과장 연기).
// lang = 작업 언어 코드(§10): ""=원어(한국어 웹툰 기본), "ja"=일본어, "en"=영어 …
//   ★없으면 예전처럼 한국어. 이게 없어서 Typecast 가 늘 'kor' 로 고정돼, 일본어·영어 더빙이
//   한국어 발음으로 뭉개졌다(사용자 지적).
export async function synthesize(provider, voiceId, text, speed = 1, emotion = "", lang = "") {
  const t = stripMarks(String(text || "")) // 자막 강조 마커 [[..]] 는 읽지 않는다
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .trim()
    .slice(0, 1900);
  if (!t) throw new Error("빈 텍스트");
  if (!voiceId) throw new Error("voice_id 없음");
  const sp = Math.max(0.5, Math.min(2, Number(speed) || 1));
  const el = effectiveTtsLang(t, lang); // ★줄의 실제 문자로 언어 보정(영어 대사 줄 무음 방지)
  if (provider === "typecast") return synthTypecast(voiceId, t, sp, el);
  return synthEleven(voiceId, t, sp, EMOTION_TAGS[emotion], el);
}

// 작업 언어(§10) → Typecast language 코드. 미지정·미지원이면 kor(기존 동작).
const TYPECAST_LANG = { "": "kor", ko: "kor", ja: "jpn", en: "eng", zh: "zho", es: "spa" };
// 작업 언어 → ElevenLabs ISO-639-1(멀티링구얼/터보 모델에서 발음 언어 강제). v3 는 자동감지라
// 생략 가능하나, 힌트를 주면 짧은 대사의 오검출을 줄인다.
const ELEVEN_LANG = { "": "", ko: "ko", ja: "ja", en: "en", zh: "zh", es: "es" };

async function synthTypecast(voiceId, text, speed, lang = "") {
  const key = TC_KEY();
  if (!key) throw new Error("TYPECAST_API_KEY 미설정");
  const r = await fetch("https://api.typecast.ai/v1/text-to-speech", {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-KEY": key },
    body: JSON.stringify({
      voice_id: voiceId,
      text,
      model: "ssfm-v30",
      language: TYPECAST_LANG[lang] || "kor", // ★작업 언어 반영(예전엔 kor 고정)
      output: { audio_format: "wav", audio_tempo: speed }, // 0.5~2.0
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`Typecast ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return { buf: Buffer.from(await r.arrayBuffer()), ext: "wav", contentType: "audio/wav" };
}

async function synthEleven(voiceId, text, speed, emotionTag, lang = "") {
  const key = EL_KEY();
  if (!key) throw new Error("ELEVENLABS_API_KEY 미설정");
  // ★기본 모델을 표현력 특화 eleven_v3 로 — 오디오 태그([shouting] 등)로 과장 연기.
  //   문제 생기면 env ELEVEN_TTS_MODEL=eleven_multilingual_v2 로 즉시 롤백 가능.
  //   ★다국어 더빙은 ElevenLabs 권장(사용자 지정) — v3·multilingual_v2 둘 다 멀티링구얼이라
  //   일본어·영어 텍스트를 그 언어 발음으로 읽는다(배역 목소리도 멀티링구얼이어야 함).
  const model = process.env.ELEVEN_TTS_MODEL || "eleven_v3";
  const isV3 = model.startsWith("eleven_v3");
  // 감정 태그는 텍스트 앞에 인라인 — 자막에는 안 나감(더빙 텍스트에만 여기서 붙임).
  const t = emotionTag ? `[${emotionTag}] ${text}` : text;
  const body = { text: t, model_id: model };
  // 언어 힌트 — 짧은 대사의 언어 오검출을 줄인다. v3 는 자동감지가 좋아 생략 가능하나,
  // multilingual_v2/turbo 계열은 language_code 로 발음 언어를 못박을 수 있다.
  const lc = ELEVEN_LANG[lang];
  if (lc && !isV3) body.language_code = lc;
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
