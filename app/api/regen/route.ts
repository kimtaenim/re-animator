import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";
import { getRedis } from "@/lib/redis";

export const runtime = "nodejs";

// POST — M3 이미지 재생성 잡 적재. 1단계(컷 추출) 완료 후 가능.
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
  if (project.steps.source.status !== "approved") {
    return NextResponse.json({ ok: false, error: "1단계(컷 추출) 먼저 완료하세요" }, { status: 409 });
  }
  if (!project.scenes.some((s) => s.originalImage)) {
    return NextResponse.json({ ok: false, error: "추출된 컷이 없어요" }, { status: 409 });
  }

  const sceneIds = Array.isArray(body.sceneIds)
    ? body.sceneIds.filter((id) => typeof id === "string")
    : undefined;
  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "regen",
    projectId,
    payload: sceneIds && sceneIds.length ? { sceneIds } : {},
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);
  setStep(project, "regen", { status: "running", jobId: job.id, error: undefined });
  await saveProject(project);
  return NextResponse.json({ ok: true, jobId: job.id });
}

// GET ?projectId — 재생성 진행 + 씬(생성이미지 포함) + 진행 로그.
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
    status: project.steps.regen.status,
    error: project.steps.regen.error,
    scenes: project.scenes,
    progress,
    progressLog,
  });
}
