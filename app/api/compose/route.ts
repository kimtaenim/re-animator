import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";
import { getRedis } from "@/lib/redis";

export const runtime = "nodejs";

// POST — 5단계 합성(영상 이어붙이기) 잡 적재. 씬 영상이 하나라도 있어야.
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
  if (!project.scenes.some((s) => s.videoUrl)) {
    return NextResponse.json({ ok: false, error: "먼저 동영상을 생성하세요" }, { status: 409 });
  }

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "compose",
    projectId,
    payload: {},
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);
  setStep(project, "compose", { status: "running", jobId: job.id, error: undefined });
  await saveProject(project);
  return NextResponse.json({ ok: true, jobId: job.id });
}

// GET ?projectId — 합성 진행 + 최종 영상 URL + 진행 로그.
export async function GET(req: NextRequest) {
  const projectId = (req.nextUrl.searchParams.get("projectId") ?? "").trim();
  if (!projectId) return NextResponse.json({ ok: false, error: "projectId 필요" }, { status: 400 });
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  let progress = "";
  let progressLog: string[] = [];
  try {
    progressLog = (await getRedis().lrange<string>(`split:progress:${projectId}`, -30, -1)) ?? [];
    progress = progressLog[progressLog.length - 1] ?? "";
  } catch {
    /* best-effort */
  }
  return NextResponse.json({
    ok: true,
    status: project.steps.compose.status,
    error: project.steps.compose.error,
    composedUrl: project.composedUrl ?? null,
    progress,
    progressLog,
  });
}
