import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject } from "@/lib/projectStore";
import { blankCut } from "@/lib/ontology";
import type { Scene } from "@/lib/types";

export const runtime = "nodejs";

// POST {projectId, sceneId, bubbleIndex} — 그 대사 줄을 '무성영화 자막 씬'(text 컷)으로 분리.
// 원본 컷에서 줄을 빼고, 바로 뒤에 새 씬을 삽입한다. 새 씬은 이미지·영상 생성이 필요 없고
// 합성이 검은 배경 + 자막 카드로 직접 렌더한다(더빙은 일반 대사와 동일).
export async function POST(req: NextRequest) {
  let body: { projectId?: string; sceneId?: string; bubbleIndex?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  const sceneId = (body.sceneId ?? "").trim();
  const bi = Number(body.bubbleIndex);
  if (!projectId || !sceneId || !Number.isInteger(bi) || bi < 0) {
    return NextResponse.json({ ok: false, error: "projectId·sceneId·bubbleIndex 필요" }, { status: 400 });
  }
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  const src = project.scenes.find((s) => s.id === sceneId);
  const bubble = src?.cut?.bubbles?.[bi];
  if (!src || !bubble || !(bubble.text ?? "").trim()) {
    return NextResponse.json({ ok: false, error: "해당 대사 줄이 없어요" }, { status: 404 });
  }

  // 원본 컷에서 그 줄 제거(더빙 오디오 포함 그대로 새 씬으로 이사).
  src.cut!.bubbles = src.cut!.bubbles!.filter((_, i) => i !== bi);

  const ns: Scene = {
    id: randomUUID(),
    order: src.order + 1,
    sourceRegion: { ...src.sourceRegion },
    cut: { ...blankCut(), type: "text", textKind: "caption", bubbles: [bubble], confirmed: true },
    status: "approved",
  };
  for (const s of project.scenes) if (s.order > src.order) s.order += 1;
  project.scenes.push(ns);
  project.scenes.sort((a, b) => a.order - b.order);
  await saveProject(project);
  return NextResponse.json({ ok: true, project });
}

// DELETE {projectId, sceneId} — 컷 하나 삭제(재추출 불필요). order 재부여.
export async function DELETE(req: NextRequest) {
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
  project.scenes = project.scenes
    .filter((s) => s.id !== sceneId)
    .sort((a, b) => a.order - b.order)
    .map((s, i) => ({ ...s, order: i }));
  await saveProject(project);
  return NextResponse.json({ ok: true, scenes: project.scenes });
}
