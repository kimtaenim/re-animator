import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";

export const runtime = "nodejs";

// POST {projectId, targetCount?} — 컷들을 서사 시퀀스로 자동 묶는 잡 적재(워커가 Claude 로 경계 산출 →
// project.sectionStarts 갱신). 텍스트만 쓰므로 저렴·빠름. 결과는 프로젝트 폴링/재읽기로 반영.
export async function POST(req: NextRequest) {
  let body: { projectId?: string; targetCount?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  if (!projectId) return NextResponse.json({ ok: false, error: "projectId 필요" }, { status: 400 });
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });

  const now = Date.now();
  const target = typeof body.targetCount === "number" && body.targetCount > 1 ? Math.floor(body.targetCount) : undefined;
  const job: Job = {
    id: randomUUID(),
    type: "sequence",
    projectId,
    payload: target ? { targetCount: target } : {},
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);
  return NextResponse.json({ ok: true, jobId: job.id });
}
