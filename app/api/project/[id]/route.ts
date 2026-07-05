import { NextRequest, NextResponse } from "next/server";
import { getProject, deleteProject, saveProject } from "@/lib/projectStore";

export const runtime = "nodejs";

// PATCH — 프로젝트 필드 수정(name, aspectRatio).
const ASPECTS = new Set(["16:9", "9:16", "1:1"]);
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req
    .json()
    .catch(() => ({}) as { name?: string; aspectRatio?: string; regenMode?: string });
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  }
  let changed = false;
  if (typeof body.name === "string" && body.name.trim()) {
    project.name = body.name.trim();
    changed = true;
  }
  if (typeof body.aspectRatio === "string" && ASPECTS.has(body.aspectRatio)) {
    project.aspectRatio = body.aspectRatio as typeof project.aspectRatio;
    changed = true;
  }
  if (body.regenMode === "mask" || body.regenMode === "full") {
    project.regenMode = body.regenMode;
    changed = true;
  }
  if (changed) await saveProject(project);
  return NextResponse.json({ ok: true, name: project.name, aspectRatio: project.aspectRatio });
}

// GET — 프로젝트 전체 상태(Studio 폴링용).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, project });
}

// DELETE — 프로젝트 삭제.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await deleteProject(id);
  return NextResponse.json({ ok: true });
}
