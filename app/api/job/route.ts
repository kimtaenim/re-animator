import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/jobQueue";
import { getRedis } from "@/lib/redis";

export const runtime = "nodejs";

// GET ?id= — 잡 상태 조회(queued/running/done/error) + 진행 로그. 더빙처럼 단계와 독립적으로
// 진행을 추적할 때 사용(동영상 생성과 병행 가능하게). progress 로 진행바·예상시간 표시.
export async function GET(req: NextRequest) {
  const id = (req.nextUrl.searchParams.get("id") ?? "").trim();
  if (!id) return NextResponse.json({ ok: false, error: "id 필요" }, { status: 400 });
  const job = await getJob(id);
  if (!job) return NextResponse.json({ ok: false, error: "잡 없음" }, { status: 404 });
  let progress = "";
  let progressLog: string[] = [];
  try {
    progressLog = (await getRedis().lrange<string>(`split:progress:${job.projectId}`, -30, -1)) ?? [];
    progress = progressLog[progressLog.length - 1] ?? "";
  } catch {
    /* best-effort */
  }
  return NextResponse.json({ ok: true, status: job.status, error: job.error, progress, progressLog });
}
