import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";
import { type Scene } from "@/lib/types";

export const runtime = "nodejs";

// PUT — G1 편집 결과 저장. regions(정렬된 {yStart,yEnd} 배열)로 씬을 재구성.
//   경계 이동/추가/삭제는 클라에서 regions 배열로 반영해 통째로 보낸다.
export async function PUT(req: NextRequest) {
  let body: {
    projectId?: string;
    regions?: { yStart: number; yEnd: number; xStart?: number; xEnd?: number }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  const regions = body.regions;
  if (!projectId || !Array.isArray(regions)) {
    return NextResponse.json(
      { ok: false, error: "projectId·regions 필요" },
      { status: 400 }
    );
  }
  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  }
  if (!project.virtualCanvas) {
    return NextResponse.json({ ok: false, error: "분할 먼저 실행하세요" }, { status: 409 });
  }

  const total = project.virtualCanvas.totalHeight;
  // 정규화·검증: 범위 클램프 + yStart<yEnd 인 것만 + 순서 정렬.
  const clean = regions
    .map((r) => {
      const reg: { yStart: number; yEnd: number; xStart?: number; xEnd?: number } = {
        yStart: Math.max(0, Math.min(total, Math.round(r.yStart))),
        yEnd: Math.max(0, Math.min(total, Math.round(r.yEnd))),
      };
      if (r.xStart != null && r.xEnd != null && r.xEnd > r.xStart) {
        reg.xStart = Math.round(r.xStart);
        reg.xEnd = Math.round(r.xEnd);
      }
      return reg;
    })
    .filter((r) => r.yEnd - r.yStart >= 1)
    .sort((a, b) => a.yStart - b.yStart);
  if (clean.length === 0) {
    return NextResponse.json({ ok: false, error: "유효한 컷이 없어요" }, { status: 400 });
  }

  // 기존 originalImage 는 경계가 바뀌면 무효 → 재추출 필요하므로 비운다.
  const scenes: Scene[] = clean.map((r, i) => ({
    id: randomUUID(),
    order: i,
    sourceRegion: r,
    status: "review",
  }));
  project.scenes = scenes;
  setStep(project, "source", { status: "review", error: undefined });
  await saveProject(project);

  return NextResponse.json({ ok: true, scenes });
}

// POST — G1 확정. 경계로 컷 이미지 추출 잡을 워커에 적재.
export async function POST(req: NextRequest) {
  let body: { projectId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "projectId 필요" }, { status: 400 });
  }
  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  }
  if (!project.scenes.length) {
    return NextResponse.json({ ok: false, error: "확정할 컷이 없어요" }, { status: 409 });
  }

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "extract",
    projectId,
    payload: {},
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);

  setStep(project, "source", { status: "running", jobId: job.id, error: undefined });
  await saveProject(project);

  return NextResponse.json({ ok: true, jobId: job.id });
}
