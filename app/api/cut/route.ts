import { NextRequest, NextResponse } from "next/server";
import { getProject, saveProject } from "@/lib/projectStore";
import { CUT_TYPES, TEXT_KINDS, blankCut } from "@/lib/ontology";
import { type CutOntology } from "@/lib/types";
import { cleanBubbles, cleanCameraWork, cleanAudioSuggestions } from "@/lib/cutClean";

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
  if (typeof r.dialogueTranslation === "string") c.dialogueTranslation = r.dialogueTranslation.slice(0, 400); // 번역 보존
  if (typeof r.narration === "string") c.narration = r.narration.slice(0, 800);
  if (typeof r.narrationSpeakerId === "string") c.narrationSpeakerId = r.narrationSpeakerId;
  if (typeof r.narrationAudioUrl === "string") c.narrationAudioUrl = r.narrationAudioUrl; // 더빙 오디오 보존
  if (typeof r.speakerId === "string") c.speakerId = r.speakerId;
  if (Array.isArray(r.bubbles)) {
    c.bubbles = cleanBubbles(r.bubbles); // 번역 포함 화이트리스트(lib/cutClean, 단일 원천·테스트됨)
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
  if (typeof r.sfxAudioUrl === "string") c.sfxAudioUrl = r.sfxAudioUrl; // 효과음 오디오 보존
  if (typeof r.description === "string") c.description = r.description.slice(0, 800);
  if (typeof r.promptDraft === "string") c.promptDraft = r.promptDraft.slice(0, 800);
  if (typeof r.motion === "string") c.motion = r.motion.slice(0, 800); // 프롬프트 잘림 방지
  if (typeof r.action === "string") c.action = r.action.slice(0, 200); // 인물 동작(이어가기) 힌트 — 빈 문자열도 저장(동작 없음 확정)
  if (typeof r.bodyMotion === "string" && r.bodyMotion) c.bodyMotion = r.bodyMotion.slice(0, 20); // 몸동작 프리셋(버튼)
  if (r.animatePicture === true) c.animatePicture = true; // 사진·표지 속 인물 움직임 허용(기본=정지)
  if (typeof r.videoPrompt === "string") c.videoPrompt = r.videoPrompt.slice(0, 800); // 동영상 내용 프롬프트(사람 입력) — 빈 문자열도 저장
  if (typeof r.videoPromptOverride === "string") c.videoPromptOverride = r.videoPromptOverride.slice(0, 2000); // 프롬프트 직접 편집(고급) — 빈 문자열도 저장
  if (typeof r.durationSec === "number" && r.durationSec > 0) {
    c.durationSec = Math.max(0.5, Math.min(15, Math.round(r.durationSec * 2) / 2)); // 0.5초 단위
  }
  if (
    typeof r.transition === "string" &&
    ["none", "fadeout", "fadein", "black", "dissolve", "whip"].includes(r.transition)
  ) {
    c.transition = r.transition;
  }
  if (typeof r.subtitlePos === "string" && ["auto", "top", "middle", "bottom"].includes(r.subtitlePos)) {
    c.subtitlePos = r.subtitlePos as CutOntology["subtitlePos"];
  }
  if (typeof r.subtitleY === "number" && isFinite(r.subtitleY)) {
    c.subtitleY = Math.max(0.05, Math.min(0.95, r.subtitleY)); // 세로 중심 비율
  }
  if (typeof r.subtitleX === "number" && isFinite(r.subtitleX)) {
    c.subtitleX = Math.max(0.05, Math.min(0.95, r.subtitleX)); // 가로 중심 비율
  }
  if (r.noCastRef === true) c.noCastRef = true; // 재생성 시 캐스팅 정본 참고 끄기(피·변신 등 특수 상태 컷)
  if (r.cameraWork !== undefined) {
    const cw = cleanCameraWork(r.cameraWork); // 카메라워크(스펙 §2) — 화이트리스트(cutClean 단일 원천)
    if (cw) c.cameraWork = cw;
  }
  // 모션 티어(스펙 §3) — VLM 자동 분류 결과·사람 수정. 옵셔널.
  if (typeof r.motionTier === "string" && ["talk", "idle", "emote", "action"].includes(r.motionTier)) {
    c.motionTier = r.motionTier as CutOntology["motionTier"];
  }
  if (typeof r.tierConfidence === "number" && isFinite(r.tierConfidence)) c.tierConfidence = Math.max(0, Math.min(1, r.tierConfidence));
  if (typeof r.tierEvidence === "string") c.tierEvidence = r.tierEvidence.slice(0, 200);
  if (typeof r.motionPromptHint === "string") c.motionPromptHint = r.motionPromptHint.slice(0, 400);
  if (r.interpolationCandidate === true) c.interpolationCandidate = true;
  if (r.interpolationOn === true) c.interpolationOn = true; // 동작 보간 켜기(§4)
  if (r.audioSuggestions !== undefined) {
    const sug = cleanAudioSuggestions(r.audioSuggestions); // 오디오 제안(스펙 §6) — 화이트리스트
    if (sug) c.audioSuggestions = sug;
  }
  c.confirmed = r.confirmed === true;
  return c;
}

// ★워커 소유 오디오 필드 보존(저장 규약) — /api/cut 은 클라이언트가 보낸 컷으로 scene.cut 을
//   통째 교체한다. 그런데 오디오 URL(더빙·TTS·효과음)은 오직 워커만 생산하고, 클라이언트는
//   읽기만 한다(직접 쓰지 않음). 더빙 잡이 서버에 audioUrl 을 써넣은 직후, 그 갱신을 아직
//   폴링 못 한 클라이언트가 모션티어·카메라 슬라이더 등을 건드려 stale 컷을 저장하면 방금 생성한
//   오디오가 소실된다(재생성 비용·데이터 손실). → 클라이언트가 '안 보낸'(결여) 워커 오디오 필드만
//   서버 현재값에서 복원한다(fill-when-absent). 클라가 보낸 값은 절대 덮지 않으므로 회귀 0.
//   배열(bubbles·audioSuggestions)은 인덱스+텍스트 일치일 때만 복원(어긋나면 안전하게 건너뜀).
function preserveWorkerAudio(cleaned: CutOntology, prev: CutOntology | undefined): CutOntology {
  if (!prev) return cleaned;
  if (cleaned.narrationAudioUrl == null && prev.narrationAudioUrl) cleaned.narrationAudioUrl = prev.narrationAudioUrl;
  if (cleaned.sfxAudioUrl == null && prev.sfxAudioUrl) cleaned.sfxAudioUrl = prev.sfxAudioUrl;
  const pb = prev.bubbles ?? [];
  (cleaned.bubbles ?? []).forEach((b, i) => {
    const o = pb[i];
    if (!o || (o.text ?? "") !== (b.text ?? "")) return; // 정렬 어긋남 → 복원 안 함
    if (b.audioUrl == null && o.audioUrl) b.audioUrl = o.audioUrl;
    if (o.tracks) {
      b.tracks = b.tracks ?? {};
      for (const [lang, ot] of Object.entries(o.tracks)) {
        const nt = b.tracks[lang] ?? (b.tracks[lang] = {});
        if (nt.audioUrl == null && ot.audioUrl) nt.audioUrl = ot.audioUrl; // 워커 TTS 보존
        if (nt.durationFinal == null && ot.durationFinal != null) nt.durationFinal = ot.durationFinal;
      }
    }
  });
  const ps = prev.audioSuggestions ?? [];
  (cleaned.audioSuggestions ?? []).forEach((s, i) => {
    const o = ps[i];
    if (!o || (o.text ?? "") !== (s.text ?? "")) return;
    if (s.audioUrl == null && o.audioUrl) s.audioUrl = o.audioUrl; // 워커 생성 오디오 보존
  });
  return cleaned;
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
    scene.cut = preserveWorkerAudio(cleanCut(body.cut), scene.cut); // 워커가 쓴 오디오 URL 소실 방지
    changed = true;
  }
  if (body.regenMode === "mask" || body.regenMode === "full") {
    scene.regenMode = body.regenMode;
    changed = true;
  }
  if (changed) await saveProject(project);
  return NextResponse.json({ ok: true });
}
