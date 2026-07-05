import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";
import { type Scene, type CutOntology } from "@/lib/types";
import { CUT_TYPES, TEXT_KINDS, blankCut } from "@/lib/ontology";

const TYPE_IDS = new Set(CUT_TYPES.map((t) => t.id));
const TEXTKIND_IDS = new Set(TEXT_KINDS.map((t) => t.id));

// 클라 cut 을 신뢰 최소화로 정규화(타입/textKind 검증, 문자열 길이 제한).
function cleanCut(raw: unknown): CutOntology {
  const c = blankCut();
  if (!raw || typeof raw !== "object") return c;
  const r = raw as Record<string, unknown>;
  if (typeof r.type === "string" && TYPE_IDS.has(r.type as CutOntology["type"] as never)) {
    c.type = r.type as CutOntology["type"];
  }
  if (c.type === "text" && typeof r.textKind === "string" && TEXTKIND_IDS.has(r.textKind as never)) {
    c.textKind = r.textKind as CutOntology["textKind"];
  }
  if (Array.isArray(r.characters)) c.characters = r.characters.map(String).slice(0, 6);
  if (typeof r.setting === "string") c.setting = r.setting.slice(0, 200);
  if (Array.isArray(r.objects)) c.objects = r.objects.map(String).slice(0, 8);
  if (typeof r.dialogue === "string") c.dialogue = r.dialogue.slice(0, 300);
  if (typeof r.sfx === "string") c.sfx = r.sfx.slice(0, 120);
  if (typeof r.description === "string") c.description = r.description.slice(0, 800);
  if (typeof r.promptDraft === "string") c.promptDraft = r.promptDraft.slice(0, 800);
  if (typeof r.motion === "string") c.motion = r.motion.slice(0, 200);
  c.confirmed = r.confirmed === true;
  return c;
}

export const runtime = "nodejs";

// PUT — G1 편집 결과 저장. regions(정렬된 {yStart,yEnd} 배열)로 씬을 재구성.
//   경계 이동/추가/삭제는 클라에서 regions 배열로 반영해 통째로 보낸다.
export async function PUT(req: NextRequest) {
  let body: {
    projectId?: string;
    regions?: {
      yStart: number;
      yEnd: number;
      xStart?: number;
      xEnd?: number;
      cut?: unknown;
    }[];
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
      const reg: {
        yStart: number;
        yEnd: number;
        xStart?: number;
        xEnd?: number;
        cut: CutOntology;
      } = {
        yStart: Math.max(0, Math.min(total, Math.round(r.yStart))),
        yEnd: Math.max(0, Math.min(total, Math.round(r.yEnd))),
        cut: cleanCut(r.cut),
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
  const scenes: Scene[] = clean.map(({ cut, ...region }, i) => ({
    id: randomUUID(),
    order: i,
    sourceRegion: region,
    cut,
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
