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
  if (typeof r.dialogue === "string") c.dialogue = r.dialogue.slice(0, 500);
  if (typeof r.narration === "string") c.narration = r.narration.slice(0, 500);
  if (typeof r.narrationSpeakerId === "string") c.narrationSpeakerId = r.narrationSpeakerId;
  if (typeof r.speakerId === "string") c.speakerId = r.speakerId;
  if (Array.isArray(r.bubbles)) {
    c.bubbles = r.bubbles
      .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
      .map((b) => {
        const box = b.box && typeof b.box === "object" ? (b.box as Record<string, unknown>) : null;
        return {
          text: typeof b.text === "string" ? b.text.slice(0, 400) : "",
          speakerId: typeof b.speakerId === "string" ? b.speakerId : b.speakerId === null ? null : undefined,
          box: box
            ? {
                left: Number(box.left) || 0,
                top: Number(box.top) || 0,
                right: Number(box.right) || 0,
                bottom: Number(box.bottom) || 0,
              }
            : undefined,
        };
      })
      .slice(0, 12);
  }
  if (Array.isArray(r.textBoxes)) {
    c.textBoxes = r.textBoxes
      .filter((b): b is Record<string, number> => !!b && typeof b === "object")
      .map((b) => ({
        left: Number(b.left) || 0,
        top: Number(b.top) || 0,
        right: Number(b.right) || 0,
        bottom: Number(b.bottom) || 0,
      }))
      .slice(0, 12);
  }
  if (Array.isArray(r.textRegions)) {
    c.textRegions = r.textRegions
      .filter((b): b is Record<string, number> => !!b && typeof b === "object")
      .map((b) => ({
        yStart: Number(b.yStart) || 0,
        yEnd: Number(b.yEnd) || 0,
        ...(b.xStart != null ? { xStart: Number(b.xStart) } : {}),
        ...(b.xEnd != null ? { xEnd: Number(b.xEnd) } : {}),
      }))
      .slice(0, 8);
  }
  if (typeof r.sfx === "string") c.sfx = r.sfx.slice(0, 120);
  if (typeof r.description === "string") c.description = r.description.slice(0, 800);
  if (typeof r.promptDraft === "string") c.promptDraft = r.promptDraft.slice(0, 800);
  if (typeof r.motion === "string") c.motion = r.motion.slice(0, 200);
  if (typeof r.durationSec === "number" && r.durationSec > 0) {
    c.durationSec = Math.max(0.5, Math.min(15, Math.round(r.durationSec * 2) / 2)); // 0.5초 단위
  }
  if (
    typeof r.transition === "string" &&
    ["none", "fadeout", "fadein", "black", "dissolve"].includes(r.transition)
  ) {
    c.transition = r.transition;
  }
  c.confirmed = r.confirmed === true;
  return c;
}

// PATCH {projectId, sceneId, cut} — 한 컷의 내용(타입·묘사·대사·화자 등)을 저장.
// 경계는 안 건드림. M3 등 어느 단계에서 고쳐도 단일 Project 라 앞단계와 자동 싱크.
export async function PATCH(req: NextRequest) {
  let body: { projectId?: string; sceneId?: string; cut?: unknown; regenMode?: string };
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

  let changed = false;
  if (body.cut !== undefined) {
    scene.cut = cleanCut(body.cut);
    changed = true;
  }
  if (body.regenMode === "mask" || body.regenMode === "full") {
    scene.regenMode = body.regenMode;
    changed = true;
  }
  if (changed) await saveProject(project);
  return NextResponse.json({ ok: true });
}
