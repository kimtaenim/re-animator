import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";

export const runtime = "nodejs";

// POST {projectId, sceneId, dir} — 컷을 앞(prev)/뒤(next) 이웃과 합병. regen 진행 표시.
export async function POST(req: NextRequest) {
  let body: { projectId?: string; sceneId?: string; dir?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  const sceneId = (body.sceneId ?? "").trim();
  const dir = body.dir === "prev" ? "prev" : "next";
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
    type: "mergecut",
    projectId,
    payload: { sceneId, dir },
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);
  setStep(project, "regen", { status: "running", jobId: job.id, error: undefined });
  await saveProject(project);
  return NextResponse.json({ ok: true, jobId: job.id });
}
