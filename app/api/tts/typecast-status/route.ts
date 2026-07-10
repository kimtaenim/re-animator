import { NextResponse } from "next/server";

export const runtime = "nodejs";

// GET — Typecast 구독(플랜·크레딧) 조회. "API 사용이 유료/활성인지"를 콘솔 안 뒤지고 바로 확인.
// GET https://api.typecast.ai/v1/users/me/subscription, X-API-KEY. 응답 { plan, credits{plan_credits,used_credits}, limits }.
// Typecast 가 막으면(예: UNUSUAL_ACTIVITY) 그 메시지를 그대로 보여줘 원인 판별에 쓴다.
export async function GET() {
  const key = process.env.TYPECAST_API_KEY;
  if (!key) {
    return NextResponse.json({ ok: false, error: "TYPECAST_API_KEY 미설정(Vercel 환경변수)" });
  }
  try {
    const r = await fetch("https://api.typecast.ai/v1/users/me/subscription", {
      headers: { "X-API-KEY": key },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    if (!r.ok) {
      return NextResponse.json({ ok: false, status: r.status, error: text.slice(0, 400) });
    }
    let d: { plan?: string; credits?: { plan_credits?: number; used_credits?: number }; limits?: unknown } = {};
    try {
      d = JSON.parse(text);
    } catch {
      /* 비 JSON */
    }
    return NextResponse.json({
      ok: true,
      plan: d.plan ?? "(알 수 없음)",
      planCredits: d.credits?.plan_credits ?? null,
      usedCredits: d.credits?.used_credits ?? null,
      limits: d.limits ?? null,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "조회 실패" });
  }
}
