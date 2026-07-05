import { NextRequest, NextResponse } from "next/server";
import { getProject, saveProject } from "@/lib/projectStore";

export const runtime = "nodejs";

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
