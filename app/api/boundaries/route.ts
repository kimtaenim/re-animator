import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { enqueueJob, type Job } from "@/lib/jobQueue";
import { type Scene, type CutOntology } from "@/lib/types";
import { CUT_TYPES, TEXT_KINDS, blankCut } from "@/lib/ontology";
import { cleanBubbles } from "@/lib/cutClean";

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
  if (typeof r.dialogueTranslation === "string") c.dialogueTranslation = r.dialogueTranslation.slice(0, 400); // 번역 보존(G1 미리보기)
  // ★bubbles(말풍선=대사 정답 소스) 보존 — 예전엔 화이트리스트에서 빠져 G1 대사 편집이
  //   저장 때 서버 옛값으로 되돌아갔음(다운스트림이 bubbles 를 써서 편집 무시된 버그).
  if (Array.isArray(r.bubbles)) c.bubbles = cleanBubbles(r.bubbles);
  if (typeof r.speakerId === "string") c.speakerId = r.speakerId;
  if (typeof r.sfx === "string") c.sfx = r.sfx.slice(0, 120);
  if (typeof r.description === "string") c.description = r.description.slice(0, 800);
  if (typeof r.promptDraft === "string") c.promptDraft = r.promptDraft.slice(0, 800);
  if (typeof r.motion === "string") c.motion = r.motion.slice(0, 200);
  // ★textRegions(분할이 예약한 '컷 밖 내레이션 밴드') 보존 — 이걸 안 넘기면 G1 저장이
  //   예약을 전멸시켜 추출 OCR 이 내레이션을 통째로 놓친다(반복 소실의 원인이었음).
  if (Array.isArray(r.textRegions)) {
    c.textRegions = r.textRegions
      .filter((b): b is Record<string, number> => !!b && typeof b === "object")
      .map((b) => ({
        yStart: Number(b.yStart) || 0,
        yEnd: Number(b.yEnd) || 0,
        ...(b.xStart != null ? { xStart: Number(b.xStart) } : {}),
        ...(b.xEnd != null ? { xEnd: Number(b.xEnd) } : {}),
      }))
      .slice(0, 24);
  }
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

  // 지오메트리(경계)가 그대로인 컷은 기존 id·원본이미지·생성이미지를 보존한다 →
  // 재추출·재OCR 불필요(안 바뀐 컷은 건너뜀). 경계가 바뀐 컷만 새로 처리된다.
  const geoKey = (r: { yStart: number; yEnd: number; xStart?: number; xEnd?: number }) =>
    `${Math.round(r.yStart)}:${Math.round(r.yEnd)}:${Math.round(r.xStart ?? -1)}:${Math.round(r.xEnd ?? -1)}`;
  const oldByGeo = new Map(project.scenes.map((s) => [geoKey(s.sourceRegion), s]));
  const scenes: Scene[] = clean.map(({ cut, ...region }, i) => {
    const old = oldByGeo.get(geoKey(region));
    return {
      id: old?.id ?? randomUUID(),
      order: i,
      sourceRegion: region,
      // ★경계가 그대로인 컷은 서버 기존 cut 위에 G1 편집 필드만 덮어쓴다 — cleanCut 이
      //   파싱하지 않는 필드(bubbles·더빙 audioUrl·narration·sfxAudioUrl·subtitleX/Y·
      //   durationSec·transition·textBoxes)가 추출 이후 G1 재저장으로 사라지지 않게.
      //   경계가 바뀐 컷은 내용이 어차피 낡았으므로 새로 시작(추출이 다시 OCR).
      // 경계 그대로면 서버 cut 위에 편집만 덮음(bubbles 보존 → 추출이 재OCR 스킵, 속도↑).
      // 경계 바뀐 컷은 내용이 낡았으니 bubbles 를 비워 추출이 그 컷만 새로 OCR 하게 한다.
      cut: old?.cut ? { ...old.cut, ...cut } : { ...cut, bubbles: [] },
      originalImage: old?.originalImage,
      regenMode: old?.regenMode,
      generatedImage: old?.generatedImage,
      status: "review",
    };
  });
  project.scenes = scenes;
  setStep(project, "source", { status: "review", error: undefined });
  await saveProject(project);

  return NextResponse.json({ ok: true, scenes });
}

// POST — G1 확정. 경계로 컷 이미지 추출 잡을 워커에 적재.
export async function POST(req: NextRequest) {
  let body: { projectId?: string; sceneIds?: string[] };
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

  // ★섹션(시퀀스) 단위 추출 — 회분 전체를 한 잡에 몰면 12분 캡을 넘기고 메모리도 겹쳐 터진다.
  //   선택 섹션의 컷 id 만 넘기면 워커가 그 범위만 추출·OCR·연출·번역한다.
  const ids = Array.isArray(body.sceneIds)
    ? body.sceneIds.filter((x): x is string => typeof x === "string" && project.scenes.some((s) => s.id === x))
    : [];

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    type: "extract",
    projectId,
    payload: ids.length ? { sceneIds: ids } : {},
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await enqueueJob(job);

  setStep(project, "source", { status: "running", jobId: job.id, error: undefined });
  await saveProject(project);

  return NextResponse.json({ ok: true, jobId: job.id });
}
