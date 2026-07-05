import { NextRequest, NextResponse } from "next/server";
import { getProject, saveProject } from "@/lib/projectStore";
import { CUT_TYPES, TEXT_KINDS, blankCut } from "@/lib/ontology";
import type { CutOntology } from "@/lib/types";

export const runtime = "nodejs";

const TYPE_IDS = new Set(CUT_TYPES.map((t) => t.id));
const TK_IDS = new Set(TEXT_KINDS.map((t) => t.id));

function cleanCut(raw: unknown): CutOntology {
  const c = blankCut();
  if (!raw || typeof raw !== "object") return c;
  const r = raw as Record<string, unknown>;
  if (typeof r.type === "string" && TYPE_IDS.has(r.type as CutOntology["type"] as never)) {
    c.type = r.type as CutOntology["type"];
  }
  if (c.type === "text" && typeof r.textKind === "string" && TK_IDS.has(r.textKind as never)) {
    c.textKind = r.textKind as CutOntology["textKind"];
  }
  if (Array.isArray(r.characters)) c.characters = r.characters.map(String).slice(0, 6);
  if (typeof r.setting === "string") c.setting = r.setting.slice(0, 200);
  if (Array.isArray(r.objects)) c.objects = r.objects.map(String).slice(0, 8);
  if (typeof r.dialogue === "string") c.dialogue = r.dialogue.slice(0, 300);
  if (typeof r.speakerId === "string") c.speakerId = r.speakerId;
  if (typeof r.sfx === "string") c.sfx = r.sfx.slice(0, 120);
  if (typeof r.description === "string") c.description = r.description.slice(0, 800);
  if (typeof r.promptDraft === "string") c.promptDraft = r.promptDraft.slice(0, 800);
  if (typeof r.motion === "string") c.motion = r.motion.slice(0, 200);
  c.confirmed = r.confirmed === true;
  return c;
}

// PATCH {projectId, sceneId, cut} — 한 컷의 내용(타입·묘사·대사·화자 등)을 저장.
// 경계는 안 건드림. M3 등 어느 단계에서 고쳐도 단일 Project 라 앞단계와 자동 싱크.
export async function PATCH(req: NextRequest) {
  let body: { projectId?: string; sceneId?: string; cut?: unknown };
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
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) return NextResponse.json({ ok: false, error: "컷 없음" }, { status: 404 });

  scene.cut = cleanCut(body.cut);
  await saveProject(project);
  return NextResponse.json({ ok: true });
}
