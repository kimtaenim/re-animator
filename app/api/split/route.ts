import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";
import { getRedis } from "@/lib/redis";

export const runtime = "nodejs";

// POST — 컷 분할 잡을 워커 큐에 적재. 무거운 픽셀 연산은 워커가.
export async function POST(req: NextRequest) {
  let body: { projectId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "projectId 필요" }, { status: 400 });
  }
  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  }
  if (project.sourceFiles.length === 0) {
    return NextResponse.json(
      { ok: false, error: "소스 이미지를 먼저 업로드하세요" },
      { status: 409 }
    );
  }

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "split",
    projectId,
    payload: {},
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);

  setStep(project, "source", { status: "running", jobId: job.id, error: undefined });
  await saveProject(project);

  return NextResponse.json({ ok: true, jobId: job.id });
}

// GET ?projectId — 분할 진행 상태 + 워커 진행 로그 마지막 줄.
export async function GET(req: NextRequest) {
  const projectId = (req.nextUrl.searchParams.get("projectId") ?? "").trim();
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "projectId 필요" }, { status: 400 });
  }
  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  }
  let progress = "";
  try {
    const lines = await getRedis().lrange<string>(`split:progress:${projectId}`, -1, -1);
    progress = lines?.[0] ?? "";
  } catch {
    /* best-effort */
  }
  return NextResponse.json({
    ok: true,
    status: project.steps.source.status,
    error: project.steps.source.error,
    sceneCount: project.scenes.length,
    virtualCanvas: project.virtualCanvas,
    scenes: project.scenes,
    progress,
  });
}
