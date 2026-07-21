import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";
import { getRedis } from "@/lib/redis";

export const runtime = "nodejs";

// POST — 5단계 합성 잡 적재.
//   { projectId }                         → 전체 합성(기존).
//   { projectId, sceneIds, sectionKey }   → 섹션 부분 합성(방향 B) — 그 컷만 합성 → sectionVideos[key].
//   { projectId, mode: "join" }           → 섹션 합성본들을 최종 이어붙이기 → composedUrl.
export async function POST(req: NextRequest) {
  let body: { projectId?: string; sceneIds?: string[]; sectionKey?: number | string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  if (!projectId) return NextResponse.json({ ok: false, error: "projectId 필요" }, { status: 400 });
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });

  const mode = body.mode === "join" ? "join" : "compose";
  if (mode === "compose" && !project.scenes.some((s) => s.videoUrl)) {
    return NextResponse.json({ ok: false, error: "먼저 동영상을 생성하세요" }, { status: 409 });
  }
  const sceneIds = Array.isArray(body.sceneIds) ? body.sceneIds.filter((x): x is string => typeof x === "string") : null;
  const sectionKey = body.sectionKey != null ? String(body.sectionKey) : null;

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: mode === "join" ? "join" : "compose",
    projectId,
    payload: mode === "join" ? {} : { ...(sceneIds ? { sceneIds } : {}), ...(sectionKey ? { sectionKey } : {}) },
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);
  // 전체 합성·join 은 compose 스텝 running. 섹션 부분 합성은 스텝 안 건드림(잡 폴링으로 추적).
  if (mode === "join" || !sectionKey) {
    setStep(project, "compose", { status: "running", jobId: job.id, error: undefined });
    await saveProject(project);
  }
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
