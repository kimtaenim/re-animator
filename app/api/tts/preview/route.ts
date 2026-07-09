import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// POST { provider, voiceId, text? } → 그 목소리로 짧은 샘플을 합성해 오디오 바이트로 반환(미리듣기).
// provider=typecast → TYPECAST_API_KEY, eleven → ELEVENLABS_API_KEY (비밀값, 생성 때만 사용).
// 카탈로그(config/voices.json)의 voice_id 로 캐스팅/나레이터 목소리를 귀로 확인하는 용도.
const SAMPLE = "우리가 살고 있는 세상에서, 이 이야기는 지금부터 시작됩니다.";

export async function POST(req: NextRequest) {
  let body: { provider?: string; voiceId?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const provider = (body.provider ?? "").trim();
  const voiceId = (body.voiceId ?? "").trim();
  const text = (typeof body.text === "string" && body.text.trim() ? body.text : SAMPLE).slice(0, 300);
  if (!voiceId) return NextResponse.json({ ok: false, error: "voiceId 필요" }, { status: 400 });

  try {
    if (provider === "typecast") {
      const key = process.env.TYPECAST_API_KEY;
      if (!key) return NextResponse.json({ ok: false, error: "TYPECAST_API_KEY 미설정" }, { status: 400 });
      const r = await fetch("https://api.typecast.ai/v1/text-to-speech", {
        method: "POST",
        headers: { "content-type": "application/json", "X-API-KEY": key },
        body: JSON.stringify({
          voice_id: voiceId,
          text,
          model: "ssfm-v30",
          language: "kor",
          output: { audio_format: "wav", tempo: 1 },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) {
        return NextResponse.json(
          { ok: false, error: `Typecast ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` },
          { status: 502 }
        );
      }
      const buf = Buffer.from(await r.arrayBuffer());
      return new Response(buf, { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
    }

    // ElevenLabs (기본)
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return NextResponse.json({ ok: false, error: "ELEVENLABS_API_KEY 미설정" }, { status: 400 });
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": key },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, error: `ElevenLabs ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` },
        { status: 502 }
      );
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return new Response(buf, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "미리듣기 실패" },
      { status: 500 }
    );
  }
}
