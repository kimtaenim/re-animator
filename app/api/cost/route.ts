import { NextRequest, NextResponse } from "next/server";
import { totalCostUsd, usdToKrw } from "@/lib/cost";

export const runtime = "nodejs";

// GET ?projectId — 누적 API 비용(USD·₩). 환율 1500원.
export async function GET(req: NextRequest) {
  const projectId = (req.nextUrl.searchParams.get("projectId") ?? "").trim() || undefined;
  let usd = 0;
  try {
    usd = await totalCostUsd(projectId);
  } catch {
    /* best-effort */
  }
  return NextResponse.json({ ok: true, usd, krw: usdToKrw(usd) });
}
