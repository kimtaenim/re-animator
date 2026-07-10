import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";
import { getRedis } from "@/lib/redis";

export const runtime = "nodejs";

// POST — M6 더빙(TTS) 잡 적재. 대사(화자 목소리)·내레이션(나레이터 목소리)을 오디오로.
export async function POST(req: NextRequest) {
  let body: { projectId?: string; sceneIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  if (!projectId) return NextResponse.json({ ok: false, error: "projectId 필요" }, { status: 400 });
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });

  const sceneIds = Array.isArray(body.sceneIds)
    ? body.sceneIds.filter((id) => typeof id === "string")
    : undefined;
  const payload: Record<string, unknown> = {};
  if (sceneIds && sceneIds.length) payload.sceneIds = sceneIds;
  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "dub",
    projectId,
    payload,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);
  setStep(project, "scene", { status: "running", jobId: job.id, error: undefined });
  await saveProject(project);
  return NextResponse.json({ ok: true, jobId: job.id });
}

// GET ?projectId — 더빙 진행 + 씬(오디오 URL 포함) + 진행 로그. (video 와 같은 scene 단계 공유)
export async function GET(req: NextRequest) {
  const projectId = (req.nextUrl.searchParams.get("projectId") ?? "").trim();
  if (!projectId) return NextResponse.json({ ok: false, error: "projectId 필요" }, { status: 400 });
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  let progressLog: string[] = [];
  try {
    progressLog = (await getRedis().lrange<string>(`split:progress:${projectId}`, -30, -1)) ?? [];
  } catch {
    /* best-effort */
  }
  return NextResponse.json({
    ok: true,
    status: project.steps.scene.status,
    error: project.steps.scene.error,
    scenes: project.scenes,
    progress: progressLog[progressLog.length - 1] ?? "",
    progressLog,
  });
}
