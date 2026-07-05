import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/redis";
import { detectRegions } from "@/lib/detect";
import splitCfg from "@/config/split.json";

export const runtime = "nodejs";

// POST {projectId, region} — 저장된 행 프로파일로 그 컷만 즉시 재분할(워커·VLM 없음).
// 반환 subs: [{yStart,yEnd,xStart,xEnd}] — 클라가 로컬 regions 에 갈아끼운다.
export async function POST(req: NextRequest) {
  let body: {
    projectId?: string;
    region?: { yStart: number; yEnd: number; xStart?: number; xEnd?: number };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  const region = body.region;
  if (!projectId || !region) {
    return NextResponse.json({ ok: false, error: "projectId·region 필요" }, { status: 400 });
  }

  let b64: string | null = null;
  try {
    b64 = await getRedis().get<string>(`rowprofile:${projectId}`);
  } catch {
    /* below */
  }
  if (!b64) {
    return NextResponse.json(
      { ok: false, error: "프로파일 없음 — 전체 다시 분할이 필요해요" },
      { status: 409 }
    );
  }

  // base64 → 정렬된 Float32Array.
  const raw = Buffer.from(b64, "base64");
  const ab = new ArrayBuffer(raw.byteLength);
  new Uint8Array(ab).set(raw);
  const profile = new Float32Array(ab);

  const y0 = Math.max(0, Math.round(region.yStart));
  const y1 = Math.min(profile.length, Math.round(region.yEnd));
  if (y1 - y0 < 80) {
    return NextResponse.json({ ok: false, error: "너무 작아 분할 불가" }, { status: 400 });
  }

  const cfg2 = {
    flatStdThreshold: splitCfg.flatStdThreshold ?? 10,
    minGapPx: Math.max(10, Math.round((splitCfg.minGapPx ?? 40) / 2)),
    minSceneHeightPx: Math.max(30, Math.round((splitCfg.minSceneHeightPx ?? 60) / 2)),
  };
  let subs = detectRegions(profile.subarray(y0, y1), cfg2).map((r) => ({
    yStart: y0 + r.yStart,
    yEnd: y0 + r.yEnd,
  }));
  if (subs.length === 0) subs = [{ yStart: y0, yEnd: y1 }];

  // 여전히 1개면(거터 없음) 중앙 대역에서 가장 평탄한 행에서 강제 2분할.
  if (subs.length === 1 && subs[0].yEnd - subs[0].yStart >= 120) {
    const s = subs[0];
    const lo = s.yStart + Math.round((s.yEnd - s.yStart) * 0.3);
    const hi = s.yStart + Math.round((s.yEnd - s.yStart) * 0.7);
    let bestY = -1;
    let bestStd = Infinity;
    for (let y = lo; y < hi; y++) {
      if (profile[y] < bestStd) {
        bestStd = profile[y];
        bestY = y;
      }
    }
    if (bestY > s.yStart + 20 && bestY < s.yEnd - 20) {
      subs = [
        { yStart: s.yStart, yEnd: bestY },
        { yStart: bestY, yEnd: s.yEnd },
      ];
    }
  }

  // 대상의 x 범위 상속.
  const xStart = region.xStart;
  const xEnd = region.xEnd;
  const out = subs.map((s) => ({ yStart: s.yStart, yEnd: s.yEnd, xStart, xEnd }));
  return NextResponse.json({ ok: true, subs: out });
}
