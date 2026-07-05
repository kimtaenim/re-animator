import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";
import { getRedis } from "@/lib/redis";
import { type Character } from "@/lib/types";

export const runtime = "nodejs";

// POST — M2 캐스팅 잡 적재(인물 구분). 1단계(source) 승인 후 가능.
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
  if (project.steps.source.status !== "approved") {
    return NextResponse.json({ ok: false, error: "1단계(컷) 확정 먼저 하세요" }, { status: 409 });
  }

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "cast",
    projectId,
    payload: {},
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);
  setStep(project, "cast", { status: "running", jobId: job.id, error: undefined });
  await saveProject(project);
  return NextResponse.json({ ok: true, jobId: job.id });
}

// GET ?projectId — 캐스팅 진행 상태 + 캐스트 + 진행 로그.
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
    status: project.steps.cast.status,
    error: project.steps.cast.error,
    cast: project.cast ?? [],
    scenes: project.scenes,
    progress,
    progressLog,
  });
}

// PUT — 사람이 편집한 캐스트 저장(+ approve 시 확정). 최소 검증.
export async function PUT(req: NextRequest) {
  let body: { projectId?: string; cast?: unknown; approve?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  if (!projectId || !Array.isArray(body.cast)) {
    return NextResponse.json({ ok: false, error: "projectId·cast 필요" }, { status: 400 });
  }
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });

  const validIds = new Set(project.scenes.map((s) => s.id));
  const clean: Character[] = [];
  let idx = 0;
  for (const raw of body.cast as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const sceneIds = Array.isArray(r.sceneIds)
      ? [...new Set(r.sceneIds.map(String).filter((id) => validIds.has(id)))]
      : [];
    if (sceneIds.length === 0) continue;
    idx++;
    const refSceneId =
      typeof r.refSceneId === "string" && sceneIds.includes(r.refSceneId)
        ? r.refSceneId
        : sceneIds[0];
    clean.push({
      id: typeof r.id === "string" ? r.id : `char-${idx}`,
      label: typeof r.label === "string" && r.label.trim() ? r.label.slice(0, 40) : `캐릭터 ${idx}`,
      description: typeof r.description === "string" ? r.description.slice(0, 200) : "",
      refSceneId,
      sceneIds,
    });
  }

  project.cast = clean;
  setStep(project, "cast", {
    status: body.approve ? "approved" : "review",
    error: undefined,
  });
  await saveProject(project);
  return NextResponse.json({ ok: true, cast: clean, status: project.steps.cast.status });
}
