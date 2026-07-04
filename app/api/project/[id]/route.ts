import { NextRequest, NextResponse } from "next/server";
import { getProject, deleteProject } from "@/lib/projectStore";

export const runtime = "nodejs";

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
