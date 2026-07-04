import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { listProjects, saveProject, emptySteps } from "@/lib/projectStore";
import {
  type Project,
  type AspectRatio,
  DEFAULT_NEGATIVE_PROMPT,
} from "@/lib/types";

export const runtime = "nodejs";

const ASPECTS: AspectRatio[] = ["16:9", "9:16", "1:1"];

// GET — 프로젝트 목록(최신순, 요약).
export async function GET() {
  const projects = await listProjects();
  const rows = projects.map((p) => ({
    id: p.id,
    name: p.name,
    aspectRatio: p.aspectRatio,
    sceneCount: p.scenes.length,
    sourceCount: p.sourceFiles.length,
    sourceStatus: p.steps.source.status,
    updatedAt: p.updatedAt,
  }));
  return NextResponse.json({ ok: true, projects: rows });
}

// POST — 새 프로젝트.
export async function POST(req: NextRequest) {
  let body: { name?: string; aspectRatio?: string; stylePrompt?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const name = (body.name ?? "").trim() || "제목 없는 프로젝트";
  const aspectRatio = (ASPECTS.includes(body.aspectRatio as AspectRatio)
    ? body.aspectRatio
    : "16:9") as AspectRatio;

  const now = Date.now();
  const project: Project = {
    id: randomUUID(),
    name,
    aspectRatio,
    stylePrompt: (body.stylePrompt ?? "").trim(),
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    sourceFiles: [],
    virtualCanvas: null,
    scenes: [],
    steps: emptySteps(),
    createdAt: now,
    updatedAt: now,
  };
  await saveProject(project);
  return NextResponse.json({ ok: true, id: project.id });
}
