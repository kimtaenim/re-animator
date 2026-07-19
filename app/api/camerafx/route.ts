import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";

export const runtime = "nodejs";

// POST — 카메라워크(스펙 §2 계층 A) 굽기 잡 적재. scene.cameraWork 는 앱이 프로젝트
// 저장으로 이미 반영했다는 전제(저장은 camera_work JSON 만). 워커가 scene.cameraWork 를
// 읽어 sendcmd crop 으로 클립 위에 구워 scene.fxUrl 로 저장(미리보기=최종 픽셀·합성 재사용).
// preset 이 정지/orbit/계층B/무설정이면 워커가 fxUrl 을 해제(원본 클립 사용).
// 기존 /api/postfx(effect/strength) 는 그대로 — 이 라우트는 새 cameraWork 경로.
export async function POST(req: NextRequest) {
  let body: { projectId?: string; sceneIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  const sceneIds = Array.isArray(body.sceneIds) ? body.sceneIds.filter((x) => typeof x === "string") : [];
  if (!projectId || sceneIds.length === 0) {
    return NextResponse.json({ ok: false, error: "projectId·sceneIds 필요" }, { status: 400 });
  }
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "camerafx",
    projectId,
    payload: { sceneIds },
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);
  return NextResponse.json({ ok: true, jobId: job.id });
}
