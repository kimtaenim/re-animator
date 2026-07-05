import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";
import { getRedis } from "@/lib/redis";

export const runtime = "nodejs";

// POST — M4 영상(I2V) 잡 적재. 3단계(재생성) 이미지가 하나라도 있어야 가능.
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
  if (!project.scenes.some((s) => s.generatedImage)) {
    return NextResponse.json({ ok: false, error: "먼저 3단계에서 이미지를 생성하세요" }, { status: 409 });
  }

  const sceneIds = Array.isArray(body.sceneIds)
    ? body.sceneIds.filter((id) => typeof id === "string")
    : undefined;
  const payload: Record<string, unknown> = {};
  if (sceneIds && sceneIds.length) payload.sceneIds = sceneIds;
  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "video",
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

// GET ?projectId — 영상 진행 + 씬(videoUrl 포함) + 진행 로그.
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
    status: project.steps.scene.status,
    error: project.steps.scene.error,
    scenes: project.scenes,
    progress,
    progressLog,
  });
}
