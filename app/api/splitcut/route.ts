import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";

export const runtime = "nodejs";

// POST {projectId, sceneId} — 이후 단계에서 컷 하나를 분할(서브컷 추출+글씨읽기까지).
// regen 단계 running 으로 표시 → M3 폴링이 진행/결과를 받아온다(화면 안 벗어남).
export async function POST(req: NextRequest) {
  let body: { projectId?: string; sceneId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  const sceneId = (body.sceneId ?? "").trim();
  if (!projectId || !sceneId) {
    return NextResponse.json({ ok: false, error: "projectId·sceneId 필요" }, { status: 400 });
  }
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  if (!project.scenes.some((s) => s.id === sceneId)) {
    return NextResponse.json({ ok: false, error: "컷 없음" }, { status: 404 });
  }

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "splitcut",
    projectId,
    payload: { sceneId },
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);
  setStep(project, "regen", { status: "running", jobId: job.id, error: undefined });
  await saveProject(project);
  return NextResponse.json({ ok: true, jobId: job.id });
}
