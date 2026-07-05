import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";

export const runtime = "nodejs";

// POST — 한 컷(order)을 다시 분할하는 잡 적재. 사전에 경계 저장이 끝난 상태를 전제.
export async function POST(req: NextRequest) {
  let body: { projectId?: string; order?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  const order = Number(body.order);
  if (!projectId || !Number.isInteger(order) || order < 0) {
    return NextResponse.json({ ok: false, error: "projectId·order 필요" }, { status: 400 });
  }
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  if (!project.virtualCanvas) {
    return NextResponse.json({ ok: false, error: "분할 먼저 실행하세요" }, { status: 409 });
  }

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "resplit",
    projectId,
    payload: { order },
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);
  setStep(project, "source", { status: "running", jobId: job.id, error: undefined });
  await saveProject(project);
  return NextResponse.json({ ok: true, jobId: job.id });
}
