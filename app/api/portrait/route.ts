import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";

export const runtime = "nodejs";

// POST {projectId, charId, prompt?} — 캐릭터 실사 초상 생성 잡 적재(캐스팅 얼굴 고정용).
// cast 단계 상태는 안 건드림 — 앱이 /api/cast(GET)로 cast 를 폴링해 realImage 반영.
export async function POST(req: NextRequest) {
  let body: { projectId?: string; charId?: string; prompt?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  const charId = (body.charId ?? "").trim();
  if (!projectId || !charId) {
    return NextResponse.json({ ok: false, error: "projectId·charId 필요" }, { status: 400 });
  }
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  const ch = (project.cast ?? []).find((c) => c.id === charId);
  if (!ch) return NextResponse.json({ ok: false, error: "캐릭터 없음" }, { status: 404 });

  // 프롬프트 편집분 저장(있으면).
  if (typeof body.prompt === "string") {
    ch.realPrompt = body.prompt.slice(0, 400);
    await saveProject(project);
  }

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "portrait",
    projectId,
    payload: { charId },
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);
  return NextResponse.json({ ok: true, jobId: job.id });
}
