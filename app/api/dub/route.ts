import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";
import { getRedis } from "@/lib/redis";

export const runtime = "nodejs";

// POST — M6 더빙(TTS) 잡 적재. 대사(화자 목소리)·내레이션(나레이터 목소리)을 오디오로.
export async function POST(req: NextRequest) {
  let body: { projectId?: string; sceneIds?: string[]; lang?: string; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  if (!projectId) return NextResponse.json({ ok: false, error: "projectId 필요" }, { status: 400 });
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });

  const sceneIds = Array.isArray(body.sceneIds)
    ? body.sceneIds.filter((id) => typeof id === "string")
    : undefined;
  const payload: Record<string, unknown> = {};
  if (sceneIds && sceneIds.length) payload.sceneIds = sceneIds;
  // ★언어별 더빙(§10) — lang 이 오면 그 언어 트랙(tracks[lang])에 오디오를 채운다.
  //   작업 언어를 바꾸지 않고도 일본어판·영어판 더빙을 각각 만들 수 있다.
  if (typeof body.lang === "string" && /^[a-z]{2,5}$/.test(body.lang)) payload.lang = body.lang;
  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "dub",
    projectId,
    payload,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  // ★더빙은 scene 단계를 건드리지 않는다 — 더빙은 클라이언트가 dubbing 상태 + jobId 로 따로 추적한다.
  //   예전엔 여기서 scene 을 running 으로 박았는데, 워커가 그걸 안 풀어서 더빙 끝난 뒤에도 scene 이
  //   'running' 에 갇혀 pollScene 이 같은 진행로그(더빙 100%)를 다시 띄웠다 = "두 번 도는" 것처럼 보임.
  await enqueueJob(job);
  return NextResponse.json({ ok: true, jobId: job.id });
}

// GET ?projectId — 더빙 진행 + 씬(오디오 URL 포함) + 진행 로그. (video 와 같은 scene 단계 공유)
export async function GET(req: NextRequest) {
  const projectId = (req.nextUrl.searchParams.get("projectId") ?? "").trim();
  if (!projectId) return NextResponse.json({ ok: false, error: "projectId 필요" }, { status: 400 });
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  let progressLog: string[] = [];
  try {
    progressLog = (await getRedis().lrange<string>(`split:progress:${projectId}`, -30, -1)) ?? [];
  } catch {
    /* best-effort */
  }
  return NextResponse.json({
    ok: true,
    status: project.steps.scene.status,
    error: project.steps.scene.error,
    scenes: project.scenes,
    progress: progressLog[progressLog.length - 1] ?? "",
    progressLog,
  });
}
