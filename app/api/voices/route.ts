import { NextResponse } from "next/server";

export const runtime = "nodejs";

// GET — Typecast 목소리 목록 프록시. 캐스팅에서 캐릭터별 목소리 선택용.
// 인증: X-API-KEY(키를 값 그대로). base https://api.typecast.ai, GET /v2/voices.
// TYPECAST_API_KEY 없으면 빈 목록 + note(프론트는 수동 입력으로 폴백).
export async function GET() {
  const key = process.env.TYPECAST_API_KEY;
  if (!key) {
    return NextResponse.json({ ok: true, voices: [], note: "TYPECAST_API_KEY 미설정" });
  }
  try {
    const r = await fetch("https://api.typecast.ai/v2/voices", {
      headers: { "X-API-KEY": key },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, error: `Typecast ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}` },
        { status: 502 }
      );
    }
    const d = await r.json();
    // 응답이 배열이거나 { voices:[…] } / { results:[…] } 일 수 있어 방어적으로 정규화.
    const raw: unknown[] = Array.isArray(d) ? d : (d.voices ?? d.results ?? d.data ?? []);
    const voices: { id: string; name: string; language: string; emotions?: string[] }[] = [];
    for (const v of raw) {
      const o = (v ?? {}) as Record<string, unknown>;
      const id = (o.voice_id ?? o.id) as string | undefined;
      if (!id) continue;
      const name = (o.voice_name ?? o.name ?? id) as string;
      const language = (o.language ?? o.lang ?? "") as string;
      const emotions = Array.isArray(o.emotions) ? (o.emotions as unknown[]).map(String) : undefined;
      voices.push({ id, name, language, emotions });
    }
    return NextResponse.json({ ok: true, voices });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "voices 조회 실패" },
      { status: 500 }
    );
  }
}
