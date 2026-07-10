// ============================================================================
// TTS 합성 — 더빙용. provider(typecast|eleven) + voice_id + 텍스트 → 오디오 버퍼.
// ----------------------------------------------------------------------------
// Typecast: POST /v1/text-to-speech, X-API-KEY, wav. ElevenLabs: /v1/text-to-speech/{id}, xi-api-key, mp3.
// 키는 워커 env(TYPECAST_API_KEY / ELEVENLABS_API_KEY). 실패 시 에러 throw(호출측이 컷 로그).
// ============================================================================

const TC_KEY = () => process.env.TYPECAST_API_KEY;
const EL_KEY = () => process.env.ELEVENLABS_API_KEY;

// { buf, ext, contentType } 반환. text 는 1~2000자.
export async function synthesize(provider, voiceId, text) {
  const t = String(text || "").trim().slice(0, 1900);
  if (!t) throw new Error("빈 텍스트");
  if (!voiceId) throw new Error("voice_id 없음");
  if (provider === "typecast") return synthTypecast(voiceId, t);
  return synthEleven(voiceId, t);
}

async function synthTypecast(voiceId, text) {
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
      output: { audio_format: "wav" },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`Typecast ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return { buf: Buffer.from(await r.arrayBuffer()), ext: "wav", contentType: "audio/wav" };
}

async function synthEleven(voiceId, text) {
  const key = EL_KEY();
  if (!key) throw new Error("ELEVENLABS_API_KEY 미설정");
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": key },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return { buf: Buffer.from(await r.arrayBuffer()), ext: "mp3", contentType: "audio/mpeg" };
}
