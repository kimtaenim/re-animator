import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";

export const runtime = "nodejs";

const EFFECTS = new Set(["none", "crash-in", "crash-out", "ramp-in", "punch"]);

// POST — 후처리(줌 커브) 잡 적재. Grok 원본 클립에 크래시 줌인/아웃·램프·펀치를
// ffmpeg 로 실제 픽셀에 굽고 scene.fxUrl 로 저장 — 미리보기가 곧 최종 픽셀(합성이 재사용).
// effect=none 은 렌더 없이 fxUrl 해제(원본 복귀). strength 1~3(약/중/강).
export async function POST(req: NextRequest) {
  let body: { projectId?: string; sceneIds?: string[]; effect?: string; strength?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  const effect = String(body.effect ?? "");
  const strength = Math.max(1, Math.min(3, Math.round(Number(body.strength) || 2)));
  const sceneIds = Array.isArray(body.sceneIds) ? body.sceneIds.filter((x) => typeof x === "string") : [];
  if (!projectId || !EFFECTS.has(effect) || sceneIds.length === 0) {
    return NextResponse.json({ ok: false, error: "projectId·sceneIds·effect 필요" }, { status: 400 });
  }
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "postfx",
    projectId,
    payload: { sceneIds, effect, strength },
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);
  return NextResponse.json({ ok: true, jobId: job.id });
}
