import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getRedis } from "@/lib/redis";
import { getProject } from "@/lib/projectStore";
import { enqueueJob, getJob, type Job } from "@/lib/jobQueue";

export const runtime = "nodejs";

// POST {projectId} — 대상 언어 번역만 다시 실행(재추출 없이).
// 다국어 번역은 원래 추출 잡 안에서만 돌아서, 이미 추출한 프로젝트에서 🌐 대상 언어를
// 켜면 tracks 가 영영 비어 있었다. 이 잡은 텍스트만 다루므로 싸고 빠르다.
export async function POST(req: NextRequest) {
  let body: { projectId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  if (!projectId) return NextResponse.json({ ok: false, error: "projectId 필요" }, { status: 400 });

  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  if (!(project.scenes ?? []).length) {
    return NextResponse.json({ ok: false, error: "컷이 없어요 — 분할·추출 먼저" }, { status: 409 });
  }
  if (!(project.targetLanguages ?? []).length) {
    return NextResponse.json(
      { ok: false, error: "🌐 대상 언어에서 일본어·영어를 먼저 켜주세요" },
      { status: 409 }
    );
  }

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "translate",
    projectId,
    payload: {},
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);
  // ★단계(step) 상태는 건드리지 않는다 — 번역은 어느 단계에도 속하지 않는 부가 작업이라,
  //   running 으로 박으면 해당 단계 UI 가 잠기고 워커가 안 풀어주는 유령 진행이 된다(과거 사고).
  return NextResponse.json({ ok: true, jobId: job.id });
}

// GET ?jobId= — 진행 상태·로그(번역은 단계가 없어 잡 단위로 추적).
export async function GET(req: NextRequest) {
  const jobId = (req.nextUrl.searchParams.get("jobId") ?? "").trim();
  const projectId = (req.nextUrl.searchParams.get("projectId") ?? "").trim();
  if (!jobId) return NextResponse.json({ ok: false, error: "jobId 필요" }, { status: 400 });
  const job = await getJob(jobId);
  let progressLog: string[] = [];
  try {
    if (projectId) {
      progressLog = (await getRedis().lrange<string>(`split:progress:${projectId}`, -120, -1)) ?? [];
    }
  } catch {
    /* best-effort */
  }
  return NextResponse.json({
    ok: true,
    status: job?.status ?? "done",
    error: job?.error,
    progress: progressLog[progressLog.length - 1] ?? "",
    progressLog,
  });
}
