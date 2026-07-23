"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import {
  type Project,
  type StepKind,
  type Character,
  type CutOntology,
  STEP_ORDER,
  EMOTIONS,
  LANGUAGES,
} from "@/lib/types";
import { blankCut } from "@/lib/ontology";
import { splitRuns, wordTokens, toggleWordEmphasis } from "@/lib/emphasis";
import BoundaryEditor, { type SavedRegion } from "./BoundaryEditor";
import CastReview from "./CastReview";
import CameraWorkEditor from "./CameraWorkEditor";

const STEP_LABEL: Record<StepKind, string> = {
  source: "1. 소스 · 컷 분할",
  cast: "2. 캐스팅",
  regen: "3. 이미지 재생성",
  scene: "4. 동영상 생성 및 더빙",
  compose: "5. 합성",
};

// 카메라 워크 프리셋 — 고르면 그 컷 모션 프롬프트(영문)를 이 문구로 채운다.
// ★화려·과장 클리셰만(사용자 지정: 차분한 프리셋 제거). 속도 변화를 명시해야 모델이 따라온다.
// ★"subject barely moves"류 정지 앵커 금지 — 과장 지시와 충돌해 밋밋하게 타협됨(가드는 MOTION_GUIDANCE 가 담당).
const CAMERA_MOVES: [string, string, string][] = [
  // ★시간 구조(느림/빠름 구간)를 명시해야 I2V 가 '급가속 스냅'을 구현한다. '크게 움직여라'류
  //   막연한 강조는 피사체 동작만 키움(싸구려) — 각 문구는 Camera direction 으로 시작.
  ["crash-in", "⚡ 크래시 줌인", "Camera direction — CRASH ZOOM IN, two speeds only: for most of the clip the camera pushes in almost imperceptibly slowly; then at the very end it SNAPS forward in one instant burst to a tight dramatic close-up. The acceleration is sudden, not gradual."],
  ["crash-out", "💥 크래시 줌아웃", "Camera direction — CRASH ZOOM OUT: hold a tight close-up almost still for a beat; then in one instant burst the camera snaps far back, revealing the whole scene. A single sudden burst, not a gradual pull."],
  ["speed-ramp", "🚀 스피드 램프", "Camera direction — SPEED RAMP IN: the camera starts gliding forward very slowly, then smoothly but rapidly accelerates, arriving fast and close to the subject right at the end. One continuous accelerating move."],
  ["vertigo", "🌀 현기증", "Camera direction — DOLLY ZOOM (vertigo): the camera slowly pushes in while the lens zooms out, so the subject stays the same size while the background stretches and warps. Slow, continuous, unsettling."],
  ["whip-pan", "💨 휩 팬", "Camera direction — WHIP PAN: the camera holds still for a beat, then whips sideways extremely fast with motion blur and snaps to a stop. One single whip."],
  ["orbit-180", "⟲ 오비트180(빠름)", "Camera direction — FAST ORBIT: the camera sweeps one fast 180-degree arc around the subject in a single smooth motion with slight motion blur."],
  ["orbit-120", "⟳ 오비트120(느림)", "Camera direction — ELEGANT ORBIT: the camera glides in a slow, smooth 120-degree arc around the subject, luxurious and steady like a high-end commercial."],
  ["orbit-spin", "🔄 오비트 무한", "Camera direction — ENDLESS SPIN: the camera circles the subject continuously at a steady speed without stopping, hypnotic and stylish."],
  ["impact-shake", "📳 임팩트 쉐이크", "Camera direction — IMPACT SHAKE: one sudden violent jolt like a shockwave, a fast rattling decay within half a second, then completely still."],
  ["static", "■ 고정(정적)", "Camera direction — DELIBERATE STATIC SHOT: locked-off camera, completely still framing like a striking album-cover frame — only subtle ambient motion (drifting particles, hair, cloth, flickering light)."],
  ["slow-in", "🐢 느린 푸시인", "Camera direction — SLOW CINEMATIC PUSH-IN: the camera glides forward very slowly and steadily toward the subject, calm and controlled, no sudden speed changes."],
];

// (레거시) 예전 프리셋 문구 — 이미 저장된 컷의 motion 에서 지울 때만 사용(프리셋 교체 시 잔류 방지).
const LEGACY_MOVE_PHRASES: string[] = [
  // v37~v46 세대(피사체 동작 폭주 세대)
  "CRASH ZOOM IN: the camera creeps forward very slowly, then suddenly ACCELERATES and slams toward the subject at high speed — an explosive speed ramp ending in a tight dramatic close-up. Large, fast frame movement is intended.",
  "CRASH ZOOM OUT: the camera explosively pulls far away from the subject in one fast continuous motion, revealing the whole scene — the frame changes dramatically from close-up to wide.",
  "SPEED RAMP: dreamy slow motion at first, then the camera suddenly rushes toward the subject with rapidly increasing speed — music-video energy, big frame change.",
  "DOLLY ZOOM (vertigo effect): the camera pushes in while the lens zooms out — the subject stays the same size while the background stretches and warps dramatically around them.",
  "WHIP PAN: the camera whips sideways extremely fast with heavy motion blur streaks, then snaps to a stop on the subject.",
  "FAST ORBIT: the camera sweeps a fast 180-degree arc around the subject with motion blur, showy and dynamic.",
  "ELEGANT ORBIT: the camera glides smoothly in a wide 120-degree arc around the subject, slow and luxurious like a high-end commercial.",
  "ENDLESS SPIN: the camera keeps circling around the subject continuously without stopping, hypnotic and stylish.",
  "IMPACT SHAKE: a sudden violent camera shake like a shockwave hit — hard jolt, quick rattling decay, then still.",
  "DELIBERATE STATIC SHOT: locked-off camera, completely still framing like a striking album-cover frame — only subtle ambient motion (drifting particles, hair, cloth, flickering light). The stillness is intentional and stylish.",
  "SLOW CINEMATIC PUSH-IN: the camera glides forward very slowly and steadily toward the subject, calm and controlled, building quiet tension — smooth and elegant, no sudden speed changes.",
  "Camera creeps forward slowly, then suddenly accelerates into a dramatic crash zoom slamming toward the subject — explosive speed ramp from very slow to very fast. Camera only; the subject barely moves.",
  "Camera suddenly whips backward in a dramatic crash zoom out, rapidly pulling far away to reveal the whole scene in one explosive motion. Camera only; the subject barely moves.",
  "Speed-ramped dolly-in: starts in dreamy slow motion, then bursts into a rapid accelerating rush toward the subject — cinematic action-movie energy. Camera only; the subject barely moves.",
  "Extreme dolly zoom vertigo effect: aggressive dolly-in while zooming out, the background warping and stretching dramatically around the subject who stays the same size. Camera only.",
  "Fast whip pan with heavy motion blur streaking across the scene, aggressive and energetic. Camera only; the subject stays mostly still.",
  "Fast dramatic 180-degree orbit whipping around the subject with slight motion blur, dynamic and showy. Camera moves; the subject stays still.",
  "Smooth elegant 120-degree orbit gliding around the subject, slow and cinematic like a luxury commercial. Camera moves; the subject stays still.",
  "Continuous spinning orbit circling around the subject without stopping, round and round in a stylish hypnotic loop. Camera moves; the subject stays still.",
  "Sudden violent camera shake like a shockwave impact, then the camera quickly settles — punchy and dramatic. Camera only; the subject stays still.",
  "Slow zoom in (push-in) toward the subject — camera only; the subject barely moves.",
  "Slow zoom out (pull-back) revealing more of the scene — camera only; the subject barely moves.",
  "Slow horizontal pan across the scene — camera only; the subject stays mostly still.",
  "Slow vertical pan/tilt across the scene — camera only; the subject stays mostly still.",
  "Smooth 120-degree orbit around the subject — camera moves while the subject stays still.",
  "Dolly zoom (vertigo effect): dolly in while zooming out so the subject stays the same size while the background perspective stretches. Camera only; subject still.",
  "Locked-off static camera, no camera movement — only very subtle ambient motion; the subject stays still.",
];

// 컷 끝 전환(합성 시 적용). 값은 lib/types CutOntology.transition 과 /api/cut 화이트리스트와 일치.
const TRANSITIONS: [string, string][] = [
  ["none", "컷(즉시)"],
  ["fadeout", "페이드아웃"],
  ["fadein", "페이드인"],
  ["black", "암전"],
  ["dissolve", "디졸브(섞임)"],
  ["whip", "휩(모션블러 스와이프)"],
];
// 인물 몸동작 프리셋(버튼) — [id, 라벨]. id 는 worker BODY_MOTION_PROMPTS 와 일치해야 함. 모두 절제된 동작.
const BODY_MOTIONS: [string, string][] = [
  ["still", "🧍 가만히"],
  ["sway", "🍃 살짝"],
  ["walk-in", "🚶 걸어 들어옴"],
  ["walk-out", "🚶 걸어 나감"],
  ["run", "🏃 뛰어옴"],
  ["turn", "🔄 돌아봄"],
  ["gesture", "👋 손짓"],
];

// 영상/효과 URL 파일명 끝의 타임스탬프(Date.now()) 추출 — 재생성 때 이 값이 바뀌면 진짜 새 영상이 만들어진 것.
function urlTimestamp(url?: string): number | null {
  if (!url) return null;
  const m = url.match(/-(\d{12,})\.(?:mp4|mov|webm)(?:$|\?)/);
  return m ? Number(m[1]) : null;
}
function fmtClock(ts: number | null): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Seoul" });
  } catch {
    return "";
  }
}

// 대사 줄의 화자 특수값 — 효과음(소리 생성). 캐릭터 id 와 안 겹치는 센티넬.
const SFX_SPEAKER = "__sfx__";

// 연출 보고서 카메라 열 헬퍼 — cut.motion(프롬프트 문구) ↔ CAMERA_MOVES id 변환(모듈 공용).
const camIdFromMotion = (motion?: string) => CAMERA_MOVES.find(([, , pr]) => (motion ?? "").includes(pr))?.[0] ?? "";
const setCamMotion = (id: string, curMotion?: string) => {
  let base = curMotion ?? "";
  for (const [, , pr] of CAMERA_MOVES) base = base.split(pr).join("");
  base = base.trim();
  const chosen = CAMERA_MOVES.find(([cid]) => cid === id)?.[2];
  return chosen ? (base ? `${base} ${chosen}` : chosen) : base;
};

// ★목록용 지연 비디오 — ★마우스를 올린 것만★ 재생, 떼면 정지(사용자 지정 — '보이면 재생'도
//   여러 개가 동시에 돌 수 있어 강화). 평소엔 첫 프레임만 썸네일처럼 표시(preload=metadata).
//   수십 개 <video autoPlay> 동시 디코딩이 크롬 버벅임의 원인이었음.
function LazyVideo({ src, onClick, className }: { src: string; onClick?: () => void; className?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  // ★마우스 올린 것만 <video> 를 mount(로드·디코딩). 떼면 아예 언마운트해 메모리·디코딩 0.
  //   수십 컷이 동시에 preload=metadata 로 디코딩되어 크롬이 먹통 되던 것 해결(사용자 지정).
  const [on, setOn] = useState(false);
  return (
    <div
      onMouseEnter={() => setOn(true)}
      onMouseLeave={() => setOn(false)}
      onClick={onClick}
      title="마우스를 올리면 재생 · 클릭하면 미리보기"
      className={`grid place-items-center overflow-hidden bg-black/40 ${className ?? ""}`}
    >
      {on ? (
        <video
          ref={ref}
          src={src}
          muted
          loop
          playsInline
          preload="metadata"
          onLoadedData={() => ref.current?.play().catch(() => {})}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="text-[11px] text-white/60">▶</span>
      )}
    </div>
  );
}

export default function Studio({ initialProject }: { initialProject: Project }) {
  const [project, setProject] = useState<Project>(initialProject);
  const projectRef = useRef(project);
  const [busy, setBusy] = useState(false);
  // 캐스팅 확정 신호 — 플로팅 리모컨의 '캐스팅 확정'이 이 값을 올리면 CastReview 가 자기 상태로 확정(approve).
  const [castConfirmNonce, setCastConfirmNonce] = useState(0);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(false); // 📋 작업 로그 상시 패널(단계 무관·스크롤 무관)
  const [translating, setTranslating] = useState(false); // 🌐 번역만 다시 실행 중
  const [srcOpen, setSrcOpen] = useState<boolean | null>(null); // null=기본(승인되면 접힘)
  const [regenOpen, setRegenOpen] = useState(true); // 3단계 컷 목록 접기
  const [vidPending, setVidPending] = useState<Set<string>>(() => new Set()); // 영상 생성 중인 컷
  const [regenPending, setRegenPending] = useState<Map<string, string>>(() => new Map()); // 재생성 중인 컷(값=요청시 옛 이미지 url)
  const regenSawRunning = useRef(false); // 재생성 잡이 실제 running 을 거쳤는지(스피너 조기 해제 방지)
  const [selForVideo, setSelForVideo] = useState<Set<string>>(() => new Set()); // 4단계 다중 선택
  // 대사 줄별 '세부(⚙)' 펼침 상태 — 감정·자막위치·순서이동 등 잘 안 만지는 컨트롤을 평소엔 접어둠.
  const [advBub, setAdvBub] = useState<Set<string>>(() => new Set());
  const toggleAdv = (key: string) =>
    setAdvBub((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  // 4단계 컷별 '연출·세부(⚙)' 펼침 상태 — 전환·후처리줌·프롬프트·자막기본위치·카메라·모션을 평소엔 접어둠.
  const [advCut, setAdvCut] = useState<Set<string>>(() => new Set());
  const toggleAdvCut = (id: string) =>
    setAdvCut((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  // 4단계 씬 목록 아코디언(스펙 §9) — 접힌 줄은 4요소만, 펼치면 본문(썸네일·카메라·프롬프트·대사 편집).
  //   항상 최대 1개 펼침. 클릭으로 토글.
  const [openScene, setOpenScene] = useState<string | null>(null);
  const [onlyUnresolved, setOnlyUnresolved] = useState(false); // "미결만 보기" — 티어 미분류·저확신
  // 미결 판정(§9·§3): 모션 티어가 없거나 확신도 낮은 컷.
  const isUnresolvedScene = (s: Project["scenes"][number]) =>
    !s.cut?.motionTier || (typeof s.cut?.tierConfidence === "number" && s.cut.tierConfidence < 0.5);
  // 각 씬의 '다음 재생성 컷'(동작 보간 끝 프레임) — O(n) 한 번 계산(접힌 줄마다 스캔하면 O(n²)라 먹통).
  //   뒤에서부터 훑어 가장 가까운(order 큰) generatedImage 컷을 next 로. hasNext=뒤에 씬이 있나.
  const nextGenByScene = useMemo(() => {
    const sorted = [...(project.scenes ?? [])].sort((a, b) => a.order - b.order);
    const m = new Map<string, { hasNext: boolean; next: Project["scenes"][number] | null }>();
    let lastGen: Project["scenes"][number] | null = null;
    let hasAny = false;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const s = sorted[i];
      m.set(s.id, { hasNext: hasAny, next: lastGen });
      hasAny = true;
      if (s.generatedImage) lastGen = s;
    }
    return m;
  }, [project.scenes]);
  // ── 섹션(부분 작업) — 한 회분을 몇 개 섹션으로 나눠 부분부분 작업 후 최종 이어붙이기 ──
  const [currentSection, setCurrentSection] = useState<number | null>(null); // null=전체
  const [divN, setDivN] = useState(15); // 분량 기준: 섹션당 컷 수
  const orderedScenes = useMemo(
    () => [...(project.scenes ?? [])].sort((a, b) => a.order - b.order),
    [project.scenes]
  );
  // sectionStarts(시작 컷 인덱스) → 섹션 목록. 항상 0 포함. 경계 없으면 [](=전체 한 덩어리).
  const sections = useMemo(() => {
    const n = orderedScenes.length;
    const raw = (project.sectionStarts ?? []).filter((s) => s > 0 && s < n);
    const norm = [...new Set([0, ...raw])].sort((a, b) => a - b);
    if (norm.length <= 1) return [] as { i: number; start: number; end: number; ids: Set<string> }[];
    return norm.map((st, i) => {
      const end = i + 1 < norm.length ? norm[i + 1] : n;
      return { i, start: st, end, ids: new Set(orderedScenes.slice(st, end).map((s) => s.id)) };
    });
  }, [project.sectionStarts, orderedScenes]);
  // 현재 섹션 필터 — 섹션 없거나 '전체'면 모두 통과.
  const sec = currentSection != null && sections[currentSection] ? sections[currentSection] : null;
  const inSection = (s: Project["scenes"][number]) => !sec || sec.ids.has(s.id);
  const scopeSectionIds = (ids: string[]) => (sec ? ids.filter((id) => sec.ids.has(id)) : ids);
  async function saveSectionStarts(starts: number[]) {
    const norm = [...new Set(starts.filter((s) => s >= 0).map((s) => Math.floor(s)))].sort((a, b) => a - b);
    setProject((prev) => ({ ...prev, sectionStarts: norm.length ? norm : undefined }));
    await fetch(`/api/project/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sectionStarts: norm }),
    }).catch(() => {});
  }
  function divideBySize(n: number) {
    const total = orderedScenes.length;
    if (total === 0 || n < 1) return;
    const starts: number[] = [];
    for (let i = 0; i < total; i += n) starts.push(i);
    setCurrentSection(0);
    saveSectionStarts(starts);
  }
  function clearSections() {
    setCurrentSection(null);
    saveSectionStarts([]);
  }
  function mergeSectionWithNext(i: number) {
    const boundary = sections[i + 1]?.start;
    if (boundary == null) return;
    if (currentSection != null && currentSection > i) setCurrentSection(currentSection - 1);
    saveSectionStarts(sections.map((x) => x.start).filter((s) => s !== boundary));
  }
  function splitSection(i: number) {
    const s = sections[i];
    if (!s || s.end - s.start < 2) return;
    const mid = s.start + Math.floor((s.end - s.start) / 2);
    saveSectionStarts([...sections.map((x) => x.start), mid]);
  }
  // 🤖 시퀀스 자동 나누기 — 워커가 Claude 로 컷들을 서사 시퀀스로 묶어 sectionStarts 산출.
  const [seqBusy, setSeqBusy] = useState(false);
  async function autoSequence() {
    if (seqBusy) return;
    setSeqBusy(true);
    setError("");
    try {
      const r = await fetch("/api/sequence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "시퀀스 나누기 실패");
      const iv = setInterval(async () => {
        try {
          const jr = await fetch(`/api/job?id=${d.jobId}`, { cache: "no-store" });
          const jd = await jr.json();
          if (jd.ok && (jd.status === "done" || jd.status === "error")) {
            clearInterval(iv);
            setSeqBusy(false);
            if (jd.status === "error") {
              setError(`시퀀스 나누기 실패: ${jd.error ?? ""}`);
              return;
            }
            const pr = await fetch(`/api/project/${project.id}`, { cache: "no-store" });
            const pd = await pr.json();
            if (pd.ok) {
              setProject(pd.project);
              setCurrentSection(0);
            }
          }
        } catch {}
      }, 3000);
      setTimeout(() => {
        clearInterval(iv);
        setSeqBusy(false);
      }, 3 * 60_000);
    } catch (e) {
      setSeqBusy(false);
      setError(e instanceof Error ? e.message : "시퀀스 나누기 실패");
    }
  }
  // 방향 B — 섹션별 부분 합성(그 섹션 클립만 → sectionVideos[key]). 잡 폴링 후 프로젝트 재로드.
  const [secComposePending, setSecComposePending] = useState<Set<string>>(new Set());
  async function composeSection(startKey: string, sceneIds: string[]) {
    if (!sceneIds.length) {
      setError("이 섹션에 합성할 영상이 없어요 — 먼저 이 섹션 동영상을 생성하세요.");
      return;
    }
    setError("");
    setSecComposePending((p) => new Set([...p, startKey]));
    const clear = () =>
      setSecComposePending((p) => {
        const n = new Set(p);
        n.delete(startKey);
        return n;
      });
    try {
      const r = await fetch("/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, sceneIds, sectionKey: startKey }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "섹션 합성 실패");
      const iv = setInterval(async () => {
        try {
          const jr = await fetch(`/api/job?id=${d.jobId}`, { cache: "no-store" });
          const jd = await jr.json();
          if (jd.ok && (jd.status === "done" || jd.status === "error")) {
            clearInterval(iv);
            clear();
            if (jd.status === "error") {
              setError(`섹션 합성 실패: ${jd.error ?? ""}`);
              return;
            }
            const pr = await fetch(`/api/project/${project.id}`, { cache: "no-store" });
            const pd = await pr.json();
            if (pd.ok) setProject(pd.project);
          }
        } catch {}
      }, 3000);
      setTimeout(() => {
        clearInterval(iv);
        clear();
      }, 10 * 60_000);
    } catch (e) {
      clear();
      setError(e instanceof Error ? e.message : "섹션 합성 실패");
    }
  }
  // 최종 이어붙이기 — 섹션 합성본들을 순서대로 concat → composedUrl. compose 스텝 폴링으로 추적.
  async function joinSections() {
    setError("");
    try {
      const r = await fetch("/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, mode: "join" }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "이어붙이기 실패");
      setProject((prev) => ({ ...prev, steps: { ...prev.steps, compose: { ...prev.steps.compose, status: "running" } } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "이어붙이기 실패");
    }
  }

  // "삽입 대사 일괄 끄기"(§6·§9) — 모든 컷의 insert_line 오디오 제안을 enabled=false 로.
  function bulkDisableInsertLines() {
    for (const s of project.scenes) {
      const sug = s.cut?.audioSuggestions;
      if (sug?.some((x) => x.type === "insert_line" && x.enabled !== false)) {
        updateCut(s.id, { audioSuggestions: sug.map((x) => (x.type === "insert_line" ? { ...x, enabled: false } : x)) });
      }
    }
  }
  // 활성 단계 — 한 화면에 5단계를 다 쌓지 않고, 고른 단계만 보여준다(스크롤·무게 급감).
  // 초기값은 진행 상황에 맞춰: 이미지 있으면 4단계, 승인됐으면 2단계, 아니면 1단계.
  // ★단계 키에 UI 전용 'camera'(카메라 미리보기) 추가 — steps 레코드(source/cast/regen/scene/compose)는
  //   건드리지 않는다(옛 프로젝트 안전·데이터 무변경). 순수 화면 탭으로만 존재.
  const [activeStep, setActiveStep] = useState<StepKind | "camera">(() =>
    project.scenes?.some((s) => s.generatedImage)
      ? "scene"
      : project.steps?.source?.status === "approved"
        ? "cast"
        : "source"
  );
  // ★단계 전환 시 화면 리셋 방지 — 단계를 조건부 렌더해 언마운트하므로 스크롤이 초기화됐다.
  //   떠나는 단계의 스크롤 위치를 기억했다가, 그 단계로 돌아오면 정확히 그 자리로 복원한다.
  const stepScrollY = useRef<Record<string, number>>({});
  function goToStep(k: StepKind | "camera") {
    stepScrollY.current[activeStep] = window.scrollY; // 떠나기 전 현재 위치 저장
    setActiveStep(k);
  }
  useEffect(() => {
    const y = stepScrollY.current[activeStep];
    if (y != null) requestAnimationFrame(() => window.scrollTo(0, y)); // 방문했던 단계면 그 자리로
  }, [activeStep]);
  const [lightbox, setLightbox] = useState<{ type: "image" | "video"; src: string } | null>(null); // 클릭 확대
  const [scenePreview, setScenePreview] = useState<string | null>(null); // 씬 미리보기(영상+자막+더빙)
  const [bubDropId, setBubDropId] = useState<string | null>(null); // 대사(말풍선) 드래그앤드롭 시 드롭 대상 컷 하이라이트
  const [subIdx, setSubIdx] = useState(0); // 미리보기 자막 박스 순차 표시 인덱스(하나씩)
  // 후처리 줌(postfx) 상태 — 진행 중 씬 id + 카드별 선택값(적용 전 임시).
  const [fxPending, setFxPending] = useState<Set<string>>(new Set());
  const [fxSel, setFxSel] = useState<Record<string, { effect: string; strength: number }>>({});
  // 4단계 목소리 캐스팅 패널용 목소리 카탈로그(config/voices.json) — 캐스팅 화면과 같은 원천.
  const [voiceList, setVoiceList] = useState<{ provider?: string; id: string; name: string; note?: string }[]>([]);
  useEffect(() => {
    fetch("/api/voices").then((r) => r.json()).then((d) => setVoiceList(d.voices ?? [])).catch(() => {});
  }, []);
  // 캐스트 저장(목소리 변경·화면 밖 인물 추가) — 캐스팅 화면과 같은 PUT /api/cast = 항상 싱크.
  async function saveCastVoices(next: Character[]) {
    setProject((prev) => ({ ...prev, cast: next }));
    await fetch("/api/cast", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, cast: next }),
    }).catch(() => {});
  }
  function setCastVoice(charId: string, voiceId: string) {
    const v = voiceList.find((x) => x.id === voiceId);
    const next = (project.cast ?? []).map((c) =>
      c.id === charId
        ? { ...c, voice: voiceId || undefined, voiceName: v?.name, voiceProvider: v?.provider }
        : c
    );
    void saveCastVoices(next);
  }
  function addOffscreenChar() {
    const label = window.prompt("화면 밖 인물 이름 (예: 전화 목소리, 해설자)", "화면 밖 인물")?.trim();
    if (!label) return;
    void saveCastVoices([
      ...(project.cast ?? []),
      { id: `char-off-${Date.now().toString(36)}`, label, description: "", sceneIds: [] } as Character,
    ]);
  }
  const [portraitPending, setPortraitPending] = useState<Map<string, string>>(() => new Map()); // 실사 초상 생성 중(값=옛 realImage url)
  const [genModel, setGenModel] = useState("gpt-image-2"); // 재생성 모델(비교용)
  const [costKrw, setCostKrw] = useState<number | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState("");
  const [uploadMsg, setUploadMsg] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const elapsedTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 업로드 중지 — abort + UI 즉시 해제(SDK 가 늦게 반응해도 사용자는 바로 벗어남).
  function cancelUpload() {
    cancelledRef.current = true;
    abortRef.current?.abort();
    setBusy(false);
    setUploadMsg("");
    if (elapsedTimer.current) {
      clearInterval(elapsedTimer.current);
      elapsedTimer.current = null;
    }
  }

  const sourceStatus = project.steps.source.status;
  const running = sourceStatus === "running";
  const castStatus = project.steps.cast.status;
  const castRunning = castStatus === "running";
  const regenStatus = project.steps.regen.status;
  const regenRunning = regenStatus === "running";
  const sceneStatus = project.steps.scene.status; // M4 영상(I2V)
  const sceneRunning = sceneStatus === "running";
  const composeStatus = project.steps.compose.status; // M7 합성(이어붙이기)
  const composeRunning = composeStatus === "running";

  // ── 분할/추출 진행 폴링 (워커 작업 중일 때만) ──────────────────────────────
  const poll = useCallback(async () => {
    try {
      const r = await fetch(`/api/split?projectId=${project.id}`, { cache: "no-store" });
      const d = await r.json();
      if (!d.ok) return;
      setProgress(d.progress ?? "");
      setProgressLog(d.progressLog ?? []);
      setProject((prev) => ({
        ...prev,
        virtualCanvas: d.virtualCanvas ?? prev.virtualCanvas,
        scenes: d.scenes ?? prev.scenes,
        steps: {
          ...prev.steps,
          source: { ...prev.steps.source, status: d.status, error: d.error },
        },
      }));
    } catch {
      /* 다음 틱 재시도 */
    }
  }, [project.id]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(poll, 2000);
    const first = setTimeout(poll, 0); // 즉시 1회(effect 안 직접 setState 회피)
    return () => {
      clearInterval(t);
      clearTimeout(first);
    };
  }, [running, poll]);

  // ★마운트 시 '직전 작업 로그' 1회 로드 — 작업이 끝난 뒤 새로고침하면 running=false 라
  //   폴링이 한 번도 안 돌아 로그가 빈 채로 남는다. 진행 로그만 읽고 프로젝트 상태는
  //   건드리지 않는다(마운트 시 scenes 를 덮어써 편집 상태를 흔드는 사고 방지).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/split?projectId=${project.id}`, { cache: "no-store" });
        const d = await r.json();
        if (!alive || !d.ok) return;
        setProgressLog((prev) => (prev.length ? prev : (d.progressLog ?? [])));
      } catch {
        /* 로그는 있으면 좋은 것 — 실패해도 무시 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [project.id]);

  // ── 캐스팅(M2) 진행 폴링 ──────────────────────────────────────────────────
  const pollCast = useCallback(async () => {
    try {
      const r = await fetch(`/api/cast?projectId=${project.id}`, { cache: "no-store" });
      const d = await r.json();
      if (!d.ok) return;
      setProgress(d.progress ?? "");
      setProgressLog(d.progressLog ?? []);
      setProject((prev) => ({
        ...prev,
        cast: d.cast ?? prev.cast,
        scenes: d.scenes ?? prev.scenes,
        steps: { ...prev.steps, cast: { ...prev.steps.cast, status: d.status, error: d.error } },
      }));
    } catch {
      /* 다음 틱 재시도 */
    }
  }, [project.id]);

  useEffect(() => {
    if (!castRunning) return;
    const t = setInterval(pollCast, 2000);
    const first = setTimeout(pollCast, 0);
    return () => {
      clearInterval(t);
      clearTimeout(first);
    };
  }, [castRunning, pollCast]);

  // ── 재생성(M3) 진행 폴링 ─────────────────────────────────────────────────────
  const pollRegen = useCallback(async () => {
    try {
      const r = await fetch(`/api/regen?projectId=${project.id}`, { cache: "no-store" });
      const d = await r.json();
      if (!d.ok) return;
      setProgress(d.progress ?? "");
      setProgressLog(d.progressLog ?? []);
      // ★재생성 결과(generatedImage/regenError)만 필드 단위 병합 — 씬 전체를 덮어쓰면 그 사이
      //   사용자가 편집 중인 대사·컷 내용이 2.5초마다 되돌려져 "이미지 생성 중엔 스크립트 수정이
      //   씹힌다". runRegen 은 씬에 generatedImage·regenError 만 쓰므로 그 둘만 받는다(pollScene 과 동일 원칙).
      const rmap = new Map(
        ((d.scenes ?? []) as { id: string; generatedImage?: string; regenError?: string }[]).map((x) => [x.id, x])
      );
      setProject((prev) => ({
        ...prev,
        scenes: prev.scenes.map((ps) => {
          const ss = rmap.get(ps.id);
          return ss ? { ...ps, generatedImage: ss.generatedImage, regenError: ss.regenError } : ps;
        }),
        steps: { ...prev.steps, regen: { ...prev.steps.regen, status: d.status, error: d.error } },
      }));
      // 'running' 을 한 번 본 뒤 종료됐을 때만 전부 해제 — 요청 직후 첫 폴링(아직 running
      // 아님)이 스피너를 즉시 지우는 레이스 방지. 개별 컷은 새 이미지/실패로 그때그때 해제.
      if (d.status === "running") regenSawRunning.current = true;
      const ended = d.status !== "running" && regenSawRunning.current;
      if (ended) regenSawRunning.current = false;
      setRegenPending((prev) => {
        if (prev.size === 0) return prev;
        const n = new Map(prev);
        for (const s of (d.scenes ?? []) as { id: string; generatedImage?: string; regenError?: string }[]) {
          if (!n.has(s.id)) continue;
          if (s.regenError || (s.generatedImage && s.generatedImage !== n.get(s.id))) n.delete(s.id);
        }
        if (ended) n.clear();
        return n;
      });
    } catch {
      /* 다음 틱 재시도 */
    }
  }, [project.id]);

  const regenPolling = regenRunning || regenPending.size > 0;
  useEffect(() => {
    if (!regenPolling) return;
    const t = setInterval(pollRegen, 2500);
    const first = setTimeout(pollRegen, 0);
    return () => {
      clearInterval(t);
      clearTimeout(first);
    };
  }, [regenPolling, pollRegen]);

  // ── 영상(M4·I2V) 진행 폴링 ───────────────────────────────────────────────────
  const pollScene = useCallback(async () => {
    try {
      const r = await fetch(`/api/video?projectId=${project.id}`, { cache: "no-store" });
      const d = await r.json();
      if (!d.ok) return;
      setProgress(d.progress ?? "");
      setProgressLog(d.progressLog ?? []);
      // ★ 영상 결과(videoUrl/videoError)만 병합 — 씬 전체를 덮어쓰면 그 사이 사용자가
      // 편집 중인 대사·모션·길이 등이 되돌려져 타이핑이 씹힌다. 그래서 필드 단위 병합.
      const vmap = new Map(
        (d.scenes ?? []).map((x: { id: string; videoUrl?: string; videoError?: string; fxUrl?: string; fx?: unknown }) => [
          x.id,
          x,
        ])
      );
      setProject((prev) => ({
        ...prev,
        scenes: prev.scenes.map((ps) => {
          const ss = vmap.get(ps.id) as
            | { videoUrl?: string; videoError?: string; fxUrl?: string; fx?: Project["scenes"][number]["fx"] }
            | undefined;
          // ★fxUrl/fx 도 병합 — 영상 재생성 시 워커가 낡은 fxUrl 을 지우는데, 이걸 안 받아오면
          //   화면이 계속 옛 구운영상(fxUrl)을 보여줘 "다시 생성해도 안 바뀜"이 된다.
          return ss ? { ...ps, videoUrl: ss.videoUrl, videoError: ss.videoError, fxUrl: ss.fxUrl, fx: ss.fx } : ps;
        }),
        steps: { ...prev.steps, scene: { ...prev.steps.scene, status: d.status, error: d.error } },
      }));
      // 완료(영상 있음)·실패한 컷은 '생성 중'에서 해제 → 그 컷 버튼 다시 활성.
      const resolved = new Set(
        (d.scenes ?? [])
          .filter((s: { videoUrl?: string; videoError?: string }) => s.videoUrl || s.videoError)
          .map((s: { id: string }) => s.id)
      );
      setVidPending((prev) => new Set([...prev].filter((id) => !resolved.has(id))));
    } catch {
      /* 다음 틱 재시도 */
    }
  }, [project.id]);

  // 진행 중이거나 대기 중인 컷이 하나라도 있으면 폴링(여러 잡이 큐로 쌓여도 계속 반영).
  const scenePolling = sceneRunning || vidPending.size > 0;
  useEffect(() => {
    if (!scenePolling) return;
    const t = setInterval(pollScene, 3000);
    const first = setTimeout(pollScene, 0);
    return () => {
      clearInterval(t);
      clearTimeout(first);
    };
  }, [scenePolling, pollScene]);

  // ── 합성(5단계) 진행 폴링 ───────────────────────────────────────────────────
  const pollCompose = useCallback(async () => {
    try {
      const r = await fetch(`/api/compose?projectId=${project.id}`, { cache: "no-store" });
      const d = await r.json();
      if (!d.ok) return;
      setProgress(d.progress ?? "");
      setProgressLog(d.progressLog ?? []);
      setProject((prev) => ({
        ...prev,
        composedUrl: d.composedUrl ?? prev.composedUrl,
        steps: { ...prev.steps, compose: { ...prev.steps.compose, status: d.status, error: d.error } },
      }));
    } catch {
      /* 다음 틱 재시도 */
    }
  }, [project.id]);

  useEffect(() => {
    if (!composeRunning) return;
    const t = setInterval(pollCompose, 3000);
    const first = setTimeout(pollCompose, 0);
    return () => {
      clearInterval(t);
      clearTimeout(first);
    };
  }, [composeRunning, pollCompose]);

  // 탭으로 돌아오면 즉시 새로고침 — 백그라운드 탭에선 브라우저가 폴링을 늦춰서, 리로드 없이
  // 최신 상태를 못 보던 문제. 진행/대기 중인 단계만 그때 한 번 당겨온다.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (regenPolling) pollRegen();
      if (scenePolling) pollScene();
      if (composeRunning) pollCompose();
    };
    window.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [regenPolling, scenePolling, composeRunning, pollRegen, pollScene, pollCompose]);

  // projectRef 를 최신 project 로 동기화(자동저장 디바운스에서 최신 cut 읽기용).
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // 누적 API 비용(₩) — 마운트 + ★모든 단계 상태 변화(잡 완료 시 비용 기록됨)마다 갱신 → 항상 최신.
  useEffect(() => {
    let alive = true;
    fetch(`/api/cost?projectId=${project.id}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (alive && d.ok) setCostKrw(d.krw);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project.id, sourceStatus, castStatus, regenStatus, sceneStatus, composeStatus, portraitPending.size]);

  // ── 액션 ────────────────────────────────────────────────────────────────
  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError("");
    setElapsed(0);
    cancelledRef.current = false;
    const startedAt = Date.now();
    elapsedTimer.current = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      500
    );
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // 파일명 순으로 정렬 = 세로 스크롤(컷) 순서. 숫자 인식(1,2,…,10,11).
      const list = Array.from(files).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
      );
      const totalBytes = list.reduce((s, f) => s + f.size, 0) || 1;
      let completedBytes = 0;
      const registered: { url: string; width: number; height: number }[] = [];
      // 브라우저 → Blob 직접 업로드(4.5MB 함수 한계 우회). 큰 웹툰 파일은 multipart
      // 청크 전송이라야 단일 PUT 실패→재시도(0→100→0 반복)를 피한다.
      // 진행률은 전체 바이트 기준 "하나의 바"로 표시(파일마다 0 으로 리셋돼 보이는 혼란 제거).
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const bmp = await createImageBitmap(f);
        const dims = { width: bmp.width, height: bmp.height };
        bmp.close?.();
        setUploadMsg(
          `업로드 중 · ${i + 1}/${list.length} · ${f.name} · 전체 ${Math.round((completedBytes / totalBytes) * 100)}%`
        );
        const blob = await upload(
          `project/${project.id}/source-${Date.now()}-${f.name}`,
          f,
          {
            access: "public",
            handleUploadUrl: "/api/source/blob-upload",
            abortSignal: controller.signal,
            onUploadProgress: (p) => {
              const overall = Math.min(
                100,
                Math.round(((completedBytes + p.loaded) / totalBytes) * 100)
              );
              const tail = p.percentage >= 100 ? " · 저장 마무리 중…" : "";
              setUploadMsg(
                `업로드 중 · ${i + 1}/${list.length} · ${f.name} · 전체 ${overall}%${tail}`
              );
            },
          }
        );
        if (cancelledRef.current) return;
        completedBytes += f.size;
        registered.push({ url: blob.url, width: dims.width, height: dims.height });
      }
      // 업로드된 URL·크기를 프로젝트에 등록(메타데이터만).
      setUploadMsg(`등록 중… (${registered.length}장)`);
      const r = await fetch("/api/source/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, files: registered }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "등록 실패");
      setProject(d.project);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "업로드 실패";
      const aborted =
        e instanceof Error && (e.name === "AbortError" || /abort/i.test(msg));
      setError(aborted ? "업로드를 중지했어요." : msg);
    } finally {
      setBusy(false);
      setUploadMsg("");
      if (elapsedTimer.current) {
        clearInterval(elapsedTimer.current);
        elapsedTimer.current = null;
      }
      abortRef.current = null;
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function saveName() {
    setEditingName(false);
    const nm = nameVal.trim();
    if (!nm || nm === project.name) return;
    setProject((p) => ({ ...p, name: nm }));
    await fetch(`/api/project/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: nm }),
    }).catch(() => {});
  }

  async function runSplit() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/split", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "분할 실패");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, source: { ...prev.steps.source, status: "running" } },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "분할 실패");
    } finally {
      setBusy(false);
    }
  }

  // ★useCallback 필수 — BoundaryEditor 의 자동저장 디바운스가 onSave 를 deps 로 쓴다.
  //   매 렌더 새 함수면 타이머가 렌더마다 리셋돼 저장이 밀리거나 아예 안 된다.
  const saveRegions = useCallback(async (regions: SavedRegion[]) => {
    const r = await fetch("/api/boundaries", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, regions }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error ?? "저장 실패");
    setProject((prev) => ({ ...prev, scenes: d.scenes }));
  }, [project.id]);

  // 재생성 요청 컷을 '생성 중'으로 표시(값=요청 시 옛 이미지 url → 새 url 로 바뀌면 해제).
  function markRegenPending(ids?: string[]): string[] {
    const targetIds =
      ids && ids.length
        ? ids
        : project.scenes.filter((s) => s.originalImage && s.cut?.type !== "text").map((s) => s.id);
    setRegenPending((prev) => {
      const n = new Map(prev);
      for (const id of targetIds) {
        const sc = project.scenes.find((s) => s.id === id);
        n.set(id, sc?.generatedImage ?? "");
      }
      return n;
    });
    return targetIds;
  }
  function clearRegenPending(ids: string[]) {
    setRegenPending((prev) => {
      const n = new Map(prev);
      for (const id of ids) n.delete(id);
      return n;
    });
  }

  async function runRegenJob() {
    setBusy(true);
    setError("");
    // 섹션 활성 시 그 섹션 컷만(부분 작업·서버 부하↓). 전체면 기존대로 서버가 전 컷 처리.
    const secIds = sec
      ? project.scenes.filter((s) => sec.ids.has(s.id) && s.originalImage && s.cut?.type !== "text").map((s) => s.id)
      : null;
    const pend = markRegenPending(secIds ?? undefined);
    try {
      const body = secIds
        ? { projectId: project.id, sceneIds: secIds, models: Object.fromEntries(secIds.map((id) => [id, modelFor(id)])) }
        : { projectId: project.id, model: genModel };
      const r = await fetch("/api/regen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "재생성 실패");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, regen: { ...prev.steps.regen, status: "running" } },
      }));
    } catch (e) {
      clearRegenPending(pend);
      setError(e instanceof Error ? e.message : "재생성 실패");
    } finally {
      setBusy(false);
    }
  }

  // 컷 내용 편집(묘사·대사 등) → 로컬 반영 + 700ms 디바운스 자동 저장(단일 Project 라 앞단계 싱크).
  const cutSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  function updateCut(sceneId: string, patch: Partial<CutOntology>) {
    setProject((prev) => ({
      ...prev,
      scenes: prev.scenes.map((s) =>
        s.id === sceneId ? { ...s, cut: { ...(s.cut ?? blankCut()), ...patch } } : s
      ),
    }));
    clearTimeout(cutSaveTimers.current[sceneId]);
    cutSaveTimers.current[sceneId] = setTimeout(() => {
      const cut = projectRef.current.scenes.find((s) => s.id === sceneId)?.cut;
      if (!cut) return;
      fetch("/api/cut", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, sceneId, cut }),
      }).catch(() => {});
    }, 700);
  }

  // ★대사(말풍선)를 다른 씬으로 이동 — 4단계 연출 보고서에서 드래그앤드롭(앞/뒤 씬으로).
  //   OCR 이 대사를 옆 컷에 붙였을 때 사람이 옮겨 바로잡음. 출발·도착 두 컷 모두 저장.
  function moveBubbleToScene(srcId: string, srcIdx: number, targetId: string) {
    if (!srcId || srcId === targetId || srcIdx < 0) return;
    const src = project.scenes.find((s) => s.id === srcId);
    const bub = src?.cut?.bubbles?.[srcIdx];
    if (!bub) return;
    const target = project.scenes.find((s) => s.id === targetId);
    updateCut(srcId, { bubbles: (src?.cut?.bubbles ?? []).filter((_, i) => i !== srcIdx) });
    updateCut(targetId, { bubbles: [...(target?.cut?.bubbles ?? []), bub] });
  }

  // 읽기순(order) 이웃 컷. dir=prev(위)/next(아래). 양끝이면 null.
  function adjacentScene(sceneId: string, dir: "prev" | "next") {
    const sorted = [...project.scenes].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((s) => s.id === sceneId);
    if (idx < 0) return null;
    return sorted[dir === "prev" ? idx - 1 : idx + 1] ?? null;
  }

  // 한 컷 안에서 대사(말풍선) 순서를 위/아래로 바꾸기. d=-1 위, +1 아래.
  function reorderBubble(sceneId: string, bi: number, d: -1 | 1) {
    const src = project.scenes.find((s) => s.id === sceneId);
    const bubs = src?.cut?.bubbles;
    if (!bubs) return;
    const j = bi + d;
    if (j < 0 || j >= bubs.length) return;
    const nb = [...bubs];
    [nb[bi], nb[j]] = [nb[j], nb[bi]];
    updateCut(sceneId, { bubbles: nb });
  }

  // 이 대사 줄을 '무성영화 자막 씬'으로 분리 — 검은 화면+테두리에 자막·더빙만 나오는 씬.
  async function makeCardScene(sceneId: string, bi: number) {
    try {
      const r = await fetch("/api/scene", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, sceneId, bubbleIndex: bi }),
      });
      const d = await r.json();
      if (d.ok && d.project) setProject(d.project);
      else alert(d.error ?? "자막 씬 분리 실패");
    } catch {
      alert("자막 씬 분리 실패(네트워크)");
    }
  }

  // 이 줄(말풍선)의 자막 위치 지정/해제 — 같은 칸 다시 클릭하면 해제(컷 기본으로 복귀).
  function setBubblePos(sceneId: string, bi: number, fx: number | null, fy: number | null) {
    const src = project.scenes.find((x) => x.id === sceneId);
    const nb = (src?.cut?.bubbles ?? []).map((x, i) =>
      i === bi ? { ...x, subtitleX: fx ?? undefined, subtitleY: fy ?? undefined } : x
    );
    updateCut(sceneId, { bubbles: nb });
  }

  // 이 대사(말풍선)를 앞(위)/뒤(아래) 컷으로 옮기기 — 자동 부착이 틀렸을 때 수동 교정.
  function moveBubble(sceneId: string, bi: number, dir: "prev" | "next") {
    const target = adjacentScene(sceneId, dir);
    const src = project.scenes.find((s) => s.id === sceneId);
    const b = src?.cut?.bubbles?.[bi];
    if (!target || !b) return;
    const tb = target.cut?.bubbles ?? [];
    // 위로=뒤에 붙임, 아래로=앞에 붙임(읽기 흐름에 맞게).
    // ★옮기면 양쪽 컷 길이를 auto(durationSec 해제)로 되돌려, 바뀐 대사량에 맞게 자동 재계산.
    updateCut(target.id, { bubbles: dir === "prev" ? [...tb, b] : [b, ...tb], durationSec: undefined });
    updateCut(sceneId, {
      bubbles: (src.cut?.bubbles ?? []).filter((_, i) => i !== bi),
      durationSec: undefined,
    });
  }

  // 대사(말풍선) 칸 추가 — 빈 말풍선 하나 더. 단일 dialogue 만 있으면 그걸 첫 말풍선으로.
  function addBubble(sceneId: string) {
    const s = project.scenes.find((x) => x.id === sceneId);
    const cur =
      s?.cut?.bubbles ??
      (s?.cut?.dialogue?.trim()
        ? [{ text: s.cut.dialogue.trim(), ...(s.cut.dialogueTranslation?.trim() ? { translation: s.cut.dialogueTranslation.trim() } : {}) }]
        : []);
    updateCut(sceneId, { bubbles: [...cur, { text: "" }], dialogue: "", dialogueTranslation: undefined });
  }

  // 캐릭터 썸네일(화자 아바타용) — realImage 우선, 없으면 대표 컷 이미지. 없으면 null.
  function charThumb(charId?: string | null): string | null {
    if (!charId) return null;
    const c = project.cast?.find((x) => x.id === charId);
    if (!c) return null;
    if (c.realImage) return c.realImage;
    const rs = c.refSceneId ? project.scenes.find((x) => x.id === c.refSceneId) : null;
    return rs?.generatedImage || rs?.originalImage || null;
  }

  // 대사 편집기(3·4단계 공용) — 말풍선별로 [화자 아바타+선택][대사][삭제]. 없으면 한 줄 dialogue.
  // ★두 단계가 이 하나를 함께 써서 자막/대사가 항상 싱크됨(위서 고치면 아래도, 아래서 고치면 위도).
  //   삭제 = 대사 아닌 걸 잘못 읽었을 때 그 항목 제거. 화자 = 이 대사를 말하는 캐릭터(더빙 목소리).
  function dialogueEditor(s: Project["scenes"][number]) {
    const bubs = s.cut?.bubbles ?? [];
    const cast = project.cast ?? [];
    const inputCls =
      "min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-1 text-[11px]";
    const selCls =
      "shrink-0 max-w-[92px] rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 py-1 text-[10px]";
    const delCls =
      "shrink-0 rounded border border-[var(--border)] px-1.5 py-1 leading-none text-[var(--muted)] hover:border-[var(--danger)] hover:text-[var(--danger)]";
    const first = adjacentScene(s.id, "prev") == null;
    const last = adjacentScene(s.id, "next") == null;
    const avatar = (charId?: string | null) => {
      if (charId === SFX_SPEAKER)
        return (
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[var(--accent)] text-[10px]" title="효과음">
            💥
          </span>
        );
      const th = charThumb(charId);
      return th ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={th} alt="" className="h-5 w-5 shrink-0 rounded-full border border-[var(--border)] object-cover" />
      ) : (
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-dashed border-[var(--border)] text-[8px] text-[var(--muted)]">
          나
        </span>
      );
    };
    const speakerSelect = (value: string | null | undefined, onPick: (v: string | null) => void) => (
      <select value={value ?? ""} onChange={(e) => onPick(e.target.value || null)} className={selCls} title="이 줄의 화자 — 캐릭터(입 움직임)/내레이션(입 안 움직임)/효과음(소리 생성)">
        <option value="">🎙 내레이터</option>
        <option value={SFX_SPEAKER}>효과음</option>
        {cast.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
    );
    const stackCls =
      "leading-none px-1 text-[9px] text-[var(--muted)] hover:text-[var(--accent)] disabled:opacity-20";
    const rows = (t: string) => Math.min(4, (t.match(/\n/g)?.length ?? 0) + 1); // 줄 수만큼 커짐(최대 4)
    // 단어 클릭 강조(aninews 방식) — 문장을 그대로 보여주고, 단어를 클릭하면 인라인으로 강조
    // (골드·굵게) 토글. 칩(테두리)로 나열하지 않는다. onClick → [[ ]] 토글.
    const emphChips = (bi: number, text: string) => {
      const toks = wordTokens(text ?? "");
      if (!toks.some((t) => !t.space)) return null;
      return (
        <div className="ml-6 rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-[11px] leading-relaxed">
          <span className="mr-1 select-none text-[9px] text-[var(--muted)]">강조 (단어 클릭)</span>{" "}
          {toks.map((t, i) =>
            t.space ? (
              <span key={i}>{t.text}</span>
            ) : (
              <span
                key={i}
                role="button"
                tabIndex={0}
                onClick={() => {
                  const nb = (s.cut?.bubbles ?? []).map((x, j) => (j === bi ? { ...x, text: toggleWordEmphasis(x.text, i) } : x));
                  updateCut(s.id, { bubbles: nb });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    const nb = (s.cut?.bubbles ?? []).map((x, j) => (j === bi ? { ...x, text: toggleWordEmphasis(x.text, i) } : x));
                    updateCut(s.id, { bubbles: nb });
                  }
                }}
                className={`cursor-pointer rounded-sm ${
                  t.em ? "font-bold text-[#c99a00]" : "text-[var(--text)] hover:bg-[#ffd23f]/25"
                }`}
              >
                {t.text}
              </span>
            )
          )}
        </div>
      );
    };
    if (bubs.length > 0) {
      return (
        <div className="flex flex-col gap-0.5">
          {bubs.map((b, bi) => {
            const advKey = `${s.id}:${bi}`;
            const advOpen = advBub.has(advKey);
            const isSfx = b.speakerId === SFX_SPEAKER;
            // 접힌 상태에서도 뭔가 설정돼 있으면 ⚙ 를 강조해 "숨겨진 값 있음"을 알린다.
            const advSet = !!b.emotion || typeof b.subtitleY === "number" || typeof b.subtitleX === "number";
            return (
            <div key={bi} className="flex flex-col gap-0.5">
              <div className="flex items-start gap-1">
              {/* 순서/이동 — ⠿ 드래그해서 다른 컷으로, ▲▼ 이 컷 안 순서. 더빙 단계에서도 바로 쓰라고 꺼내 둠. */}
              <div className="flex shrink-0 flex-col items-center pt-0.5 leading-none text-[var(--muted)]">
                <span
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/x-bubble", JSON.stringify({ srcId: s.id, srcIdx: bi }));
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  title="드래그해서 앞/뒤 컷으로 옮기기"
                  className="cursor-grab select-none text-[11px] active:cursor-grabbing hover:text-[var(--accent)]"
                >
                  ⠿
                </span>
                {bubs.length > 1 && (
                  <>
                    <button type="button" onClick={() => reorderBubble(s.id, bi, -1)} disabled={bi === 0} className={stackCls} title="이 컷 안에서 위로">▲</button>
                    <button type="button" onClick={() => reorderBubble(s.id, bi, 1)} disabled={bi === bubs.length - 1} className={stackCls} title="이 컷 안에서 아래로">▼</button>
                  </>
                )}
              </div>
              <div className="pt-0.5">{avatar(b.speakerId)}</div>
              {speakerSelect(b.speakerId, (v) => {
                const nb = (s.cut?.bubbles ?? []).map((x, i) => (i === bi ? { ...x, speakerId: v } : x));
                updateCut(s.id, { bubbles: nb });
              })}
              <textarea
                value={b.text}
                onChange={(e) => {
                  const val = e.target.value;
                  const nb = (s.cut?.bubbles ?? []).map((x, i) => (i === bi ? { ...x, text: val } : x));
                  updateCut(s.id, { bubbles: nb });
                }}
                rows={rows(b.text)}
                placeholder={isSfx ? "효과음 (예: 웅성웅성, 쾅)" : `대사 ${bi + 1} (Enter=줄바꿈)`}
                className={`${inputCls} resize-none`}
              />
              {/* 감정 연기 — 더빙에서 바로 확인·조절하도록 항상 노출(접힘 밖). 자막엔 안 나감. */}
              {!isSfx && (
                <select
                  value={b.emotion ?? ""}
                  onChange={(e) => {
                    const v = e.target.value || undefined;
                    const nb = (s.cut?.bubbles ?? []).map((x, i) => (i === bi ? { ...x, emotion: v } : x));
                    updateCut(s.id, { bubbles: nb });
                  }}
                  title="감정 연기 — 더빙 시 연기(자막엔 안 나감)"
                  className={`shrink-0 rounded border bg-[var(--panel)] px-0.5 py-1 text-[10px] leading-none ${
                    b.emotion ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)]"
                  }`}
                >
                  <option value="">🎭</option>
                  {EMOTIONS.map((em) => (
                    <option key={em.id} value={em.id}>{em.label}</option>
                  ))}
                </select>
              )}
              {/* 세부(⚙) 토글 — 자막위치·순서이동·무성씬을 펼침/접음. */}
              {!isSfx && (
                <button
                  type="button"
                  onClick={() => toggleAdv(advKey)}
                  title="세부 — 감정·자막위치·순서 이동·무성 자막씬"
                  className={`shrink-0 rounded border px-1.5 py-1 leading-none ${
                    advOpen || advSet
                      ? "border-[var(--accent)] text-[var(--accent)]"
                      : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  }`}
                >
                  ⚙️
                </button>
              )}
              {b.audioUrl ? (
                <button
                  type="button"
                  onClick={() => playAudio(b.audioUrl!)}
                  title={isSfx ? "효과음 생성됨 — 듣기" : "더빙됨 — 듣기"}
                  className="shrink-0 rounded border border-[var(--ok)] px-1.5 py-1 leading-none text-[var(--ok)] hover:bg-[var(--panel-2)]"
                >
                  🔊
                </button>
              ) : (
                <span
                  title="아직 더빙 안 됨 — 🎙 더빙 누르세요"
                  className="shrink-0 rounded border border-dashed border-[var(--border)] px-1.5 py-1 leading-none text-[var(--muted)] opacity-60"
                >
                  🔇
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  const nb = (s.cut?.bubbles ?? []).filter((_, i) => i !== bi);
                  updateCut(s.id, { bubbles: nb });
                }}
                title="이 대사 삭제(대사 아닌 걸 잘못 읽었을 때)"
                className={delCls}
              >
                ×
              </button>
              </div>
              {/* 번역(편집자용 주석) — 외국어 원문 아래 한국어 뜻. 더빙은 원문으로 나감. */}
              {!isSfx && (b.translation || "").trim() && (
                <div className="pl-7 text-[11px] font-medium text-[var(--accent)]" title="편집·화자 파악용 번역 (더빙은 원문 그대로)">
                  {b.translation}
                </div>
              )}
              {/* 언어별 번역(스펙 §10) — 대상 언어(🌐) 켜져 있으면 원어·한국어 아래에 각 언어 표시·인라인 수정.
                  값은 재추출 시 워커가 자동으로 채우고(원어→언어별), 여기서 손볼 수 있다. */}
              {!isSfx && (project.targetLanguages?.length ?? 0) > 0 && (
                <div className="ml-7 mt-0.5 flex flex-col gap-0.5">
                  {project.targetLanguages!.map((lang) => {
                    const langLabel = LANGUAGES.find((l) => l.id === lang)?.label ?? lang;
                    return (
                      <div key={lang} className="flex items-center gap-1 text-[11px]">
                        <span className="w-7 shrink-0 text-[10px] uppercase text-[var(--muted)]" title={langLabel}>
                          {lang}
                        </span>
                        <input
                          type="text"
                          value={b.tracks?.[lang]?.text ?? ""}
                          placeholder={`${langLabel} 번역 — 재추출 시 자동`}
                          onChange={(e) => {
                            const val = e.target.value;
                            const nb = (s.cut?.bubbles ?? []).map((x, i) =>
                              i === bi
                                ? {
                                    ...x,
                                    tracks: {
                                      ...(x.tracks || {}),
                                      [lang]: { ...(x.tracks?.[lang] || {}), text: val, status: "translated" as const },
                                    },
                                  }
                                : x,
                            );
                            updateCut(s.id, { bubbles: nb });
                          }}
                          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 py-0.5"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
              {/* ── 세부 컨트롤(접힘 기본) — 감정·자막위치·순서이동·무성씬·강조 ── */}
              {!isSfx && advOpen && (
                <div className="ml-7 flex flex-wrap items-center gap-2 rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1">
                  {/* 자막 위치 9분할 */}
                  <label className="flex items-center gap-1 text-[10px] text-[var(--muted)]" title="이 줄 자막 위치 — 다시 클릭하면 해제(컷 기본)">
                    자막
                    <div className="grid grid-cols-3 gap-px self-center rounded border border-[var(--border)] p-0.5">
                      {SUB_Y.map((fy) =>
                        SUB_X.map((fx) => {
                          const active =
                            typeof b.subtitleX === "number" &&
                            typeof b.subtitleY === "number" &&
                            Math.abs(b.subtitleX - fx) < 0.03 &&
                            Math.abs(b.subtitleY - fy) < 0.03;
                          return (
                            <button
                              key={`${fx}-${fy}`}
                              type="button"
                              onClick={() => (active ? setBubblePos(s.id, bi, null, null) : setBubblePos(s.id, bi, fx, fy))}
                              className={`h-2.5 w-2.5 rounded-[1px] ${active ? "bg-[var(--accent)]" : "bg-[var(--panel)] hover:bg-[var(--border)]"}`}
                            />
                          );
                        })
                      )}
                    </div>
                  </label>
                  {/* 볼륨·거리감 — 합성 시 이 줄 오디오에 적용(멀리서=먹먹+반향). 미리보기엔 근사만. */}
                  <label className="flex items-center gap-1 text-[10px] text-[var(--muted)]" title="이 줄 목소리 크기 — 합성 결과에 반영">
                    🔊
                    <select
                      value={String(b.volume ?? 1)}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        const nb = (s.cut?.bubbles ?? []).map((x, i) => (i === bi ? { ...x, volume: v === 1 ? undefined : v } : x));
                        updateCut(s.id, { bubbles: nb });
                      }}
                      className={`rounded border bg-[var(--panel)] px-0.5 py-0.5 text-[10px] ${
                        b.volume && b.volume !== 1 ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)]"
                      }`}
                    >
                      <option value="0.4">아주작게</option>
                      <option value="0.7">작게</option>
                      <option value="1">보통</option>
                      <option value="1.5">크게</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const nb = (s.cut?.bubbles ?? []).map((x, i) => (i === bi ? { ...x, distant: !x.distant } : x));
                      updateCut(s.id, { bubbles: nb });
                    }}
                    title="멀리서 들리는 느낌(거리감) — 합성 시 먹먹하게+약한 반향+감쇠"
                    className={`rounded border px-1 py-0.5 text-[10px] leading-none ${
                      b.distant ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]"
                    }`}
                  >
                    🌫 멀리서
                  </button>
                  {/* 자막 빼기 — 비명·효과음성 대사 등. 소리는 나되(더빙 유지) 자막엔 안 뜸. */}
                  <button
                    type="button"
                    onClick={() => {
                      const nb = (s.cut?.bubbles ?? []).map((x, i) => (i === bi ? { ...x, noSubtitle: !x.noSubtitle } : x));
                      updateCut(s.id, { bubbles: nb });
                    }}
                    title="자막에서 빼기 — 소리는 나되(더빙 유지) 자막엔 안 뜸. 비명·효과음성 대사에."
                    className={`rounded border px-1 py-0.5 text-[10px] leading-none ${
                      b.noSubtitle ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]"
                    }`}
                  >
                    🚫 자막빼기
                  </button>
                  {/* 순서 이동(▲▼) — 이 컷 안 */}
                  {bubs.length > 1 && (
                    <span className="flex items-center" title="이 컷 안에서 순서 바꾸기">
                      <button type="button" onClick={() => reorderBubble(s.id, bi, -1)} disabled={bi === 0} className={stackCls} title="위로">▲</button>
                      <button type="button" onClick={() => reorderBubble(s.id, bi, 1)} disabled={bi === bubs.length - 1} className={stackCls} title="아래로">▼</button>
                    </span>
                  )}
                  {/* 앞/뒤 컷으로(↑↓) */}
                  <span className="flex items-center" title="앞/뒤 컷으로 보내기">
                    <button type="button" onClick={() => moveBubble(s.id, bi, "prev")} disabled={first} className={stackCls} title="위 컷으로">↑</button>
                    <button type="button" onClick={() => moveBubble(s.id, bi, "next")} disabled={last} className={stackCls} title="아래 컷으로">↓</button>
                  </span>
                  {/* 무성 자막씬으로 분리 */}
                  <button
                    type="button"
                    onClick={() => makeCardScene(s.id, bi)}
                    disabled={busy}
                    title="이 대사를 무성영화 자막 씬으로 분리 — 검은 화면+자막·더빙만"
                    className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
                  >
                    🎬 자막씬
                  </button>
                  <div className="basis-full">{emphChips(bi, b.text)}</div>
                </div>
              )}
            </div>
            );
          })}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => addBubble(s.id)}
              className="rounded border border-dashed border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              + 대사 추가
            </button>
            <span className="text-[10px] text-[var(--muted)] opacity-70">
              강조: <code className="text-[#c99a00]">[[말]]</code>
            </span>
          </div>
        </div>
      );
    }
    // 말풍선이 아직 없으면 한 줄 입력 + 화자(cut.speakerId) + 지우기 + 대사 추가.
    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-start gap-1">
          <div className="pt-0.5">{avatar(s.cut?.speakerId)}</div>
          {speakerSelect(s.cut?.speakerId, (v) => updateCut(s.id, { speakerId: v }))}
          <textarea
            value={s.cut?.dialogue ?? ""}
            onChange={(e) => updateCut(s.id, { dialogue: e.target.value })}
            rows={rows(s.cut?.dialogue ?? "")}
            placeholder="대사 (Enter=줄바꿈)"
            className={`${inputCls} resize-none`}
          />
          <button
            type="button"
            onClick={() => updateCut(s.id, { dialogue: "" })}
            title="대사 지우기"
            className={delCls}
          >
            ×
          </button>
        </div>
        {(s.cut?.dialogueTranslation || "").trim() && (
          <div className="pl-7 text-[11px] font-medium text-[var(--accent)]" title="편집·화자 파악용 번역">
            {s.cut?.dialogueTranslation}
          </div>
        )}
        <button
          type="button"
          onClick={() => addBubble(s.id)}
          className="self-start rounded border border-dashed border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          + 대사 추가
        </button>
      </div>
    );
  }

  // 연출 보고서(자동 연출) — '한 컷' 분을 컷 카드마다 접이식으로. 큰 표로 스크롤 안 올라가도 그 컷에서
  //   바로 확인·보정. 대사(역)·화자·감정 / 카메라 / 길이 / 전환 / 동작. updateCut 로 큰 표·편집기와 즉시 싱크.
  function directionPanel(s: Project["scenes"][number]) {
    const cast = project.cast ?? [];
    const bubs = (s.cut?.bubbles ?? []).filter((b) => (b.text || "").trim() && b.speakerId !== SFX_SPEAKER);
    const dubText = (s.cut?.bubbles ?? []).map((b) => b.text).join(" ") + " " + (s.cut?.narration ?? "");
    const dubChars = dubText.replace(/\s+/g, "").length;
    const estSec = dubChars > 0 ? Math.max(2, Math.min(8, Math.round(dubChars / 5))) : s.cut?.type === "transition" ? 1.5 : 1;
    const cell = "rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 py-0.5 text-[10px]";
    return (
      <div className="flex flex-col gap-1.5 text-[11px]">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-[var(--muted)]">대사(역)·화자·감정</span>
          {bubs.length === 0 ? (
            <span className="text-[var(--muted)]">(대사 없음)</span>
          ) : (
            bubs.map((b, bi) => (
              <div key={bi} className="flex flex-wrap items-center gap-1">
                <span className="text-[var(--text)]" title={b.text}>“{b.text.slice(0, 40)}”</span>
                {(b.translation || "").trim() && (
                  <span className="font-medium text-[var(--accent)]">· {b.translation!.slice(0, 40)}</span>
                )}
                <select
                  value={b.speakerId ?? ""}
                  onChange={(e) =>
                    updateCut(s.id, { bubbles: (s.cut?.bubbles ?? []).map((x) => (x === b ? { ...x, speakerId: e.target.value || null } : x)) })
                  }
                  className={`${cell} ${b.speakerId ? "text-[var(--accent)]" : "text-[var(--muted)]"}`}
                  title="화자"
                >
                  <option value="">🎙 내레이터</option>
                  {cast.map((c) => (<option key={c.id} value={c.id}>{c.label}</option>))}
                </select>
                <select
                  value={b.emotion ?? ""}
                  onChange={(e) =>
                    updateCut(s.id, { bubbles: (s.cut?.bubbles ?? []).map((x) => (x === b ? { ...x, emotion: e.target.value || undefined } : x)) })
                  }
                  className={cell}
                  title="감정 연기"
                >
                  <option value="">🎭</option>
                  {EMOTIONS.map((em) => (<option key={em.id} value={em.id}>{em.label}</option>))}
                </select>
              </div>
            ))
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex items-center gap-1" title="카메라 프리셋. 실제 카메라워크는 카드의 '후처리 카메라(줌·팬)'가 담당.">
            <span className="text-[10px] text-[var(--muted)]">카메라</span>
            <select
              value={camIdFromMotion(s.cut?.motion)}
              onChange={(e) => updateCut(s.id, { motion: setCamMotion(e.target.value, s.cut?.motion) })}
              className={cell}
            >
              <option value="">(없음)</option>
              {CAMERA_MOVES.map(([id, label]) => (<option key={id} value={id}>{label}</option>))}
            </select>
          </label>
          <label className="flex items-center gap-1" title="컷 길이(초) — 비우면 자동 추정">
            <span className="text-[10px] text-[var(--muted)]">길이</span>
            <input
              type="number"
              step={0.5}
              min={0.5}
              max={15}
              value={s.cut?.durationSec ?? ""}
              placeholder={String(estSec)}
              onChange={(e) => {
                const v = e.target.value;
                updateCut(s.id, { durationSec: v === "" ? undefined : Math.max(0.5, Math.min(15, Math.round(Number(v) * 2) / 2)) });
              }}
              className={`${cell} w-12`}
            />
          </label>
          <label className="flex items-center gap-1" title="이 컷 → 다음 컷 전환(합성 시)">
            <span className="text-[10px] text-[var(--muted)]">전환</span>
            <select value={s.cut?.transition ?? "none"} onChange={(e) => updateCut(s.id, { transition: e.target.value })} className={cell}>
              {TRANSITIONS.map(([id, label]) => (<option key={id} value={id}>{label}</option>))}
            </select>
          </label>
          <label className="flex min-w-[8rem] flex-1 items-center gap-1" title="직접 입력(버튼에 없는 동작). 버튼을 고르면 그게 우선.">
            <span className="text-[10px] text-[var(--muted)]">직접</span>
            <input
              type="text"
              value={s.cut?.action ?? ""}
              onChange={(e) => updateCut(s.id, { action: e.target.value })}
              placeholder="예: 고개를 든다"
              className={`${cell} min-w-0 flex-1`}
            />
          </label>
        </div>
        {/* 인물 몸동작 — 버튼으로 지정(모두 절제된 동작). 버튼이 자유입력(직접)보다 우선. */}
        <div className="flex flex-wrap items-center gap-1" title="이 컷 인물 몸동작 — 버튼으로 지정. 다시 누르면 해제(기본=이어가기).">
          <span className="text-[10px] text-[var(--muted)]">🎬 동작</span>
          {BODY_MOTIONS.map(([id, label]) => {
            const on = s.cut?.bodyMotion === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => updateCut(s.id, { bodyMotion: on ? undefined : id })}
                className={`rounded border px-1.5 py-0.5 text-[10px] ${
                  on ? "border-[var(--accent)] font-medium text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]"
                }`}
              >
                {label}
              </button>
            );
          })}
          {/* 기본은 사진·표지 속 인물 정지. 가끔 움직여야 하면 켜기. */}
          <button
            type="button"
            onClick={() => updateCut(s.id, { animatePicture: s.cut?.animatePicture ? undefined : true })}
            title="기본: 사진·초상·표지 속 인물은 정지. 이 컷에서 그림 속 인물도 움직여야 하면 켜세요."
            className={`rounded border px-1.5 py-0.5 text-[10px] ${
              s.cut?.animatePicture ? "border-[var(--accent)] font-medium text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]"
            }`}
          >
            🖼 사진 속도 움직임
          </button>
        </div>
      </div>
    );
  }

  // 출력 비율 선택(세로/가로/1:1) — 모든 컷이 이 비율로 일관되게 생성됨.
  async function setAspect(aspectRatio: "16:9" | "9:16" | "1:1") {
    setProject((prev) => ({ ...prev, aspectRatio }));
    await fetch(`/api/project/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aspectRatio }),
    }).catch(() => {});
  }

  // 더빙 말 속도(프로젝트 레벨) — 1=기본, 1.2=조금 빠르게. 저장 후 다음 더빙부터 적용.
  async function setDubSpeed(v: number) {
    setProject((prev) => ({ ...prev, dubSpeed: v }));
    await fetch(`/api/project/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dubSpeed: v }),
    }).catch(() => {});
  }
  // 스토리 맥락(프로젝트 레벨) — 모든 영상 프롬프트에 주입. onChange=로컬 즉시, onBlur=서버 저장.
  async function saveStoryContext(v: string) {
    await fetch(`/api/project/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storyContext: v }),
    }).catch(() => {});
  }
  // I2V 영상 엔진(§4) — 자동(키 유무)/Kling/Grok. Kling 만 첫+끝 프레임 보간(액션) 가능.
  async function setVideoEngine(v: "grok" | "kling" | "auto") {
    setProject((prev) => ({ ...prev, videoEngine: v === "auto" ? undefined : v }));
    await fetch(`/api/project/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(v === "auto" ? { videoEngine: null } : { videoEngine: v }),
    }).catch(() => {});
  }
  // 작업 언어(§10) — 화면 표시·더빙·자막이 이 언어로. ""=원어. 더빙/합성이 tracks[lang] 를 씀.
  async function setWorkingLanguage(lang: string) {
    setProject((prev) => ({ ...prev, workingLanguage: lang || undefined }));
    await fetch(`/api/project/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workingLanguage: lang }),
    }).catch(() => {});
  }
  // 번역·출력 대상 언어(§10) — 토글. 켜면 다음 컷 추출부터 tracks 채움(기존 컷은 재추출 시 반영).
  async function toggleTargetLanguage(lang: string) {
    // ★함수형 업데이트로 최신 상태에서 계산(빠른 연속 클릭 시 stale 클로저로 한 토글이 유실되던 것 방지).
    let next: string[] = [];
    setProject((prev) => {
      const cur = prev.targetLanguages ?? [];
      next = cur.includes(lang) ? cur.filter((l) => l !== lang) : [...cur, lang];
      return { ...prev, targetLanguages: next };
    });
    await fetch(`/api/project/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetLanguages: next }),
    }).catch(() => {});
  }
  // 🌐 번역만 다시 — 재추출 없이 대상 언어 번역을 채운다. 끝나면 프로젝트를 다시 읽어 반영.
  async function runTranslateJob() {
    setError("");
    setTranslating(true);
    try {
      const r = await fetch("/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "번역 실패");
      // 잡 완료까지 폴링(텍스트만이라 보통 수십 초). 로그는 상시 패널에 흐른다.
      for (;;) {
        await new Promise((res) => setTimeout(res, 3000));
        const q = await fetch(`/api/translate?jobId=${d.jobId}&projectId=${project.id}`, { cache: "no-store" });
        const s = await q.json();
        if (s.ok) {
          setProgress(s.progress ?? "");
          setProgressLog(s.progressLog ?? []);
          if (s.status === "error") throw new Error(s.error ?? "번역 실패");
          if (s.status === "done") break;
        }
      }
      // 번역 결과를 화면에 반영 — 씬만 다시 읽어 덮는다(편집 중 다른 필드 보호는 서버가 머지).
      const pr = await fetch(`/api/project/${project.id}`, { cache: "no-store" });
      const pd = await pr.json();
      if (pd?.ok && pd.project?.scenes) {
        setProject((prev) => ({ ...prev, scenes: pd.project.scenes }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "번역 실패");
    } finally {
      setTranslating(false);
    }
  }

  // 🌐 대상 언어 토글 — ★1단계와 4단계 양쪽에서 같은 컨트롤을 쓴다.
  //   다국어 번역은 '추출'(1단계 후반)에서 채워지는데, 예전엔 이 토글이 4단계 안에만 있었고
  //   그나마 재생성 이미지가 하나라도 있어야 보였다 → 효과가 나는 시점보다 한참 뒤에야 켤 수
  //   있어서 "일본어·영어 어디 갔냐"가 됐다. 켜야 할 시점(추출 전)에 보이게 1단계에도 둔다.
  function targetLangToggles() {
    return (
      <div
        className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]"
        title="선택한 언어로 대사를 번역해 언어별 버전 출력에 사용(스펙 §10). ★추출 때 채워지므로 추출 전에 켜세요(이미 추출한 프로젝트는 재추출하면 반영)."
      >
        <span className="text-[var(--muted)]">🌐 대상 언어</span>
        {LANGUAGES.map((l) => {
          const on = (project.targetLanguages ?? []).includes(l.id);
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => toggleTargetLanguage(l.id)}
              className={`rounded border px-1.5 py-0.5 ${on ? "border-[var(--accent)] font-medium text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--panel-2)]"}`}
            >
              {on ? "✓ " : ""}{l.label}
            </button>
          );
        })}
        <span className="text-[var(--muted)]">· 한국어는 항상 병기</span>
        {/* ★이미 추출을 끝낸 프로젝트를 위한 길 — 예전엔 다국어 번역이 '추출' 안에서만 돌아서,
            켜도 tracks 가 영영 비어 있고 채우려면 전 컷 재추출(재OCR·재업로드)뿐이었다. */}
        {(project.targetLanguages?.length ?? 0) > 0 && (
          <button
            type="button"
            onClick={runTranslateJob}
            disabled={translating}
            className="rounded border border-[var(--accent)] px-2 py-0.5 text-[var(--accent)] hover:bg-[var(--panel-2)] disabled:opacity-50"
            title="지금 있는 대사를 선택한 언어로 번역해 채웁니다. 텍스트만 다루므로 빠르고 쌉니다(재추출 불필요)."
          >
            {translating ? "번역 중…" : "🌐 지금 번역 채우기"}
          </button>
        )}
      </div>
    );
  }

  // 이 컷의 '자동 조립 프롬프트' 초안(영문) — 프롬프트 직접 편집 시작점. 워커 buildVideoPrompt 와 같은 취지.
  function composeVideoPromptDraft(s: Project["scenes"][number]): string {
    const cut = s.cut;
    const parts = [
      "Camera is completely STATIC (locked, fixed frame) — no pan, tilt, zoom, dolly or shake. Bring the still subtly to life with only small, slow, restrained motion; avoid any large, fast or exaggerated movement. Keep each character's facial expression exactly as drawn; do not change the emotion. Anyone shown inside a photo, portrait, poster, cover, painting or screen is a static image — keep them completely still. Do not add characters or objects not in the still; keep the art style; no text.",
    ];
    const story = (project.storyContext ?? "").trim();
    if (story) parts.push(`Story context (the motion must NOT contradict this): ${story}.`);
    const bm = BODY_MOTIONS.find(([id]) => id === cut?.bodyMotion);
    if (bm) parts.push(`Subject motion: ${bm[1]} (keep it small and slow).`);
    else if ((cut?.action ?? "").trim()) parts.push(`Subject action (small, slow): ${cut!.action}.`);
    if ((cut?.videoPrompt ?? "").trim()) parts.push(`What happens in this shot: ${cut!.videoPrompt}.`);
    return parts.join(" ");
  }

  // 나레이터 목소리(프로젝트 레벨) — 카탈로그에서 고른 값 저장. null=해제.
  async function setNarratorVoice(v: { provider: string; id: string; name: string } | null) {
    setProject((prev) => ({ ...prev, narratorVoice: v ?? undefined }));
    await fetch(`/api/project/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ narratorVoice: v }),
    }).catch(() => {});
  }

  // 컷별 모델 — 그때그때 컷마다 다른 모델 선택. 미지정 컷은 헤더 기본 모델(genModel) 사용.
  // (짧은 문자열 하나라 메모리 부담 없음. 워커도 라우팅 문자열로만 씀.)
  const [modelBySceneId, setModelBySceneId] = useState<Record<string, string>>({});
  const modelFor = (id: string) => modelBySceneId[id] ?? genModel;
  const setModelFor = (id: string, m: string) =>
    setModelBySceneId((prev) => ({ ...prev, [id]: m }));

  // 다중 선택 재생성 — 여러 컷 골라 한 번에(병렬 청크로 워커가 처리).
  const [selForRegen, setSelForRegen] = useState<Set<string>>(() => new Set());
  function toggleSel(id: string) {
    setSelForRegen((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  // 전체 선택 ↔ 해제(토글). 전체 선택 후 개별 체크 해제로 몇 개만 빼기 가능.
  function toggleSelectAllRegen() {
    const ids = project.scenes
      .filter((s) => s.originalImage && s.cut?.type !== "text")
      .map((s) => s.id);
    const all = ids.length > 0 && ids.every((id) => selForRegen.has(id));
    setSelForRegen(all ? new Set() : new Set(ids));
  }
  async function regenSelected() {
    if (selForRegen.size === 0) return;
    setError("");
    const ids = [...selForRegen];
    const models: Record<string, string> = {};
    for (const id of ids) models[id] = modelFor(id); // 컷별 선택 반영
    markRegenPending(ids);
    try {
      const r = await fetch("/api/regen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, sceneIds: ids, models }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "생성 실패");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, regen: { ...prev.steps.regen, status: "running" } },
      }));
      // ★선택을 비우지 않는다 — 중지 후 다시 돌리려는데 선택이 사라지면 매번 다시 골라야 함(사용자 지적).
    } catch (e) {
      clearRegenPending(ids);
      setError(e instanceof Error ? e.message : "생성 실패");
    }
  }

  // 안 그려진 컷만 마저 생성 — OOM 등으로 배치가 중간에 끊겨 일부만 된 경우, 나머지(생성 안
  // 됐거나 실패한 컷)만 골라 다시. 컷별 모델 반영. generatedImage 없는 컷 = 아직 안 됨/실패.
  async function regenMissing() {
    const ids = project.scenes
      .filter((s) => s.originalImage && s.cut?.type !== "text" && !s.generatedImage)
      .map((s) => s.id);
    if (ids.length === 0) return;
    setError("");
    const models: Record<string, string> = {};
    for (const id of ids) models[id] = modelFor(id);
    markRegenPending(ids);
    try {
      const r = await fetch("/api/regen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, sceneIds: ids, models }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "생성 실패");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, regen: { ...prev.steps.regen, status: "running" } },
      }));
    } catch (e) {
      clearRegenPending(ids);
      setError(e instanceof Error ? e.message : "생성 실패");
    }
  }

  // 재생성 방식(프로젝트 전체 공통). 기술용어(마스크) 대신 쉬운 이름으로 노출.
  function setProjectRegenMode(mode: "mask" | "full") {
    setProject((prev) => ({ ...prev, regenMode: mode }));
    fetch(`/api/project/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ regenMode: mode }),
    }).catch(() => {});
  }

  // 이후 단계(M3)에서도 컷 분할 — 서브컷 추출+글씨읽기까지 워커가. regen 폴링으로 반영.
  async function splitCutM3(sceneId: string) {
    setError("");
    try {
      const r = await fetch("/api/splitcut", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, sceneId }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "분할 실패");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, regen: { ...prev.steps.regen, status: "running" } },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "분할 실패");
    }
  }

  // M3 컷 합병(앞/뒤) — 합친 영역 추출+글씨읽기까지 워커가. regen 폴링으로 반영.
  async function mergeCutM3(sceneId: string, dir: "prev" | "next") {
    setError("");
    try {
      const r = await fetch("/api/mergecut", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, sceneId, dir }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "합병 실패");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, regen: { ...prev.steps.regen, status: "running" } },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "합병 실패");
    }
  }

  // M3 컷 삭제 — 재추출 불필요, 즉시 로컬 반영 + 서버 저장.
  function deleteCutM3(sceneId: string) {
    setProject((prev) => ({
      ...prev,
      scenes: prev.scenes.filter((s) => s.id !== sceneId).map((s, i) => ({ ...s, order: i })),
    }));
    fetch("/api/scene", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, sceneId }),
    }).catch(() => {});
  }

  // 컷 하나만 생성/다시 생성 — 배치 전에 싸게 충실도 테스트, 마음에 안 드는 컷 재생성.
  async function regenOne(sceneId: string) {
    setError("");
    markRegenPending([sceneId]);
    try {
      const r = await fetch("/api/regen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, sceneIds: [sceneId], model: modelFor(sceneId) }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "생성 실패");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, regen: { ...prev.steps.regen, status: "running" } },
      }));
    } catch (e) {
      clearRegenPending([sceneId]);
      setError(e instanceof Error ? e.message : "생성 실패");
    }
  }

  // Grok 영상(I2V) 잡 적재. sceneIds 없으면 재생성된 컷 전체.
  async function runVideoJob(sceneIds?: string[]) {
    setError("");
    // 명시 sceneIds 없고 섹션 활성이면 그 섹션의 재생성 컷만(부분 작업).
    const ids = sceneIds ?? (sec ? project.scenes.filter((s) => sec.ids.has(s.id) && s.generatedImage).map((s) => s.id) : undefined);
    try {
      const r = await fetch("/api/video", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, ...(ids ? { sceneIds: ids } : {}) }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "영상 실패");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, scene: { ...prev.steps.scene, status: "running" } },
      }));
    } catch (e) {
      // 적재 실패 시 '생성 중' 해제(안 그러면 스피너가 영영 돎). ids 없으면(전체) 전부.
      setVidPending((prev) => {
        if (!ids) return new Set();
        const n = new Set(prev);
        for (const id of ids) n.delete(id);
        return n;
      });
      setError(e instanceof Error ? e.message : "영상 실패");
    }
  }
  const videoOne = (sceneId: string) => {
    setVidPending((prev) => new Set(prev).add(sceneId));
    runVideoJob([sceneId]);
  };
  // 4단계 다중 선택 — 여러 컷 골라 한 번에 동영상 생성.
  function toggleVideoSel(id: string) {
    setSelForVideo((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleSelectAllVideo() {
    const ids = project.scenes.filter((s) => s.generatedImage && inSection(s)).map((s) => s.id);
    const all = ids.length > 0 && ids.every((id) => selForVideo.has(id));
    setSelForVideo(all ? new Set(selForVideo.size ? [...selForVideo].filter((id) => !ids.includes(id)) : []) : new Set([...selForVideo, ...ids]));
  }
  function videoSelected() {
    if (selForVideo.size === 0) return;
    const ids = [...selForVideo];
    setVidPending((prev) => new Set([...prev, ...ids]));
    runVideoJob(ids);
    setSelForVideo(new Set());
  }

  // 더빙(TTS) 잡 적재 — 대사(화자 목소리)·내레이션(나레이터). sceneIds 없으면 전체.
  // ★비디오(scene 단계)와 독립: 잡 상태를 따로 폴링해 동영상 생성 중에도 더빙을 걸 수 있다.
  const [dubbing, setDubbing] = useState(false); // 더빙 잡 진행 중(비디오와 무관)
  const dubPollRef = useRef<ReturnType<typeof setInterval> | null>(null); // 더빙 폴링 인터벌 — 정지 시 중단용
  const dubStartingRef = useRef(false); // 더빙 적재 진행 중(동기 가드) — fetch 도중 재클릭 이중 적재 방지
  const [dubMsg, setDubMsg] = useState<string | null>(null); // 더빙 완료/실패 안내(잠깐 표시)
  // ── 후처리 줌(postfx) — Grok 원본에 줌 커브를 실픽셀로 굽는 잡. fxUrl 이 미리보기·합성에 쓰임. ──
  async function runFxJob(sceneIds: string[], effect: string, strength: number, openPreviewId?: string) {
    setError("");
    setFxPending((prev) => new Set([...prev, ...sceneIds]));
    const clear = () =>
      setFxPending((prev) => {
        const n = new Set(prev);
        for (const id of sceneIds) n.delete(id);
        return n;
      });
    try {
      const r = await fetch("/api/postfx", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, sceneIds, effect, strength }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "후처리 실패");
      const iv = setInterval(async () => {
        try {
          const jr = await fetch(`/api/job?id=${d.jobId}`, { cache: "no-store" });
          const jd = await jr.json();
          if (jd.ok && (jd.status === "done" || jd.status === "error")) {
            clearInterval(iv);
            clear();
            if (jd.status === "error") setError(`후처리 실패: ${jd.error ?? ""}`);
            const pr = await fetch(`/api/project/${project.id}`, { cache: "no-store" });
            const pd = await pr.json();
            if (pd.ok) setProject(pd.project);
            // 굽고 나서 카메라워크 결과를 바로 보여준다(요청: "굽고 나서 보여줘도 됨").
            if (openPreviewId && jd.status === "done") setScenePreview(openPreviewId);
          }
        } catch {}
      }, 4000);
      setTimeout(() => {
        clearInterval(iv);
        clear();
      }, 10 * 60_000);
    } catch (e) {
      clear();
      setError(e instanceof Error ? e.message : "후처리 실패");
    }
  }

  // ── 카메라워크(스펙 §2 계층 A) 굽기 — scene.cut.cameraWork 를 워커가 클립 위에 실픽셀로 굽는다. ──
  //   저장(cameraWork JSON)은 슬라이더 편집 시 updateCut 이 이미 반영. 여기선 굽기 잡만.
  async function applyCameraFx(sceneId: string) {
    const s = projectRef.current.scenes.find((x) => x.id === sceneId);
    if (!s?.videoUrl) {
      setError("먼저 동영상을 생성하세요 — 카메라워크는 생성된 클립 위에 굽습니다.");
      return;
    }
    setError("");
    setFxPending((prev) => new Set([...prev, sceneId]));
    const clear = () =>
      setFxPending((prev) => {
        const n = new Set(prev);
        n.delete(sceneId);
        return n;
      });
    try {
      const r = await fetch("/api/camerafx", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, sceneIds: [sceneId] }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "카메라워크 적용 실패");
      const iv = setInterval(async () => {
        try {
          const jr = await fetch(`/api/job?id=${d.jobId}`, { cache: "no-store" });
          const jd = await jr.json();
          if (jd.ok && (jd.status === "done" || jd.status === "error")) {
            clearInterval(iv);
            clear();
            if (jd.status === "error") setError(`카메라워크 실패: ${jd.error ?? ""}`);
            const pr = await fetch(`/api/project/${project.id}`, { cache: "no-store" });
            const pd = await pr.json();
            if (pd.ok) setProject(pd.project);
            if (jd.status === "done") setScenePreview(sceneId); // 굽고 나서 미리보기 자동 오픈(최종 픽셀)
          }
        } catch {}
      }, 4000);
      setTimeout(() => {
        clearInterval(iv);
        clear();
      }, 10 * 60_000);
    } catch (e) {
      clear();
      setError(e instanceof Error ? e.message : "카메라워크 적용 실패");
    }
  }

  // 카메라 미리보기 탭 — 카메라워크가 지정된 컷들을 한 번에 굽기(camerafx 잡, 다중 sceneIds).
  //   layer A 프리셋만(정지·orbit·계층B 는 굽기 대상 아님). 단일 applyCameraFx 와 같은 잡·폴링.
  async function bakeAllCamera() {
    const BAKEABLE = new Set(["push_in", "pull_out", "pan", "shake", "crash_zoom", "whip"]);
    const ids = scopeSectionIds(
      projectRef.current.scenes
        .filter((s) => s.videoUrl && s.cut?.cameraWork && BAKEABLE.has(s.cut.cameraWork.preset))
        .map((s) => s.id)
    );
    if (!ids.length) {
      setError(sec ? "이 섹션에 구울 카메라워크가 없어요." : "구울 카메라워크가 없어요 — 영상 생성된 컷에 카메라워크(정지 제외)를 먼저 정하세요.");
      return;
    }
    setError("");
    setFxPending((prev) => new Set([...prev, ...ids]));
    const clearAll = () =>
      setFxPending((prev) => {
        const n = new Set(prev);
        ids.forEach((id) => n.delete(id));
        return n;
      });
    try {
      const r = await fetch("/api/camerafx", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, sceneIds: ids }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "카메라워크 적용 실패");
      const iv = setInterval(async () => {
        try {
          const jr = await fetch(`/api/job?id=${d.jobId}`, { cache: "no-store" });
          const jd = await jr.json();
          if (jd.ok && (jd.status === "done" || jd.status === "error")) {
            clearInterval(iv);
            clearAll();
            if (jd.status === "error") setError(`카메라워크 실패: ${jd.error ?? ""}`);
            const pr = await fetch(`/api/project/${project.id}`, { cache: "no-store" });
            const pd = await pr.json();
            if (pd.ok) setProject(pd.project);
          }
        } catch {}
      }, 4000);
      setTimeout(() => {
        clearInterval(iv);
        clearAll();
      }, 10 * 60_000);
    } catch (e) {
      clearAll();
      setError(e instanceof Error ? e.message : "카메라워크 적용 실패");
    }
  }

  async function runDubJob(sceneIds?: string[]) {
    if (dubbing || dubStartingRef.current) return; // ★동기 가드 — 상태(dubbing)는 fetch 후에야 켜져서 그 틈의 재클릭을 막지 못함
    dubStartingRef.current = true;
    setError("");
    setDubMsg(null);
    // 명시 sceneIds 없고 섹션 활성이면 그 섹션 컷만 더빙(부분 작업).
    const ids = sceneIds ?? (sec ? project.scenes.filter((s) => sec.ids.has(s.id)).map((s) => s.id) : undefined);
    try {
      const r = await fetch("/api/dub", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, ...(ids ? { sceneIds: ids } : {}) }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "더빙 실패");
      setDubbing(true);
      pollDubJob(d.jobId as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : "더빙 실패");
    } finally {
      dubStartingRef.current = false;
    }
  }
  // 더빙 잡 상태 폴링 → 끝나면 씬(오디오 URL) 새로고침. 비디오 폴링과 별개.
  function pollDubJob(jobId: string) {
    let tries = 0;
    if (dubPollRef.current) clearInterval(dubPollRef.current);
    const iv = setInterval(async () => {
      tries++;
      try {
        const r = await fetch(`/api/job?id=${jobId}`, { cache: "no-store" });
        const d = await r.json();
        if (d.ok) {
          setProgress(d.progress ?? "");
          setProgressLog(d.progressLog ?? []);
        }
        if (d.ok && (d.status === "done" || d.status === "error")) {
          clearInterval(iv);
          dubPollRef.current = null;
          setDubbing(false);
          setProgress("");
          if (d.status === "error") {
            setError(`더빙 실패: ${d.error ?? ""}`);
          } else {
            setDubMsg("✓ 더빙 완료 — 각 줄의 🔊(초록)로 확인/재생하세요");
            setTimeout(() => setDubMsg(null), 6000);
          }
          try {
            const pr = await fetch(`/api/project/${project.id}`, { cache: "no-store" });
            const pj = await pr.json();
            if (pj.ok) setProject((prev) => ({ ...prev, scenes: pj.project.scenes }));
          } catch {}
          // 더빙 비용도 추정 제작비에 즉시 반영(더빙은 단계 상태를 안 바꿔 이펙트가 안 걸림).
          try {
            const cr = await fetch(`/api/cost?projectId=${project.id}`, { cache: "no-store" });
            const cd = await cr.json();
            if (cd.ok) setCostKrw(cd.krw);
          } catch {}
        }
      } catch {}
      if (tries > 260) {
        clearInterval(iv);
        dubPollRef.current = null;
        setDubbing(false);
      }
    }, 3000);
    dubPollRef.current = iv;
  }
  // 더빙 정지 — 워커는 별도 서버라 프로세스는 못 죽이지만(백그라운드서 끝남), UI 폴링을 멈추고
  //   상태를 풀어 준다(비디오 '중지'와 같은 성격). 이미 만든 오디오는 유지.
  function cancelDub() {
    if (dubPollRef.current) {
      clearInterval(dubPollRef.current);
      dubPollRef.current = null;
    }
    setDubbing(false);
    setProgress("");
    setDubMsg("더빙 정지됨 — 이미 만든 줄은 유지돼요(다시 '더빙'으로 이어서)");
    setTimeout(() => setDubMsg(null), 6000);
  }

  // 오디오 재생(더빙 미리듣기) — 한 번에 하나만.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  function playAudio(url: string) {
    try {
      if (audioRef.current) audioRef.current.pause();
      const a = new Audio(url);
      audioRef.current = a;
      a.play().catch(() => {});
    } catch {
      /* ignore */
    }
  }
  // 씬 오디오 전체 재생 — 말풍선(대사·내레이션·효과음) audioUrl 순서대로. 효과음도 소리로 재생.
  function playSceneAudio(s: Project["scenes"][number]) {
    const urls: string[] = [];
    for (const b of s.cut?.bubbles ?? []) if (b.audioUrl) urls.push(b.audioUrl);
    if (s.cut?.narrationAudioUrl) urls.push(s.cut.narrationAudioUrl);
    if (!urls.length) return;
    let i = 0;
    const next = () => {
      if (i >= urls.length) return;
      if (audioRef.current) audioRef.current.pause();
      const a = new Audio(urls[i++]);
      audioRef.current = a;
      a.onended = next;
      a.play().catch(() => {});
    };
    next();
  }
  // 이 씬에 더빙 오디오가 하나라도 있나(재생 버튼 표시용). 효과음 줄 포함.
  const sceneHasAudio = (s: Project["scenes"][number]) =>
    (s.cut?.bubbles ?? []).some((b) => b.audioUrl) || !!s.cut?.narrationAudioUrl;

  // 자막 '유닛' 배열 — 각 말풍선/내레이션 조각이 별개 박스(겹치지 않게). compose 와 동일 규칙.
  // ★효과음(화자=효과음) 줄은 자막에서 제외(소리일 뿐 캡션 아님).
  // 자막 유닛 — { text, sx, sy }. sx/sy = 이 줄(말풍선)에 지정된 자막 위치(없으면 컷 기본).
  function subtitleUnits(cut?: Project["scenes"][number]["cut"]): { text: string; sx?: number; sy?: number; tr?: string }[] {
    const units: { text: string; sx?: number; sy?: number; tr?: string }[] = [];
    if (cut?.bubbles?.length)
      for (const b of cut.bubbles) {
        if (b.speakerId === SFX_SPEAKER || b.noSubtitle) continue;
        const t = (b.text || "").trim();
        if (t) units.push({ text: t, sx: b.subtitleX, sy: b.subtitleY, tr: (b.translation || "").trim() || undefined });
      }
    else if (cut?.dialogue?.trim())
      units.push({ text: cut.dialogue.trim(), tr: (cut.dialogueTranslation || "").trim() || undefined });
    // 내레이션은 별개가 아니라 화자=내레이터인 말풍선 → 위 bubbles 루프가 이미 포함.
    return units;
  }
  // 자막 세로 중심 비율(0=위,1=아래) — compose 의 subtitleCenterY 와 동일 규칙(미리보기==결과 싱크).
  function subFracY(cut?: Project["scenes"][number]["cut"]): number {
    const y = cut?.subtitleY;
    if (typeof y === "number" && isFinite(y)) return Math.max(0.05, Math.min(0.95, y));
    const pos = cut?.subtitlePos;
    if (pos === "top") return 0.15;
    if (pos === "middle") return 0.5;
    if (pos === "bottom") return 0.85;
    return 0.72;
  }
  // 자막 가로 중심 비율(0=왼쪽,1=오른쪽). 기본 중앙.
  function subFracX(cut?: Project["scenes"][number]["cut"]): number {
    const x = cut?.subtitleX;
    if (typeof x === "number" && isFinite(x)) return Math.max(0.05, Math.min(0.95, x));
    return 0.5;
  }
  // 컷별 자막 9분할 앵커(3×3). 상단 맨위·하단 맨아래는 피한 안전 좌표.
  const SUB_X = [0.27, 0.5, 0.73] as const; // 좌·중·우
  const SUB_Y = [0.3, 0.5, 0.7] as const; // 상·중·하(가장자리 회피)
  // 씬 미리보기 열면 그 씬 더빙 오디오 자동 재생, 닫으면 멈춤.
  useEffect(() => {
    if (!scenePreview) return;
    const s = project.scenes.find((x) => x.id === scenePreview);
    if (s && sceneHasAudio(s)) playSceneAudio(s);
    return () => {
      if (audioRef.current) audioRef.current.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenePreview]);
  // 자막 박스가 여러 개면 하나씩 순차 표시(동시에 안 띄움). 미리보기 열릴 때 순환 시작.
  useEffect(() => {
    setSubIdx(0);
    if (!scenePreview) return;
    const s = project.scenes.find((x) => x.id === scenePreview);
    const n = s ? subtitleUnits(s.cut).length : 0;
    if (n <= 1) return;
    const iv = setInterval(() => setSubIdx((i) => (i + 1) % n), 2600);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenePreview]);
  // ★내레이션도 '대사(줄)'다 — 레거시 cut.narration 을 말풍선(화자=내레이션, speakerId=null)으로
  //   이관해 대사 목록 하나로 통일. 최초 1회, 이관 후엔 narration="" 라 재실행돼도 무해.
  const narrationMigrated = useRef(false);
  useEffect(() => {
    if (narrationMigrated.current) return;
    narrationMigrated.current = true;
    for (const s of project.scenes) {
      const nar = s.cut?.narration?.trim();
      if (nar) {
        const tr = s.cut?.narrationTranslation?.trim();
        updateCut(s.id, {
          bubbles: [...(s.cut?.bubbles ?? []), { text: nar, speakerId: null, ...(tr ? { translation: tr } : {}) }],
          narration: "",
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 5단계 — 씬 영상들을 워커에서 이어붙이기(오디오·자막 없이).
  async function runComposeJob() {
    setError("");
    try {
      const r = await fetch("/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "합성 실패");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, compose: { ...prev.steps.compose, status: "running" } },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "합성 실패");
    }
  }

  // 워커 작업 중지 — 워커 프로세스는 못 죽이지만 UI 가 '진행 중'에 갇히지 않게 단계를 되돌림.
  async function cancelJob(step: "source" | "cast" | "regen" | "scene" | "compose") {
    try {
      const r = await fetch("/api/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, step }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "중지 실패");
      setProgress("");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, [step]: { ...prev.steps[step], status: d.status } },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "중지 실패");
    }
  }

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/boundaries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "확정 실패");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, source: { ...prev.steps.source, status: "running" } },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "확정 실패");
    } finally {
      setBusy(false);
    }
  }

  async function runCastJob() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/cast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "캐스팅 실패");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, cast: { ...prev.steps.cast, status: "running" } },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "캐스팅 실패");
    } finally {
      setBusy(false);
    }
  }
  // ★재캐스팅은 반드시 확인 — 자동 캐스팅을 다시 돌리면 손으로 배정·수정·목소리 지정한 게 전부 날아간다.
  //   검수 단계에서 실수로 눌러 작업을 뒤엎는 사고 방지(사용자 지시).
  function reCastGuarded() {
    if (castRunning || busy) return;
    if (window.confirm("자동 캐스팅을 다시 돌리면 지금까지 손으로 배정·수정·목소리 지정한 내용이 사라집니다.\n정말 다시 캐스팅할까요?"))
      runCastJob();
  }

  // ★캐스팅 자동 실행 — 2단계에 들어오면 버튼 안 눌러도 알아서 캐스팅(사용자 요구). 아직 안 한
  //   경우(pending)에만 1회. 에러·완료·진행중이면 자동 안 함(무한 재시도 방지). '다시 캐스팅'은 수동.
  const castAutoRef = useRef(false);
  useEffect(() => {
    const isApproved = project.steps?.source?.status === "approved"; // approved 는 아래서 선언(TDZ) → 인라인
    if (activeStep === "cast" && isApproved && castStatus === "pending" && !castRunning && !busy && !castAutoRef.current) {
      castAutoRef.current = true;
      runCastJob();
    }
  }, [activeStep, castStatus, castRunning, busy, project.steps?.source?.status]);

  async function saveCast(
    cast: Character[],
    speakers: Record<string, string>,
    bubbleSpeakers: Record<string, string>,
    narrationSpeakers: Record<string, string>,
    approve: boolean
  ) {
    const r = await fetch("/api/cast", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        cast,
        speakers,
        bubbleSpeakers,
        narrationSpeakers,
        approve,
      }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error ?? "저장 실패");
    setProject((prev) => ({
      ...prev,
      cast: d.cast,
      scenes: d.scenes ?? prev.scenes,
      steps: { ...prev.steps, cast: { ...prev.steps.cast, status: d.status } },
    }));
  }

  // 캐스팅 — 캐릭터 실사 초상 디자인(얼굴 고정용). 잡 적재 → cast 폴링으로 realImage 반영.
  async function designPortrait(charId: string, prompt?: string) {
    setPortraitPending((prev) => {
      const n = new Map(prev);
      n.set(charId, project.cast?.find((c) => c.id === charId)?.realImage ?? "");
      return n;
    });
    try {
      const r = await fetch("/api/portrait", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, charId, prompt }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "실사화 실패");
    } catch (e) {
      setPortraitPending((prev) => {
        const n = new Map(prev);
        n.delete(charId);
        return n;
      });
      setError(e instanceof Error ? e.message : "실사화 실패");
    }
  }
  const pollPortraits = useCallback(async () => {
    try {
      const r = await fetch(`/api/cast?projectId=${project.id}`, { cache: "no-store" });
      const d = await r.json();
      if (!d.ok) return;
      setProgress(d.progress ?? "");
      setProject((prev) => ({ ...prev, cast: d.cast ?? prev.cast }));
      setPortraitPending((prev) => {
        if (prev.size === 0) return prev;
        const n = new Map(prev);
        for (const c of (d.cast ?? []) as { id: string; realImage?: string }[]) {
          if (n.has(c.id) && c.realImage && c.realImage !== n.get(c.id)) n.delete(c.id);
        }
        return n;
      });
    } catch {
      /* 다음 틱 */
    }
  }, [project.id]);
  useEffect(() => {
    if (portraitPending.size === 0) return;
    const t = setInterval(pollPortraits, 3000);
    const first = setTimeout(pollPortraits, 0);
    return () => {
      clearInterval(t);
      clearTimeout(first);
    };
  }, [portraitPending.size, pollPortraits]);

  const canvas = project.virtualCanvas;
  const hasCuts = project.scenes.length > 0;
  const approved = sourceStatus === "approved";
  const typedCount = project.scenes.filter((s) => s.cut?.type).length;
  const showSrc = srcOpen ?? !approved; // 1단계 완료(승인)되면 소스 섹션 기본 접힘
  const charCutCount = project.scenes.filter(
    (s) => s.cut?.type === "person" || s.cut?.type === "action"
  ).length;

  // 현재 도는 워커 작업 라벨(플로팅 표시용) — 스크롤/화면 전환과 무관하게 계속 보이게.
  const workLabel = running
    ? "컷 분할·추출"
    : castRunning
      ? "캐스팅"
      : regenPolling
        ? "이미지 재생성"
        : dubbing
          ? "더빙"
          : scenePolling
            ? "동영상 생성"
            : composeRunning
              ? "합성"
              : portraitPending.size > 0
                ? "실사 초상"
                : "";

  // 진행 바 — 로그의 "(N%)" 를 뽑아 표시(없으면 안 그림). 모든 워커 단계 공용.
  // 진행바 + 예상시간 — 워커 로그의 (N%) 또는 "N/M" 에서 퍼센트 추출, 경과시간으로 남은 시간 추정.
  const progressAnchor = useRef<{ at: number; pct: number } | null>(null);
  // 한 줄에서 진행률(%) 추출 — "(N%)" 우선, 없으면 "N/M"(예: "대사 읽기 3/43", "이미지 생성 1~6/12").
  const parsePct = (line: string): number | null => {
    if (!line) return null;
    const mp = line.match(/\((\d+)%\)/);
    if (mp) return Number(mp[1]);
    const mf = line.match(/(\d+)\s*\/\s*(\d+)/);
    if (mf && Number(mf[2]) > 0) return Math.round((Number(mf[1]) / Number(mf[2])) * 100);
    return null;
  };
  // 진행률(%)+예상시간 계산(공용) — 마지막 줄이 %없는 상태 메시지여도 최근 로그에서 마지막 %를 유지.
  // 각 단계 시작 시 로그 리셋되므로 과거 단계 오염 없음. 없으면 null.
  const progressInfo = (): { pct: number; eta: string } | null => {
    let pct: number | null = parsePct(progress);
    if (pct === null)
      for (let i = progressLog.length - 1; i >= 0; i--) {
        pct = parsePct(progressLog[i]);
        if (pct !== null) break;
      }
    if (pct === null) return null;
    pct = Math.max(0, Math.min(100, pct));
    // ETA(대략) — 처음 본 진행률(anchor) 이후 경과시간을 진행량으로 나눠 남은 시간 선형 추정.
    const now = Date.now();
    const a = progressAnchor.current;
    if (!a || pct < a.pct - 1) progressAnchor.current = { at: now, pct }; // 새 작업/되감김이면 기준 재설정
    let eta = "";
    if (pct > 0 && pct < 100 && progressAnchor.current) {
      const el = (now - progressAnchor.current.at) / 1000;
      const done = (pct - progressAnchor.current.pct) / 100;
      if (done > 0.03 && el > 3) {
        const remain = (el / done) * (1 - done);
        eta = remain > 90 ? `약 ${Math.round(remain / 60)}분 남음` : `약 ${Math.round(remain)}초 남음`;
      }
    }
    return { pct, eta };
  };
  const progressBar = () => {
    const info = progressInfo();
    if (!info) return null;
    return (
      <div className="mb-3 w-full max-w-md">
        <div className="mb-1 flex justify-between text-[11px] text-[var(--muted)]">
          <span>{info.pct}%</span>
          {info.eta && <span>{info.eta}</span>}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--panel-2)]">
          <div className="h-full bg-[var(--accent)] transition-all duration-300" style={{ width: `${info.pct}%` }} />
        </div>
      </div>
    );
  };
  // 미니 진행 바 — 플로팅 리모컨·우하단 상태표시에 인라인으로 얹는 작은 바+%(알약 모양 안 깨지게).
  const miniBar = () => {
    const info = progressInfo();
    if (!info) return null;
    return (
      <span className="flex items-center gap-1.5" title={info.eta ? `${info.pct}% · ${info.eta}` : `${info.pct}%`}>
        <span className="block h-1.5 w-14 overflow-hidden rounded-full bg-[var(--panel-2)]">
          <span className="block h-full rounded-full bg-[var(--accent)] transition-all duration-300" style={{ width: `${info.pct}%` }} />
        </span>
        <span className="text-[11px] tabular-nums text-[var(--muted)]">{info.pct}%</span>
      </span>
    );
  };

  return (
    <div>
      {/* 헤더 */}
      <div className="mb-4 flex items-center justify-between">
        {editingName ? (
          <input
            value={nameVal}
            autoFocus
            onChange={(e) => setNameVal(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveName();
              if (e.key === "Escape") setEditingName(false);
            }}
            className="rounded-md border border-[var(--accent)] bg-[var(--panel)] px-2 py-1 text-lg font-semibold"
          />
        ) : (
          <h1
            onClick={() => {
              setNameVal(project.name);
              setEditingName(true);
            }}
            title="클릭해서 제목 편집"
            className="cursor-text text-lg font-semibold hover:opacity-70"
          >
            {project.name}
          </h1>
        )}
        <span className="text-xs text-[var(--muted)]">{project.aspectRatio}</span>
      </div>

      {/* 단계 네비 — 클릭하면 그 단계만 보임(한 화면 = 한 단계). 상단 고정이라 스크롤해도 항상 보임(위아래 왕복 X). */}
      <nav className="sticky top-0 z-30 -mx-6 mb-4 flex flex-wrap items-center gap-1 border-b border-[var(--border)] bg-[var(--bg)] px-6 py-2 text-xs">
        {(["source", "cast", "regen", "scene", "camera", "compose"] as const).map((k) => {
          const hasImages = project.scenes.some((s) => s.generatedImage);
          const avail =
            k === "source" ||
            ((k === "cast" || k === "regen") && approved) ||
            ((k === "scene" || k === "camera" || k === "compose") && approved && hasImages);
          const cur = activeStep === k;
          const label = k === "camera" ? "🎥 카메라 미리보기" : STEP_LABEL[k];
          return (
            <button
              key={k}
              type="button"
              disabled={!avail}
              onClick={() => avail && goToStep(k)}
              className={`rounded px-2.5 py-1 ${
                cur
                  ? "bg-[var(--accent)] font-medium text-white"
                  : avail
                    ? "bg-[var(--panel-2)] text-[var(--text)] hover:brightness-110"
                    : "cursor-not-allowed bg-transparent text-[var(--muted)] opacity-50"
              }`}
              title={avail ? "" : "이전 단계를 먼저 완료하세요"}
            >
              {label}
            </button>
          );
        })}
      </nav>

      {/* 📚 섹션 바 — 한 회분을 나눠 부분부분 작업(3·4·카메라 단계). 목록·일괄작업이 선택 섹션만 대상. */}
      {(activeStep === "regen" || activeStep === "scene" || activeStep === "camera") && approved && orderedScenes.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-[11px]">
          <span className="font-semibold text-[var(--accent)]">📚 섹션</span>
          {sections.length === 0 ? (
            <>
              <span className="text-[var(--muted)]">한 회분을 나눠 부분부분 작업 — 서버 부하↓·설정/캐릭터 계승·최종에 이어붙이기</span>
              <span className="ml-auto flex items-center gap-2">
                <button type="button" onClick={autoSequence} disabled={seqBusy} className="rounded bg-[var(--accent)] px-2 py-0.5 font-medium text-white disabled:opacity-50" title="컷들을 서사 시퀀스(장면·장소 전환 단위)로 자동으로 묶어 나눕니다. 나눈 뒤 손으로 조정 가능.">
                  {seqBusy ? "나누는 중…" : "🤖 시퀀스로 자동 나누기"}
                </button>
                <span className="flex items-center gap-1 text-[var(--muted)]">
                  또는 컷
                  <input type="number" min={2} value={divN} onChange={(e) => setDivN(Math.max(2, Number(e.target.value) || 15))} className="w-12 rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-0.5" />
                  개씩
                  <button type="button" onClick={() => divideBySize(divN)} className="rounded border border-[var(--border)] px-2 py-0.5 hover:border-[var(--accent)]">나누기</button>
                </span>
              </span>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setCurrentSection(null)} className={`rounded border px-2 py-0.5 ${sec == null ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)]"}`}>전체</button>
              {sections.map((s) => (
                <button
                  key={s.i}
                  type="button"
                  onClick={() => setCurrentSection(s.i)}
                  title={`컷 ${s.start + 1}–${s.end}`}
                  className={`rounded border px-2 py-0.5 ${currentSection === s.i ? "border-[var(--accent)] bg-[var(--panel)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)]"}`}
                >
                  섹션 {s.i + 1} <span className="opacity-60">({s.start + 1}–{s.end})</span>
                </button>
              ))}
              <span className="ml-auto flex items-center gap-1 text-[10px] text-[var(--muted)]">
                {sec && sec.end - sec.start >= 2 && <button type="button" onClick={() => splitSection(sec.i)} className="rounded border border-[var(--border)] px-1.5 py-0.5 hover:border-[var(--accent)]" title="이 섹션을 반으로 나눔">✂ 반으로</button>}
                {sec && sections[sec.i + 1] && <button type="button" onClick={() => mergeSectionWithNext(sec.i)} className="rounded border border-[var(--border)] px-1.5 py-0.5 hover:border-[var(--accent)]" title="다음 섹션과 합침">⨝ 다음과 합치기</button>}
                <button type="button" onClick={autoSequence} disabled={seqBusy} className="rounded border border-[var(--accent)] px-1.5 py-0.5 text-[var(--accent)] disabled:opacity-50 hover:bg-[var(--panel)]" title="AI로 서사 시퀀스에 맞춰 다시 나눔">{seqBusy ? "…" : "🤖 자동"}</button>
                <input type="number" min={2} value={divN} onChange={(e) => setDivN(Math.max(2, Number(e.target.value) || 15))} className="w-12 rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-0.5" />
                <button type="button" onClick={() => divideBySize(divN)} className="rounded border border-[var(--border)] px-1.5 py-0.5 hover:border-[var(--accent)]" title="이 컷 수로 다시 나눔">다시 나누기</button>
                <button type="button" onClick={() => { if (window.confirm("섹션 나눔을 해제할까요? (전체 한 덩어리로)")) clearSections(); }} className="rounded border border-[var(--border)] px-1.5 py-0.5 hover:border-[var(--danger)]">해제</button>
              </span>
            </>
          )}
          {sec && <span className="w-full text-[10px] text-[var(--accent)]">▶ ‘섹션 {sec.i + 1}’ 작업 중 — 아래 목록·일괄 작업이 이 섹션(컷 {sec.start + 1}–{sec.end})만 대상입니다.</span>}
        </div>
      )}

      {/* ★플로팅 리모컨 — 각 단계 주요 액션을 화면 하단 고정으로. 위로 스크롤 안 하고 바로 누른다. */}
      {(() => {
        const REMOTE =
          "fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-2 shadow-2xl";
        const P = "rounded-full bg-[var(--accent)] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40";
        const G = "rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-[13px] font-medium disabled:opacity-40";
        const S = "rounded-full border border-[var(--danger)] px-3 py-1.5 text-[13px] font-medium text-[var(--danger)]";
        if (activeStep === "source" && canvas && hasCuts && (sourceStatus === "review" || running))
          return (
            <div className={REMOTE}>
              <button onClick={confirm} disabled={busy || running} className={P}>
                {running ? "처리 중…" : "경계 확정 · 추출"}
              </button>
              {running && miniBar()}
              {running && (
                <button onClick={() => cancelJob("source")} className={S}>■ 중지</button>
              )}
            </div>
          );
        if (activeStep === "cast" && approved)
          return (
            <div className={REMOTE}>
              {castRunning ? (
                <>
                  <button disabled className={P}>캐스팅 중…</button>
                  {miniBar()}
                  <button onClick={() => cancelJob("cast")} className={S}>■ 중지</button>
                </>
              ) : castStatus === "review" ? (
                // 검수 중 — 주요 액션은 '확정'. 재캐스팅은 확인 거쳐야만(수동 작업 보호).
                <>
                  <button onClick={() => setCastConfirmNonce((n) => n + 1)} disabled={busy} className={P}>
                    캐스팅 확정
                  </button>
                  <button onClick={reCastGuarded} disabled={busy} className={G} title="자동 캐스팅 다시 — 손으로 한 배정이 사라짐">
                    다시 캐스팅
                  </button>
                </>
              ) : castStatus === "approved" ? (
                <>
                  <span className="px-2 text-[13px] font-medium text-[var(--ok)]">✓ 캐스팅 확정됨</span>
                  <button onClick={reCastGuarded} disabled={busy} className={G} title="자동 캐스팅 다시 — 손으로 한 배정이 사라짐">
                    다시 캐스팅
                  </button>
                </>
              ) : (
                // 아직 캐스팅 전(pending/error) — 최초 실행.
                <button onClick={runCastJob} disabled={busy} className={P}>캐스팅</button>
              )}
            </div>
          );
        if (activeStep === "regen" && approved) {
          const cands = project.scenes.filter((s) => s.originalImage && s.cut?.type !== "text");
          const allSel = cands.length > 0 && cands.every((s) => selForRegen.has(s.id));
          return (
            <div className={REMOTE}>
              <button onClick={toggleSelectAllRegen} className={G}>{allSel ? "선택 해제" : "전체 선택"}</button>
              {selForRegen.size > 0 && (
                <button onClick={regenSelected} disabled={busy || regenRunning} className={P}>
                  선택 {selForRegen.size} 생성
                </button>
              )}
              <button onClick={runRegenJob} disabled={busy || regenRunning} className={selForRegen.size > 0 ? G : P}>
                {regenRunning ? "생성 중…" : "전체 생성"}
              </button>
              <button
                onClick={async () => {
                  try {
                    const r = await fetch(`/api/project/${project.id}`, { cache: "no-store" });
                    const d = await r.json();
                    if (d.ok) setProject(d.project);
                  } catch {}
                }}
                className={G}
                title="워커가 만든 최신 결과(새로 생성한 그림 등)를 강제로 다시 불러옵니다. 그림이 안 보이면 눌러보세요."
              >
                🔄 새로고침
              </button>
              {regenPolling && miniBar()}
              {regenPolling && (
                <button onClick={() => cancelJob("regen")} className={S}>■ 중지</button>
              )}
            </div>
          );
        }
        if (activeStep === "scene" && approved) {
          const vids = project.scenes.filter((s) => s.generatedImage && inSection(s)).map((s) => s.id);
          const allSel = vids.length > 0 && vids.every((id) => selForVideo.has(id));
          return (
            <div className={REMOTE}>
              <button onClick={toggleSelectAllVideo} className={G}>{allSel ? "선택 해제" : "전체 선택"}</button>
              {selForVideo.size > 0 && (
                <button onClick={videoSelected} disabled={busy || sceneRunning} className={G}>
                  선택 {selForVideo.size} 동영상
                </button>
              )}
              <button onClick={() => runVideoJob()} disabled={busy || sceneRunning} className={G}>
                {sceneRunning ? "영상 중…" : "전체 동영상"}
              </button>
              {selForVideo.size > 0 && (
                <button onClick={() => runDubJob([...selForVideo])} disabled={busy || dubbing} className={P}>
                  선택 {selForVideo.size} 더빙
                </button>
              )}
              <button onClick={() => runDubJob()} disabled={busy || dubbing} className={P}>
                {dubbing ? "더빙 중…" : "🎙 전체 더빙"}
              </button>
              {(sceneRunning || dubbing) && miniBar()}
              {/* 동영상·더빙은 병렬로 돌 수 있어 정지 버튼도 각각. */}
              {sceneRunning && (
                <button onClick={() => cancelJob("scene")} className={S}>■ 동영상 정지</button>
              )}
              {dubbing && (
                <button onClick={cancelDub} className={S}>■ 더빙 정지</button>
              )}
            </div>
          );
        }
        if (activeStep === "compose" && approved)
          return (
            <div className={REMOTE}>
              <button onClick={runComposeJob} disabled={busy || composeRunning} className={P}>
                {composeRunning ? "합성 중…" : "영상 묶기"}
              </button>
              {composeRunning && miniBar()}
              {composeRunning && (
                <button onClick={() => cancelJob("compose")} className={S}>
                  ■ 중지
                </button>
              )}
            </div>
          );
        return null;
      })()}

      {error && (
        <p className="mb-4 rounded-md border border-[var(--danger)] bg-[var(--panel)] p-3 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      {activeStep === "source" && (<>
      {/* 1) 소스 업로드 */}
      <section className="mb-6 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
        <button
          type="button"
          onClick={() => setSrcOpen(!showSrc)}
          className="mb-3 flex w-full items-center justify-between text-left"
        >
          <h2 className="text-sm font-semibold">
            {showSrc ? "▾" : "▸"} 소스 이미지{" "}
            {project.sourceFiles.length > 0 && (
              <span className="font-normal text-[var(--muted)]">
                ({project.sourceFiles.length}장)
              </span>
            )}
          </h2>
          <span className="text-xs text-[var(--muted)]">업로드 순서 = 세로 스크롤 순서</span>
        </button>

        {showSrc && (
          <>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          disabled={busy || running}
          onChange={(e) => uploadFiles(e.target.files)}
          className="mb-3 block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-[var(--panel-2)] file:px-3 file:py-1.5 file:text-[var(--text)]"
        />

        {busy && uploadMsg && (
          <div className="mb-3 flex items-center gap-2 text-sm text-[var(--muted)]">
            <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
            <span>
              {uploadMsg} · {elapsed}초
            </span>
            <button
              onClick={cancelUpload}
              className="ml-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:border-[var(--danger)] hover:text-[var(--danger)]"
            >
              중지
            </button>
          </div>
        )}

        {project.sourceFiles.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {project.sourceFiles.map((f) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={f.id}
                src={f.url}
                alt={`source ${f.order}`}
                className="h-20 w-auto rounded border border-[var(--border)]"
              />
            ))}
          </div>
        )}

        {project.sourceFiles.length > 0 && (
          <button
            onClick={runSplit}
            disabled={busy || running}
            className="mt-4 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {running ? "처리 중…" : hasCuts ? "다시 분할" : "컷 자동 분할"}
          </button>
        )}
          </>
        )}
      </section>

      {/* 진행 표시 — ★작업이 끝나도 로그를 남긴다. 예전엔 블록 전체가 running 게이트라
             잡이 끝나는 순간 로그가 통째로 사라졌다(사용자 지적: "다 돈 다음에 로그 목록이 안 보임").
             단계별 소요·경고·실패 사유는 '끝난 뒤에' 읽어야 쓸모가 있다. */}
      {(running || progressLog.length > 0) && (
        <div className="mb-6">
          {running ? (
            <p className="flex items-center gap-2 text-sm text-[var(--muted)]">
              <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
              워커 작업 중… {progress && <span className="opacity-70">{progress}</span>}
              <button
                onClick={() => cancelJob("source")}
                className="ml-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:border-[var(--danger)] hover:text-[var(--danger)]"
              >
                작업 중지
              </button>
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-[var(--muted)]">
              <span>📋 직전 작업 로그</span>
              <button
                onClick={() => setProgressLog([])}
                className="rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:border-[var(--accent)]"
              >
                지우기
              </button>
            </p>
          )}
          {running && progressBar()}
          {progressLog.length > 0 && (
            <pre className="mt-2 max-h-44 w-full max-w-2xl overflow-y-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel-2)] p-2 text-[11px] leading-tight text-[var(--muted)]">
              {(running ? progressLog.slice(-14) : progressLog).join("\n")}
            </pre>
          )}
        </div>
      )}

      {/* 2) G1 경계 편집 — ★추출 완료(approved) 후에도 계속 보인다. 예전엔 approved 면 이 섹션이
             통째로 숨어 "1단계 결과가 사라진다"는 버그였음(사용자 반복 지적). 승인 후에도 컷·대사·경계를
             언제든 보고 다시 편집·재추출할 수 있어야 한다. */}
      {canvas && hasCuts && (sourceStatus === "review" || sourceStatus === "approved" || running) && (
        <section className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              G1 · 컷 경계 검수{" "}
              <span className="font-normal text-[var(--muted)]">
                ({project.scenes.length}컷 · AI 분류 {typedCount}/{project.scenes.length})
              </span>
            </h2>
            <button
              onClick={confirm}
              disabled={busy || running}
              className="rounded-md bg-[var(--ok)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              경계 확정 · 컷 추출
            </button>
          </div>
          {/* 🌐 대상 언어 — 추출이 번역을 채우므로 '추출 버튼 바로 옆'이 켜야 할 자리다. */}
          <div className="mb-3 rounded border border-[var(--border)] bg-[var(--panel)] px-2 py-1">
            {targetLangToggles()}
          </div>
          <BoundaryEditor
            sourceFiles={project.sourceFiles}
            canvas={canvas}
            scenes={project.scenes}
            projectId={project.id}
            onSave={saveRegions}
          />
        </section>
      )}
      </>)}

      {/* M2) 캐스팅 — 등장인물 구분 */}
      {activeStep === "cast" && approved && (
        <section className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              2. 캐스팅{" "}
              <span className="font-normal text-[var(--muted)]">
                — 인물 컷 {charCutCount}개 · 캐릭터 {project.cast?.length ?? 0}명
              </span>
            </h2>
            {castStatus === "pending" || castStatus === "error" ? (
              <button
                onClick={runCastJob}
                disabled={busy || castRunning}
                className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {castRunning ? "처리 중…" : "캐스팅 실행"}
              </button>
            ) : (
              <button
                onClick={reCastGuarded}
                disabled={busy || castRunning}
                title="자동 캐스팅 다시 — 손으로 한 배정·수정이 사라짐(확인 후 진행)"
                className="rounded-md border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50"
              >
                다시 캐스팅
              </button>
            )}
          </div>

          {castRunning && (
            <p className="flex items-center gap-2 text-sm text-[var(--muted)]">
              <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
              인물 구분 중… {progress && <span className="opacity-70">{progress}</span>}
              <button
                onClick={() => cancelJob("cast")}
                className="ml-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:border-[var(--danger)] hover:text-[var(--danger)]"
              >
                작업 중지
              </button>
            </p>
          )}
          {castRunning && progressBar()}
          {castRunning && progressLog.length > 0 && (
            <pre className="mb-3 max-h-44 w-full max-w-2xl overflow-y-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel-2)] p-2 text-[11px] leading-tight text-[var(--muted)]">
              {progressLog.slice(-14).join("\n")}
            </pre>
          )}

          {castStatus === "error" && (
            <p className="rounded-md border border-[var(--danger)] bg-[var(--panel)] p-3 text-sm text-[var(--danger)]">
              {project.steps.cast.error ?? "캐스팅 오류"}
            </p>
          )}

          {(castStatus === "review" || castStatus === "approved") && (
            <>
              {castStatus === "approved" && (
                <p className="mb-2 text-xs text-[var(--ok)]">
                  ✓ 캐스팅 확정됨 — 이후 재생성(M3)에서 인물별 레퍼런스로 사용
                </p>
              )}
              <CastReview
                scenes={project.scenes}
                cast={project.cast ?? []}
                onSave={saveCast}
                confirmSignal={castConfirmNonce}
                onDesignPortrait={designPortrait}
                portraitPending={portraitPending}
                onZoom={(src) => setLightbox({ type: "image", src })}
                narratorVoice={project.narratorVoice ?? null}
                onSetNarratorVoice={setNarratorVoice}
              />
            </>
          )}
        </section>
      )}

      {/* M3) 재생성 — 좌(원본) / 우(생성) */}
      {activeStep === "regen" && approved && (
        <section className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setRegenOpen((v) => !v)}
                className="text-sm font-semibold"
                title="접기/펼치기"
              >
                {regenOpen ? "▾" : "▸"} 3. 이미지 재생성
                {!regenOpen && (
                  <span className="ml-1 font-normal text-[var(--muted)]">
                    ({project.scenes.filter((s) => s.originalImage && s.cut?.type !== "text").length}컷)
                  </span>
                )}
              </button>
              <div className="flex items-center gap-1 text-xs">
                <span className="text-[var(--muted)]">기본 모델:</span>
                <select
                  value={genModel}
                  onChange={(e) => setGenModel(e.target.value)}
                  title="컷별로 따로 안 고른 컷의 기본 모델. 각 컷 오른쪽에서 그때그때 바꿀 수 있어요. fal 은 FAL_KEY 필요."
                  className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 py-0.5"
                >
                  <option value="gpt-image-2">gpt-image-2</option>
                  <option value="fal">Flux (fal.ai)</option>
                  <option value="photoreal">실사화 (image-2)</option>
                </select>
                <span className="ml-1 text-[var(--muted)]">비율:</span>
                {(
                  [
                    { v: "9:16", t: "세로" },
                    { v: "16:9", t: "가로" },
                    { v: "1:1", t: "정사각" },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.v}
                    onClick={() => setAspect(o.v)}
                    className={`rounded border px-2 py-0.5 ${
                      project.aspectRatio === o.v
                        ? "border-[var(--accent)] text-[var(--accent)]"
                        : "border-[var(--border)] text-[var(--muted)]"
                    }`}
                  >
                    {o.t} {o.v}
                  </button>
                ))}
                <span className="ml-2 text-[var(--muted)]">방식:</span>
                {(
                  [
                    { v: "full", t: "새로 그리기", d: "컷을 통째로 다시 생성 — 빈 공간도 같은 화풍으로 새로 그림(기본)" },
                    { v: "mask", t: "원본 유지", d: "그림은 그대로 두고 빈 공간·글씨만 채움" },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.v}
                    onClick={() => setProjectRegenMode(o.v)}
                    title={o.d}
                    className={`rounded border px-2 py-0.5 ${
                      (project.regenMode || "full") === o.v
                        ? "border-[var(--accent)] text-[var(--accent)]"
                        : "border-[var(--border)] text-[var(--muted)]"
                    }`}
                  >
                    {o.t}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {(() => {
                const cands = project.scenes.filter(
                  (s) => s.originalImage && s.cut?.type !== "text"
                );
                const all = cands.length > 0 && cands.every((s) => selForRegen.has(s.id));
                return (
                  <button
                    onClick={toggleSelectAllRegen}
                    className="rounded border border-[var(--border)] px-2 py-2 text-sm"
                  >
                    {all ? "선택 해제" : "전체 선택"}
                  </button>
                );
              })()}
              {selForRegen.size > 0 && (
                <button
                  onClick={regenSelected}
                  disabled={busy || regenRunning}
                  className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  선택 {selForRegen.size}개 생성
                </button>
              )}
              {(() => {
                // 일부만 그려진 상태에서만 노출 — 안 됐거나 실패한 컷만 마저.
                const cands = project.scenes.filter(
                  (s) => s.originalImage && s.cut?.type !== "text"
                );
                const missing = cands.filter((s) => !s.generatedImage).length;
                if (missing === 0 || missing === cands.length) return null;
                return (
                  <button
                    onClick={regenMissing}
                    disabled={busy || regenRunning}
                    className="rounded-md border border-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent)] disabled:opacity-50"
                    title="아직 안 그려졌거나 실패한 컷만 마저 생성"
                  >
                    안 된 것만 {missing}개
                  </button>
                );
              })()}
              {regenStatus === "pending" || regenStatus === "error" ? (
                <button
                  onClick={runRegenJob}
                  disabled={busy || regenRunning}
                  className="rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {regenRunning ? "생성 중…" : "전체 생성"}
                </button>
              ) : (
                <button
                  onClick={runRegenJob}
                  disabled={busy || regenRunning}
                  className="rounded-md border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50"
                >
                  전체 다시
                </button>
              )}
            </div>
          </div>

          {regenPolling && (
            <p className="mb-3 flex items-center gap-2 text-sm text-[var(--muted)]">
              <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
              이미지 생성 중{regenPending.size > 0 ? ` (${regenPending.size}컷)` : ""}…{" "}
              {progress && <span className="opacity-70">{progress}</span>}
              <button
                onClick={() => cancelJob("regen")}
                className="ml-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:border-[var(--danger)] hover:text-[var(--danger)]"
              >
                작업 중지
              </button>
            </p>
          )}
          {regenPolling && progressBar()}
          {regenPolling && progressLog.length > 0 && (
            <pre className="mb-3 max-h-44 w-full max-w-2xl overflow-y-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel-2)] p-2 text-[11px] leading-tight text-[var(--muted)]">
              {progressLog.slice(-14).join("\n")}
            </pre>
          )}

          {regenStatus === "error" && (
            <p className="mb-3 rounded-md border border-[var(--danger)] bg-[var(--panel)] p-3 text-sm text-[var(--danger)]">
              {project.steps.regen.error ?? "재생성 오류"}
            </p>
          )}

          {regenOpen && project.scenes.some((s) => s.originalImage) && (
            <div className="space-y-2">
              {project.scenes
                .filter((s) => s.originalImage && s.cut?.type !== "text" && inSection(s))
                .map((s) => {
                  const speaker = project.cast?.find((c) => c.id === s.cut?.speakerId)?.label;
                  return (
                    <div
                      key={s.id}
                      className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-2"
                    >
                      <div className="flex w-7 shrink-0 flex-col items-center gap-1 pt-8">
                        <input
                          type="checkbox"
                          checked={selForRegen.has(s.id)}
                          onChange={() => toggleSel(s.id)}
                          title="다중 선택 생성용"
                        />
                        <span className="text-xs text-[var(--muted)]">{s.order + 1}</span>
                      </div>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={s.originalImage}
                        alt="원본"
                        onClick={() => setLightbox({ type: "image", src: s.originalImage! })}
                        className="h-28 w-auto shrink-0 cursor-zoom-in rounded border border-[var(--border)]"
                      />
                      <button
                        onClick={() => regenOne(s.id)}
                        disabled={busy || regenRunning}
                        title={s.generatedImage ? "다시 생성" : "이 컷 생성 시작"}
                        className="shrink-0 pt-11 text-lg text-[var(--muted)] hover:text-[var(--accent)] disabled:opacity-40"
                      >
                        ▶
                      </button>
                      {regenPending.has(s.id) ? (
                        // 재생성 중이면 최우선 — 옛 이미지가 있어도 스피너 표시.
                        <div className="grid h-28 w-24 shrink-0 place-items-center rounded border border-dashed border-[var(--accent)] px-1 text-center text-[10px] text-[var(--accent)]">
                          <span className="flex flex-col items-center gap-1.5">
                            <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
                            생성 중…
                          </span>
                        </div>
                      ) : s.generatedImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={s.generatedImage}
                          alt="생성"
                          onClick={() => setLightbox({ type: "image", src: s.generatedImage! })}
                          className="glow-accent h-28 w-auto shrink-0 cursor-zoom-in rounded border border-[var(--accent)]"
                        />
                      ) : (
                        <div className="grid h-28 w-24 shrink-0 place-items-center rounded border border-dashed border-[var(--border)] px-1 text-center text-[10px] text-[var(--muted)]">
                          {s.regenError ? `실패: ${s.regenError}` : "미생성"}
                        </div>
                      )}
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <textarea
                          value={s.cut?.description ?? ""}
                          onChange={(e) => updateCut(s.id, { description: e.target.value })}
                          placeholder="프롬프트(그림 내용) — 재생성에 그대로 들어감"
                          rows={2}
                          className="w-full resize-none rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-1 text-[11px] leading-tight"
                        />
                        {dialogueEditor(s)}
                        <div className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
                          {speaker && <span>화자: {speaker}</span>}
                          <div className="ml-auto flex items-center gap-1">
                            <button
                              onClick={() => mergeCutM3(s.id, "prev")}
                              disabled={busy || regenRunning || s.order === 0}
                              className="rounded border border-[var(--border)] px-1.5 py-0.5 disabled:opacity-30"
                              title="앞 컷과 합치기"
                            >
                              ◀합
                            </button>
                            <button
                              onClick={() => mergeCutM3(s.id, "next")}
                              disabled={busy || regenRunning}
                              className="rounded border border-[var(--border)] px-1.5 py-0.5 disabled:opacity-30"
                              title="뒤 컷과 합치기"
                            >
                              합▶
                            </button>
                            <button
                              onClick={() => splitCutM3(s.id)}
                              disabled={busy || regenRunning}
                              className="rounded border border-[var(--border)] px-1.5 py-0.5 disabled:opacity-40"
                              title="이 컷을 분할(서브컷 추출까지)"
                            >
                              분할
                            </button>
                            <button
                              onClick={() => {
                                if (window.confirm(`컷 ${s.order + 1} 삭제할까요?`)) deleteCutM3(s.id);
                              }}
                              disabled={busy || regenRunning}
                              className="rounded border border-[var(--border)] px-1.5 py-0.5 hover:border-[var(--danger)] hover:text-[var(--danger)] disabled:opacity-40"
                              title="이 컷 삭제"
                            >
                              삭제
                            </button>
                            <select
                              value={modelFor(s.id)}
                              onChange={(e) => setModelFor(s.id, e.target.value)}
                              disabled={busy || regenRunning}
                              title="이 컷 생성 모델"
                              className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 py-0.5 disabled:opacity-40"
                            >
                              <option value="gpt-image-2">gpt-image-2</option>
                              <option value="fal">Flux</option>
                              <option value="photoreal">실사화</option>
                            </select>
                            {modelFor(s.id) === "gpt-image-2" && (
                              <button
                                type="button"
                                onClick={() => updateCut(s.id, { noCastRef: !s.cut?.noCastRef })}
                                disabled={busy || regenRunning}
                                title="캐스팅 정본(인물 얼굴·복장)을 참고해 일관 생성. 피·변신 등 특수 상태 컷은 꺼서 정본이 그 상태를 덮지 않게."
                                className={`rounded border px-1.5 py-0.5 disabled:opacity-40 ${
                                  s.cut?.noCastRef
                                    ? "border-[var(--border)] text-[var(--muted)]"
                                    : "border-[var(--accent)] text-[var(--accent)]"
                                }`}
                              >
                                {s.cut?.noCastRef ? "인물참고 끔" : "인물참고 켬"}
                              </button>
                            )}
                            <button
                              onClick={() => regenOne(s.id)}
                              disabled={busy || regenRunning}
                              className="rounded bg-[var(--accent)] px-3 py-0.5 font-medium text-white disabled:opacity-40"
                              title="이 컷만 생성(테스트·재생성)"
                            >
                              {s.generatedImage ? "다시 생성" : "생성"}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </section>
      )}

      {/* ── 4단계: 동영상 생성(Grok I2V) + 더빙 정보 ── */}
      {activeStep === "scene" && approved && project.scenes.some((s) => s.generatedImage) && (
        <section className="mb-6">
          {/* 🎭 목소리 캐스팅 — 더빙 단계에서도 지정 가능(캐스팅 화면과 같은 저장소 = 싱크). */}
          {(project.cast?.length ?? 0) > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded border border-[var(--border)] bg-[var(--panel)] px-2 py-1.5 text-[11px]">
              <span className="font-medium text-[var(--muted)]">🎭 목소리</span>
              {/* 나레이터(내레이션 목소리) — 캐릭터와 같은 자리에서 지정(캐스팅 화면과 싱크) */}
              <span className="flex items-center gap-1">
                <span className="max-w-[90px] truncate font-medium" title="내레이터(화자를 '내레이터'로 둔 줄)를 읽는 목소리">
                  📖 내레이터
                </span>
                <select
                  value={project.narratorVoice?.id ?? ""}
                  onChange={(e) => {
                    const v = voiceList.find((x) => x.id === e.target.value);
                    void setNarratorVoice(
                      v ? { provider: v.provider ?? "eleven", id: v.id, name: v.name } : null
                    );
                  }}
                  className={`max-w-[150px] rounded border bg-[var(--panel-2)] px-1 py-0.5 ${
                    project.narratorVoice ? "border-[var(--border)]" : "border-dashed border-[var(--danger)]"
                  }`}
                  title="나레이터 목소리 — 캐스팅 화면의 나레이터 선택과 동기화됨"
                >
                  <option value="">목소리…</option>
                  {voiceList.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </span>
              {(project.cast ?? []).map((c) => (
                <span key={c.id} className="flex items-center gap-1">
                  <span className="max-w-[90px] truncate" title={c.label}>
                    {c.sceneIds.length ? "" : "🎙"}{c.label}
                  </span>
                  <select
                    value={c.voice ?? ""}
                    onChange={(e) => setCastVoice(c.id, e.target.value)}
                    className={`max-w-[150px] rounded border bg-[var(--panel-2)] px-1 py-0.5 ${
                      c.voice ? "border-[var(--border)]" : "border-dashed border-[var(--danger)]"
                    }`}
                    title={`${c.label} 더빙 목소리 — 캐스팅 화면과 동기화됨`}
                  >
                    <option value="">목소리…</option>
                    {voiceList.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </span>
              ))}
              <button
                type="button"
                onClick={addOffscreenChar}
                title="화면에 등장하지 않는 목소리 캐릭터 추가(전화·해설·신 등)"
                className="rounded border border-dashed border-[var(--border)] px-1.5 py-0.5 text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                + 화면 밖 인물
              </button>
            </div>
          )}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{STEP_LABEL.scene}</h2>
            <span className="text-xs text-[var(--muted)]">
              — 재생성 컷 {project.scenes.filter((s) => s.generatedImage).length}개 · Grok I2V(초당 $0.05)
            </span>
            {(() => {
              const ids = project.scenes.filter((s) => s.generatedImage && inSection(s)).map((s) => s.id);
              const all = ids.length > 0 && ids.every((id) => selForVideo.has(id));
              return (
                <button
                  onClick={toggleSelectAllVideo}
                  className="ml-auto rounded border border-[var(--border)] px-2 py-2 text-sm"
                >
                  {all ? "선택 해제" : sec ? `섹션 ${sec.i + 1} 전체 선택` : "전체 선택"}
                </button>
              );
            })()}
            {selForVideo.size > 0 && (
              <button
                onClick={videoSelected}
                disabled={busy}
                className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                선택 {selForVideo.size}개 생성
              </button>
            )}
            <button
              onClick={() => {
                const ids = project.scenes.filter((s) => s.generatedImage && inSection(s)).map((s) => s.id);
                setVidPending((prev) => new Set([...prev, ...ids]));
                runVideoJob();
              }}
              disabled={busy || sceneRunning}
              className="rounded-md border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50"
            >
              {sceneRunning ? "생성 중…" : sec ? `섹션 ${sec.i + 1} 동영상 생성` : "전체 동영상 생성"}
            </button>
            {/* 🧹 구운 후처리 카메라 전부 해제 → 원본(가장 최근 생성한) 영상 표시. 렌더·API 없음(토큰 0). */}
            {project.scenes.some((s) => s.fxUrl) && (
              <button
                onClick={() => {
                  const ids = project.scenes.filter((s) => s.fxUrl).map((s) => s.id);
                  if (ids.length) runFxJob(ids, "none", 2);
                }}
                disabled={busy}
                title="구운 후처리 카메라를 한 번에 전부 해제 → 이미 생성해둔 원본 영상 표시. 렌더·토큰 없음."
                className="rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
              >
                🧹 카메라효과 전체 해제
              </button>
            )}
          </div>

          {/* 📖 스토리 맥락 — 모든 영상 생성 프롬프트에 주입해 맥락 어긋난 동작(죽어가는데 벌떡 등)을 막는다. */}
          <div className="mb-3 rounded-lg border border-[var(--accent)] bg-[var(--panel)] p-2">
            <label className="mb-1 flex items-center gap-2 text-xs font-semibold text-[var(--accent)]">
              📖 스토리 맥락
              <span className="font-normal text-[var(--muted)]">— 전체 톤·상황을 적으면 모든 영상 생성에 반영(맥락 어긋난 동작 방지)</span>
            </label>
            <textarea
              value={project.storyContext ?? ""}
              onChange={(e) => setProject((prev) => ({ ...prev, storyContext: e.target.value }))}
              onBlur={(e) => saveStoryContext(e.target.value)}
              rows={2}
              placeholder="예: 비극. 주인공은 칼에 찔려 죽어가는 중 — 밝거나 활기찬 동작·미소 금지. 시종 어둡고 무거운 톤."
              className="w-full resize-none rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs"
            />
            {targetLangToggles()}
            {/* 🗣 작업 언어(§10) — 화면 대사·더빙·자막이 이 언어로 나감. 원어 또는 켠 대상 언어 중 선택. */}
            {(project.targetLanguages?.length ?? 0) > 0 && (
              <div
                className="mt-2 flex flex-wrap items-center gap-1.5 rounded border border-[var(--accent)] bg-[var(--panel-2)] px-2 py-1 text-[11px]"
                title="화면 대사·더빙·자막이 이 언어로 나갑니다. 원어=번역 전 원문. 언어를 고르면 그 번역문으로 더빙·자막(그 언어를 읽는 목소리 필요). 바꾼 뒤 더빙·합성 다시 하세요."
              >
                <span className="font-semibold text-[var(--accent)]">🗣 작업 언어</span>
                {[{ id: "", label: "원어" }, ...(project.targetLanguages ?? []).map((id) => ({ id, label: LANGUAGES.find((l) => l.id === id)?.label ?? id }))].map((o) => {
                  const on = (project.workingLanguage ?? "") === o.id;
                  return (
                    <button
                      key={o.id || "src"}
                      type="button"
                      onClick={() => setWorkingLanguage(o.id)}
                      className={`rounded border px-2 py-0.5 ${on ? "border-[var(--accent)] bg-[var(--accent)] font-medium text-white" : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--panel)]"}`}
                    >
                      {o.label}
                    </button>
                  );
                })}
                <span className="text-[var(--muted)]">— 더빙·자막이 이 언어로</span>
              </div>
            )}
            {/* 🎬 영상 엔진(§4) — 자동(키 유무)/Kling/Grok. Kling 만 액션 첫+끝 프레임 보간 가능. */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]" title="I2V 엔진. Kling 은 첫+끝 프레임 보간(액션)·네이티브 품질. Grok 은 기존. 자동=키 있으면 Kling. Kling 은 워커에 KLING_ACCESS_KEY/SECRET_KEY 필요.">
              <span className="text-[var(--muted)]">🎬 영상 엔진</span>
              {(["auto", "kling", "grok"] as const).map((v) => {
                const cur = project.videoEngine ?? "auto";
                const on = cur === v;
                const label = v === "auto" ? "자동" : v === "kling" ? "Kling(보간)" : "Grok";
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVideoEngine(v)}
                    className={`rounded border px-1.5 py-0.5 ${on ? "border-[var(--accent)] font-medium text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--panel-2)]"}`}
                  >
                    {on ? "✓ " : ""}{label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 더빙(음성 생성) — 동영상과 별개. 얇은 한 줄로(설명은 툴팁). */}
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" title="대사=화자 목소리 · 내레이션=나레이터 · 효과음=ElevenLabs · 동영상 생성 중에도 가능">
            <span className="font-semibold text-[var(--accent)]">🎙 더빙</span>
            <span className="flex items-center gap-1 text-xs text-[var(--muted)]" title="더빙 말 속도">
              속도
              {[1, 1.2].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setDubSpeed(v)}
                  className={`rounded border px-1.5 py-0.5 text-[11px] ${
                    (project.dubSpeed ?? 1.2) === v
                      ? "border-[var(--accent)] font-medium text-[var(--accent)]"
                      : "border-[var(--border)] hover:bg-[var(--panel-2)]"
                  }`}
                >
                  {v}배
                </button>
              ))}
            </span>
            {dubbing && (
              <span className="flex items-center gap-1 text-xs text-[var(--accent)]">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
                더빙 중… {progress && <span className="opacity-70">{progress}</span>}
              </span>
            )}
            {dubbing && <div className="w-full">{progressBar()}</div>}
            {dubMsg && !dubbing && <span className="text-xs text-[var(--ok)]">{dubMsg}</span>}
            {selForVideo.size > 0 && (
              <button
                onClick={() => runDubJob([...selForVideo])}
                disabled={busy || dubbing}
                title="선택 컷의 대사·내레이션 음성 생성"
                className="ml-auto rounded-md border border-[var(--accent)] px-3 py-2 text-sm text-[var(--accent)] disabled:opacity-50"
              >
                선택 {selForVideo.size}개 더빙
              </button>
            )}
            <button
              onClick={() => runDubJob()}
              disabled={busy || dubbing}
              title="모든 컷의 대사(화자 목소리)·내레이션(나레이터)·효과음 음성 생성"
              className={`${selForVideo.size > 0 ? "" : "ml-auto "}rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50`}
            >
              {dubbing ? "더빙 중…" : "🎙 전체 더빙 생성"}
            </button>
          </div>

          {scenePolling && (
            <p className="mb-3 flex items-center gap-2 text-sm text-[var(--muted)]">
              <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
              동영상 생성 중{vidPending.size > 0 ? ` (${vidPending.size}컷)` : ""}…{" "}
              {progress && <span className="opacity-70">{progress}</span>}
              <button
                onClick={() => cancelJob("scene")}
                className="ml-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:border-[var(--danger)] hover:text-[var(--danger)]"
              >
                작업 중지
              </button>
            </p>
          )}
          {scenePolling && progressBar()}
          {scenePolling && progressLog.length > 0 && (
            <pre className="mb-3 max-h-44 w-full max-w-2xl overflow-y-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel-2)] p-2 text-[11px] leading-tight text-[var(--muted)]">
              {progressLog.slice(-14).join("\n")}
            </pre>
          )}
          {sceneStatus === "error" && (
            <p className="mb-3 rounded-md border border-[var(--danger)] bg-[var(--panel)] p-3 text-sm text-[var(--danger)]">
              {project.steps.scene.error ?? "동영상 오류"}
            </p>
          )}

          {/* 씬 목록 상단 바(스펙 §9) — "미결만 보기" 필터 + "삽입 대사 일괄 끄기". 아코디언 규칙 유지. */}
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => setOnlyUnresolved((v) => !v)}
              title="모션 티어가 없거나 확신도 낮은(미결) 컷만 표시"
              className={`rounded border px-2 py-0.5 ${onlyUnresolved ? "border-[var(--accent)] font-medium text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--panel-2)]"}`}
            >
              {onlyUnresolved ? "✓ " : ""}미결만 보기
            </button>
            <button
              type="button"
              onClick={bulkDisableInsertLines}
              title="AI 가 제안한 '삽입 대사'(원작에 없는 창작 대사)를 모든 컷에서 한 번에 끕니다"
              className="rounded border border-[var(--border)] px-2 py-0.5 text-[var(--muted)] hover:bg-[var(--panel-2)]"
            >
              삽입 대사 일괄 끄기
            </button>
            <span className="text-[var(--muted)]">· 줄을 눌러 펼치기(카메라·프롬프트·대사 편집)</span>
          </div>

          <div className="space-y-2">
            {project.scenes
              .filter((s) => s.generatedImage || (s.cut?.type === "text" && (s.cut?.bubbles?.length ?? 0) > 0))
              .filter((s) => !onlyUnresolved || isUnresolvedScene(s))
              .filter(inSection)
              .map((s) => {
                const isCardScene = !s.generatedImage; // 무성영화 자막 씬(영상·이미지 불필요)
                const bubs = s.cut?.bubbles ?? [];
                const spkIds = bubs.length
                  ? [...new Set(bubs.map((b) => b.speakerId).filter((x): x is string => !!x))]
                  : s.cut?.speakerId
                    ? [s.cut.speakerId]
                    : [];
                const spkChars = spkIds
                  .map((id) => project.cast?.find((c) => c.id === id))
                  .filter((c): c is NonNullable<typeof c> => !!c);
                const speakerLabel = spkChars.length
                  ? spkChars.map((c) => c.label).join(", ")
                  : "내레이터";
                const voiceLabel = spkChars.map((c) => c.voiceName || c.voice).filter(Boolean).join(", ");
                // 예상 영상 길이(초). 우선순위: 지정(durationSec) → 대사 글자수 → 무대사
                // 장면전환 4s → 그 외 2s. (worker estimateVideoSeconds 와 동일 규칙)
                const dubText =
                  (bubs.length ? bubs.map((b) => b.text).join(" ") : s.cut?.dialogue ?? "") +
                  " " +
                  (s.cut?.narration ?? "");
                const dubChars = dubText.replace(/\s+/g, "").length;
                const estSec = s.cut?.durationSec
                  ? s.cut.durationSec
                  : dubChars > 0
                    ? Math.max(2, Math.min(8, Math.round(dubChars / 5)))
                    : s.cut?.type === "transition"
                      ? 1.5
                      : 1;
                const curDur = s.cut?.durationSec ?? estSec;
                const setDur = (v: number) =>
                  updateCut(s.id, { durationSec: Math.max(0.5, Math.min(15, Math.round(v * 2) / 2)) });
                return (
                  <div
                    key={s.id}
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes("application/x-bubble")) return;
                      e.preventDefault(); // 대사 드롭 허용
                      if (bubDropId !== s.id) setBubDropId(s.id);
                    }}
                    onDragLeave={() => setBubDropId((t) => (t === s.id ? null : t))}
                    onDrop={(e) => {
                      if (!e.dataTransfer.types.includes("application/x-bubble")) return;
                      e.preventDefault();
                      try {
                        const d = JSON.parse(e.dataTransfer.getData("application/x-bubble") || "{}");
                        if (d.srcId) moveBubbleToScene(d.srcId, Number(d.srcIdx), s.id);
                      } catch {}
                      setBubDropId(null);
                    }}
                    className={`group rounded-lg border bg-[var(--panel)] p-2 ${
                      bubDropId === s.id ? "border-[var(--accent)] ring-2 ring-[var(--accent)]" : "border-[var(--border)]"
                    }`}
                  >
                    {/* 접힌 줄(스펙 §9) — 4요소만: 대사(한국어 주·원어 보조) / 길이 / 발화자 / 모션티어 드롭다운.
                        썸네일·상태·카메라·비용·프롬프트·대사편집은 펼침 본문으로. 줄 클릭=펼침/접기(아코디언). */}
                    {(() => {
                      const koP = (bubs.map((b) => b.translation).filter(Boolean).join(" ") || s.cut?.dialogueTranslation || "").trim();
                      const srcP = (bubs.map((b) => b.text).filter(Boolean).join(" ") || s.cut?.dialogue || "").trim();
                      // TODO(Phase5 작업언어 토글): 작업 언어 track 이 있으면 그걸 주 표기로. 지금은 한국어 주·원어 보조.
                      const primary = koP || srcP || (isCardScene ? "(자막 씬)" : "(무대사)");
                      const secondary = koP && srcP && srcP !== koP ? srcP : "";
                      const isOpen = openScene === s.id;
                      return (
                        <div className="flex items-center gap-2 text-[11px]">
                          <button
                            type="button"
                            onClick={() => setOpenScene((o) => (o === s.id ? null : s.id))}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            title="펼치기/접기"
                          >
                            <span className="shrink-0 text-[var(--muted)]">{isOpen ? "▾" : "▸"} {s.order + 1}</span>
                            {(s.generatedImage || s.originalImage) && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={s.generatedImage ?? s.originalImage}
                                alt=""
                                className="h-8 w-12 shrink-0 rounded border border-[var(--border)] object-cover"
                              />
                            )}
                            {isUnresolvedScene(s) && (
                              <span className="shrink-0 rounded bg-[var(--panel-2)] px-1 text-[9px] text-[var(--warn,#c90)]" title="모션 티어 미분류·저확신(미결)">미결</span>
                            )}
                            <span className="min-w-0 flex-1 truncate">
                              {primary}
                              {secondary && <span className="ml-1 text-[var(--muted)]">· {secondary}</span>}
                            </span>
                            <span className="shrink-0 text-[var(--muted)]" title="예상 길이(초)">{curDur}s</span>
                            <span className="max-w-[90px] shrink-0 truncate text-[var(--muted)]" title="발화자">{speakerLabel}</span>
                          </button>
                          <select
                            value={s.cut?.motionTier ?? ""}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => updateCut(s.id, { motionTier: (e.target.value || undefined) as CutOntology["motionTier"] })}
                            title="모션 티어(§3) — 다음 동영상 생성에 반영. talk=입·표정 / idle=숨·머리카락 / emote=표정전환 / action=강한 순간동작"
                            className="shrink-0 rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 py-0.5 text-[10px]"
                          >
                            <option value="">티어?</option>
                            <option value="talk">🗣 talk</option>
                            <option value="idle">🌿 idle</option>
                            <option value="emote">😮 emote</option>
                            <option value="action">⚡ action</option>
                          </select>
                          {/* 🎞 동작 보간(§4) — 접힌 줄에 항상 보이게. 다음 컷 있으면 표시, 조건 안 되면 비활성+안내. */}
                          {!isCardScene && (() => {
                            const ng = nextGenByScene.get(s.id) ?? { hasNext: false, next: null };
                            const next = ng.next;
                            if (!ng.hasNext) return null;
                            const canInterp = !!(s.generatedImage && next);
                            const on = s.cut?.interpolationOn === true;
                            return (
                              <label
                                onClick={(e) => e.stopPropagation()}
                                className={`flex shrink-0 items-center gap-0.5 rounded border px-1 py-0.5 text-[10px] ${on ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)]"} ${canInterp ? "cursor-pointer" : "opacity-40"}`}
                                title={canInterp ? `동작 보간: 이 컷 이미지 → 다음 컷(#${(next?.order ?? 0) + 1}) 이미지로 Kling 보간(첫+끝 프레임). Kling 엔진 필요.` : "동작 보간하려면 이 컷과 다음 컷을 둘 다 재생성(이미지)해야 합니다."}
                              >
                                <input
                                  type="checkbox"
                                  checked={on}
                                  disabled={!canInterp}
                                  onChange={(e) => updateCut(s.id, { interpolationOn: e.target.checked || undefined })}
                                  className="h-3 w-3"
                                />
                                🎞 다음 컷 액션연결
                              </label>
                            );
                          })()}
                        </div>
                      );
                    })()}
                    {openScene === s.id && (
                    <div className="mt-2 flex items-start gap-2">
                    <div className="flex w-6 shrink-0 flex-col items-center gap-1 pt-8">
                      {!isCardScene && (
                        <input
                          type="checkbox"
                          checked={selForVideo.has(s.id)}
                          onChange={() => toggleVideoSel(s.id)}
                          title="다중 선택 생성용"
                        />
                      )}
                      <span className="text-xs text-[var(--muted)]">{s.order + 1}</span>
                    </div>
                    {isCardScene ? (
                      // 무성영화 자막 씬 — 합성이 검은 배경+테두리를 만들고 글자는 자막으로 나감.
                      <div
                        onClick={() => setScenePreview(s.id)}
                        title="자막 씬 — 미리보기"
                        className="relative grid h-28 w-40 shrink-0 cursor-zoom-in place-items-center rounded border border-[var(--border)] bg-black px-3 text-center"
                      >
                        <span className="pointer-events-none absolute inset-1.5 rounded border border-[#f4efe4]/60" />
                        <span className="line-clamp-3 text-[11px] font-semibold text-[#f4efe4]">
                          {bubs[0]?.text || "자막 씬"}
                        </span>
                      </div>
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={s.generatedImage}
                        alt="생성"
                        onClick={() => setScenePreview(s.id)}
                        className="h-28 w-auto shrink-0 cursor-zoom-in rounded border border-[var(--border)]"
                      />
                    )}
                    {!isCardScene && (
                      <button
                        onClick={() => videoOne(s.id)}
                        disabled={busy || vidPending.has(s.id)}
                        title={s.videoUrl ? "동영상 다시 생성" : "동영상 생성 시작"}
                        className="shrink-0 pt-11 text-lg text-[var(--muted)] hover:text-[var(--accent)] disabled:opacity-40"
                      >
                        ▶
                      </button>
                    )}
                    {vidPending.has(s.id) ? (
                      // 생성 중이면 최우선 — 옛 영상이 남아 있어도 스피너를 보여준다(재생성 피드백).
                      <div className="grid h-28 w-24 shrink-0 place-items-center rounded border border-dashed border-[var(--accent)] px-1 text-center text-[10px] text-[var(--accent)]">
                        <span className="flex flex-col items-center gap-1.5">
                          <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
                          생성 중…
                        </span>
                      </div>
                    ) : s.videoUrl ? (
                      <LazyVideo
                        src={s.fxUrl ?? s.videoUrl}
                        onClick={() => setScenePreview(s.id)}
                        className="h-28 w-24 shrink-0 cursor-zoom-in rounded border border-[var(--ok)]"
                      />
                    ) : isCardScene ? null : (
                      <div className="grid h-28 w-24 shrink-0 place-items-center rounded border border-dashed border-[var(--border)] px-1 text-center text-[10px] text-[var(--muted)]">
                        {s.videoError ? `실패: ${s.videoError}` : "미생성"}
                      </div>
                    )}
                    <div className="flex min-w-0 flex-1 flex-col gap-1 text-[11px]">
                      {/* 🕐 생성 시각 — 다시 생성 후 이 시각이 바뀌면 진짜 새 영상, 안 바뀌면 생성/갱신이 안 된 것. */}
                      {!isCardScene && (s.videoUrl || s.videoError) && (
                        <span className="text-[10px] text-[var(--muted)]" title="이 영상이 생성된 시각 — 다시 생성 후 바뀌면 새 영상이 만들어진 것, 안 바뀌면 생성/갱신 안 됨">
                          {s.videoUrl ? (
                            <>🕐 영상 {fmtClock(urlTimestamp(s.videoUrl))}{s.fxUrl ? ` · 효과 ${fmtClock(urlTimestamp(s.fxUrl))}` : ""}</>
                          ) : (
                            <span className="text-[var(--danger)]">생성 실패</span>
                          )}
                        </span>
                      )}
                      {/* 조작 버튼 줄 — 평소엔 숨고, 카드에 마우스 올리거나 포커스 시에만 뜸(애플식: 콘텐츠 앞, 크롬 뒤). */}
                      <div className="flex flex-wrap items-center gap-2 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                        {isCardScene ? (
                          <span className="rounded border border-[var(--border)] px-2 py-0.5 text-[var(--muted)]" title="합성 때 검은 화면+테두리 위에 자막·더빙으로 렌더 — 이미지·영상 생성 불필요">
                            🎞 자막 씬(무성영화) — 영상 생성 불필요
                          </span>
                        ) : (
                        <button
                          onClick={() => videoOne(s.id)}
                          disabled={busy || vidPending.has(s.id)}
                          className="rounded bg-[var(--accent)] px-3 py-0.5 font-medium text-white disabled:opacity-40"
                          title="이 컷 이미지로 Grok 동영상 생성"
                        >
                          {vidPending.has(s.id) ? "생성 중…" : s.videoUrl ? "🎬 다시" : "🎬 동영상"}
                        </button>
                        )}
                        <div
                          className="flex items-center gap-1 text-[var(--muted)]"
                          title="영상 길이(초) · 0.5초 단위. 장면전환 등 무대사 컷은 여기서 늘리세요. '자동'=대사/타입 기준."
                        >
                          길이
                          <button
                            onClick={() => setDur(curDur - 0.5)}
                            disabled={busy}
                            className="rounded border border-[var(--border)] px-1.5 leading-none disabled:opacity-30"
                          >
                            −
                          </button>
                          <span className="w-9 text-center tabular-nums text-[var(--text)]">{curDur}s</span>
                          <button
                            onClick={() => setDur(curDur + 0.5)}
                            disabled={busy}
                            className="rounded border border-[var(--border)] px-1.5 leading-none disabled:opacity-30"
                          >
                            ＋
                          </button>
                          {s.cut?.durationSec ? (
                            <button
                              onClick={() => updateCut(s.id, { durationSec: undefined })}
                              className="text-[10px] underline opacity-70"
                            >
                              자동
                            </button>
                          ) : (
                            <span className="text-[10px] opacity-50">자동</span>
                          )}
                        </div>
                        <span className="text-[var(--muted)]">
                          화자: {speakerLabel}
                          {voiceLabel ? ` · 목소리: ${voiceLabel}` : " · 목소리 미지정"}
                        </span>
                        <button
                          type="button"
                          onClick={() => setScenePreview(s.id)}
                          title="이 씬 미리보기 — 영상+자막+더빙을 함께 확인(합성 전 수시 확인)"
                          className="rounded border border-[var(--accent)] px-2 py-0.5 text-[var(--accent)] hover:bg-[var(--panel-2)]"
                        >
                          👁 미리보기
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleAdvCut(s.id)}
                          title="이 컷 자동 연출 — 감정·전환·후처리 카메라(줌·팬)·동작·동영상 프롬프트·자막위치. 접었다 필요할 때 펼치기"
                          className={`rounded border px-2 py-0.5 ${
                            advCut.has(s.id) || s.cut?.motion || s.cut?.transition || s.fx
                              ? "border-[var(--accent)] text-[var(--accent)]"
                              : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                          }`}
                        >
                          {advCut.has(s.id) ? "⚙️ 연출 접기" : "⚙️ 연출·세부"}
                        </button>
                        <button
                          type="button"
                          onClick={() => runDubJob([s.id])}
                          disabled={busy || dubbing}
                          title="이 컷만 더빙(대사·내레이션·효과음) 다시 생성 — 하나만 고쳤을 때"
                          className="rounded border border-[var(--accent)] px-2 py-0.5 text-[var(--accent)] hover:bg-[var(--panel-2)] disabled:opacity-40"
                        >
                          🎙 이 컷 더빙
                        </button>
                        {sceneHasAudio(s) && (
                          <button
                            type="button"
                            onClick={() => playSceneAudio(s)}
                            title="이 씬 더빙 오디오 재생(대사→내레이션→효과음)"
                            className="rounded border border-[var(--ok)] px-2 py-0.5 text-[var(--ok)] hover:bg-[var(--panel-2)]"
                          >
                            🔊 씬 오디오
                          </button>
                        )}
                      </div>
                      {/* 🎬 연출 보고서(이 컷) — 큰 표를 컷마다 잘라 붙임. 접어두고 필요할 때 펼쳐 확인·보정. */}
                      <details className="rounded border border-[var(--border)] bg-[var(--panel-2)]">
                        <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-medium text-[var(--accent)]">
                          🎬 연출 보고서 (이 컷)
                        </summary>
                        <div className="px-2 pb-2">{directionPanel(s)}</div>
                      </details>
                      {advCut.has(s.id) && (<>
                      {/* ★연기(감정) — '이 컷 더빙' 전에 말풍선별 감정 지정. 예전엔 여기 없어서 컷에서
                          연기 지정을 못 했음(감정 픽커가 연출 보고서 테이블에만 있었음). 더빙에 반영됨. */}
                      {(s.cut?.bubbles ?? []).some((b) => (b.text || "").trim() && b.speakerId !== SFX_SPEAKER) && (
                        <div className="flex flex-col gap-1" title="이 컷 대사의 연기(감정) — 더빙 목소리에 반영">
                          <span className="text-[10px] text-[var(--muted)]">🎭 연기(감정)</span>
                          {(s.cut?.bubbles ?? []).map((b, bi) =>
                            (b.text || "").trim() && b.speakerId !== SFX_SPEAKER ? (
                              <div key={bi} className="flex flex-wrap items-center gap-1">
                                <span className="max-w-[160px] truncate text-[10px] text-[var(--text)]" title={b.text}>
                                  “{b.text.slice(0, 30)}”
                                </span>
                                <select
                                  value={b.emotion ?? ""}
                                  onChange={(e) => {
                                    const v = e.target.value || undefined;
                                    const nb = (s.cut?.bubbles ?? []).map((x, xi) => (xi === bi ? { ...x, emotion: v } : x));
                                    updateCut(s.id, { bubbles: nb });
                                  }}
                                  className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-0.5 py-0.5 text-[10px]"
                                >
                                  <option value="">🎭 (없음)</option>
                                  {EMOTIONS.map((em) => (
                                    <option key={em.id} value={em.id}>{em.label}</option>
                                  ))}
                                </select>
                              </div>
                            ) : null
                          )}
                        </div>
                      )}
                      {/* 전환 — 카메라워크처럼 칩으로. 이 컷 → 다음 컷 사이(5단계 합성에서 적용). */}
                      <div
                        className="flex flex-wrap items-center gap-1"
                        title="이 컷 → 다음 컷 사이 전환. 5단계 '영상 묶기' 결과에 적용됩니다."
                      >
                        <span className="text-[var(--muted)]">🎞</span>
                        {TRANSITIONS.map(([v, t]) => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => updateCut(s.id, { transition: v })}
                            disabled={busy}
                            className={`rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-40 ${
                              (s.cut?.transition ?? "none") === v
                                ? "border-[var(--accent)] font-medium text-[var(--accent)]"
                                : "border-[var(--border)] hover:bg-[var(--panel-2)]"
                            }`}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                      {/* 🎥 카메라워크는 별도 '카메라 미리보기' 탭으로 분리(A안) — 4단계는 영상 생성·더빙에 집중.
                          편집기·프리뷰·적용(굽기)은 그 탭에서. (여기 있던 CameraWorkEditor 제거) */}
                      {/* 🎞 동작 보간은 접힌 줄(모션티어 옆 🎞)로 옮김 — 항상 보이게. 여기선 중복 제거. */}
                      {/* 🔊 오디오 제안(스펙 §6) — VLM 이 뽑은 효과음·리액션 발성·삽입 대사. 삽입 대사는 원작에
                          없는 창작이라 체크박스로 on/off(기본 on). 생성되면(audioUrl) 재생. */}
                      {!isCardScene && (s.cut?.audioSuggestions?.length ?? 0) > 0 && (
                        <div className="rounded border border-[var(--border)] bg-[var(--panel-2)] p-1.5 text-[11px]">
                          <div className="mb-1 text-[var(--muted)]">🔊 오디오 제안 — 무음 최소화(효과음·리액션·삽입대사)</div>
                          <div className="flex flex-col gap-1">
                            {s.cut!.audioSuggestions!.map((sug, si) => {
                              const icon = sug.type === "sfx" ? "💥" : sug.type === "vocal_reaction" ? "😮" : "💬";
                              const isInsert = sug.type === "insert_line";
                              const on = sug.enabled !== false;
                              return (
                                <div key={si} className="flex items-center gap-1.5">
                                  {isInsert && (
                                    <input
                                      type="checkbox"
                                      checked={on}
                                      title="삽입 대사 켜기/끄기 — 원작에 없는 창작 대사"
                                      onChange={(e) => {
                                        const nb = (s.cut?.audioSuggestions ?? []).map((x, j) => (j === si ? { ...x, enabled: e.target.checked ? undefined : false } : x));
                                        updateCut(s.id, { audioSuggestions: nb });
                                      }}
                                    />
                                  )}
                                  <span title={sug.type}>{icon}</span>
                                  <span className={`min-w-0 flex-1 truncate ${isInsert && !on ? "text-[var(--muted)] line-through" : ""}`}>
                                    {sug.text}
                                    {sug.speaker && <span className="text-[var(--muted)]"> · {sug.speaker}</span>}
                                    {sug.timing && <span className="text-[var(--muted)]"> ({sug.timing})</span>}
                                  </span>
                                  {sug.audioUrl && <audio src={sug.audioUrl} controls className="h-5" />}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {/* ⚡후처리 줌 — 워커가 실픽셀에 굽고(컷당 20~40초) fxUrl 저장. 미리보기·합성이
                          그대로 사용(미리보기=최종). 원본 videoUrl 보존이라 재적용·해제 자유. */}
                      {!isCardScene && s.videoUrl && (
                        <div
                          className="flex flex-wrap items-center gap-1 text-[10px]"
                          title="후처리 카메라워크 — 실제 픽셀에 굽는 확정 카메라(줌·펀치·느린 팬). 방향 팬은 살짝 확대 후 그 방향으로 천천히 이동."
                        >
                          <span className="text-[var(--muted)]">⚡ 후처리 카메라</span>
                          <select
                            value={(fxSel[s.id]?.effect ?? s.fx?.effect) || "none"}
                            onChange={(e) =>
                              setFxSel((p) => ({
                                ...p,
                                [s.id]: { effect: e.target.value, strength: p[s.id]?.strength ?? s.fx?.strength ?? 2 },
                              }))
                            }
                            className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 py-0.5"
                          >
                            <option value="none">없음(원본)</option>
                            <option value="crash-in">⚡ 크래시 줌인</option>
                            <option value="crash-out">💥 크래시 줌아웃</option>
                            <option value="ramp-in">🚀 램프인(연속 가속)</option>
                            <option value="punch">📳 펀치+흔들</option>
                            <option value="pan-left">⬅ 느린 팬(왼쪽)</option>
                            <option value="pan-right">➡ 느린 팬(오른쪽)</option>
                            <option value="pan-up">⬆ 느린 팬(위)</option>
                            <option value="pan-down">⬇ 느린 팬(아래)</option>
                          </select>
                          <select
                            value={String(fxSel[s.id]?.strength ?? s.fx?.strength ?? 2)}
                            onChange={(e) =>
                              setFxSel((p) => ({
                                ...p,
                                [s.id]: {
                                  effect: p[s.id]?.effect ?? s.fx?.effect ?? "none",
                                  strength: Number(e.target.value),
                                },
                              }))
                            }
                            className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-1 py-0.5"
                            title="강도 — 강(2.0배)이 상한(그 이상은 화질 저하)"
                          >
                            <option value="1">약</option>
                            <option value="2">중</option>
                            <option value="3">강</option>
                          </select>
                          <button
                            type="button"
                            onClick={() => {
                              const sel = fxSel[s.id] ?? { effect: s.fx?.effect ?? "none", strength: s.fx?.strength ?? 2 };
                              runFxJob([s.id], sel.effect, sel.strength);
                            }}
                            disabled={busy || fxPending.has(s.id)}
                            className="rounded bg-[var(--accent)] px-2 py-0.5 font-medium text-white disabled:opacity-40"
                          >
                            {fxPending.has(s.id) ? "굽는 중…" : "적용"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const sel = fxSel[s.id] ?? { effect: s.fx?.effect ?? "none", strength: s.fx?.strength ?? 2 };
                              runFxJob([s.id], sel.effect, sel.strength, s.id); // 굽고 나서 미리보기 자동 오픈
                            }}
                            disabled={busy || fxPending.has(s.id)}
                            title="이 카메라워크를 구운 뒤(컷당 ~20-40초) 미리보기를 자동으로 열어 보여줍니다"
                            className="rounded border border-[var(--accent)] px-2 py-0.5 font-medium text-[var(--accent)] disabled:opacity-40 hover:bg-[var(--panel-2)]"
                          >
                            {fxPending.has(s.id) ? "굽는 중…" : "🎥 굽고 보기"}
                          </button>
                          {s.fxUrl && (
                            <span className="text-[var(--ok)]" title={`적용됨: ${s.fx?.effect} · 강도 ${s.fx?.strength}`}>
                              FX✓
                            </span>
                          )}
                        </div>
                      )}
                      {/* 프롬프트(컷 설명) — 4단계에서도 수정+다시 그리기 가능. Grok 이 정책
                          (moderation)으로 거부할 때 그림 수위를 낮춰 재생성 → 재도전하는 용도. */}
                      {!isCardScene && (
                        <div className="flex items-start gap-1">
                          <textarea
                            value={s.cut?.description ?? ""}
                            onChange={(e) => updateCut(s.id, { description: e.target.value })}
                            rows={2}
                            placeholder="컷 설명(그림 프롬프트) — 수정 후 🖼 로 다시 그리기 (정책 거부 시 수위 조절)"
                            className="min-w-0 flex-1 resize-none rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-1 text-[10px] leading-tight text-[var(--muted)]"
                          />
                          <button
                            type="button"
                            onClick={() => regenOne(s.id)}
                            disabled={busy || regenPending.has(s.id)}
                            title="수정한 설명으로 이 컷 이미지 다시 그리기 — 완료 후 🎬 동영상 재생성"
                            className="shrink-0 rounded border border-[var(--border)] px-1.5 py-1 text-sm text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
                          >
                            {regenPending.has(s.id) ? "…" : "🖼"}
                          </button>
                        </div>
                      )}
                      {/* 동작(이어가기) — AI 자동연출이 채운 피사체 동작. 그림에 이미 있는 동작의 '이어가기'만.
                          동영상 생성 프롬프트에 반영(cut.action). 연출 보고서와 같은 값 = 싱크. */}
                      {!isCardScene && (
                        <div className="flex items-center gap-1 text-[10px]" title="인물/피사체 동작(이어가기) — 그림에 이미 있는 동작만. 동영상 생성에 반영. (자동 연출이 채움)">
                          <span className="shrink-0 text-[var(--muted)]">🏃 동작</span>
                          <input
                            type="text"
                            value={s.cut?.action ?? ""}
                            onChange={(e) => updateCut(s.id, { action: e.target.value })}
                            placeholder="예: 계속 걷는다 (이어가기)"
                            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-0.5"
                          />
                        </div>
                      )}
                      {/* 동영상 프롬프트 — 이 컷 영상 생성에 넣을 '내용·움직임' 설명. 카메라워크는 별도(후처리).
                          비워두면 자동(정지+미세 생동감). 적으면 그 내용대로 움직임 유도 → 🎬 로 생성. */}
                      {!isCardScene && (
                        <div className="flex items-start gap-1">
                          <textarea
                            value={s.cut?.videoPrompt ?? ""}
                            onChange={(e) => updateCut(s.id, { videoPrompt: e.target.value })}
                            rows={2}
                            placeholder="동영상 프롬프트(내용·움직임) — 예: 바람에 머리카락 흩날리며 천천히 고개를 든다"
                            title="이 컷 동영상 생성에 넣을 내용 설명 — 무슨 일이 일어나는지·어떤 움직임인지. 카메라워크는 후처리로 별도."
                            className="min-w-0 flex-1 resize-none rounded border border-[var(--accent)]/50 bg-[var(--panel-2)] px-1.5 py-1 text-[10px] leading-tight"
                          />
                          <button
                            type="button"
                            onClick={() => videoOne(s.id)}
                            disabled={busy || vidPending.has(s.id)}
                            title="이 프롬프트로 동영상 생성"
                            className="shrink-0 rounded border border-[var(--border)] px-1.5 py-1 text-sm text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
                          >
                            {vidPending.has(s.id) ? "…" : "🎬"}
                          </button>
                        </div>
                      )}
                      {/* 🎬 프롬프트 직접 편집(고급) — 채우면 자동 조립을 무시하고 이걸 그대로 Grok 에 보냄(전체 제어). */}
                      {!isCardScene && (
                        <details className="rounded border border-[var(--border)] bg-[var(--panel-2)]" open={!!(s.cut?.videoPromptOverride || "").trim()}>
                          <summary className="cursor-pointer select-none px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                            🎬 프롬프트 직접 편집(고급){(s.cut?.videoPromptOverride || "").trim() ? " ✓ 사용 중" : ""}
                          </summary>
                          <div className="flex flex-col gap-1 px-1.5 pb-1.5">
                            <textarea
                              value={s.cut?.videoPromptOverride ?? ""}
                              onChange={(e) => updateCut(s.id, { videoPromptOverride: e.target.value })}
                              rows={4}
                              placeholder="비우면 자동 조립. 채우면 이 문장을 그대로 Grok 에 보냅니다(카메라 정지·절제 지시도 직접 넣어야 함)."
                              title="채우면 자동 프롬프트를 무시하고 이걸 그대로 사용 — 전체 제어. '기본값 불러오기'로 시작해 다듬으세요."
                              className="w-full resize-y rounded border border-[var(--accent)]/50 bg-[var(--panel)] px-1.5 py-1 text-[10px] leading-tight"
                            />
                            <div className="flex flex-wrap items-center gap-1">
                              <button
                                type="button"
                                onClick={() => updateCut(s.id, { videoPromptOverride: composeVideoPromptDraft(s) })}
                                title="현재 자동 조립 프롬프트를 불러와 여기서 다듬기"
                                className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                              >
                                기본값 불러오기
                              </button>
                              {(s.cut?.videoPromptOverride || "").trim() && (
                                <button
                                  type="button"
                                  onClick={() => updateCut(s.id, { videoPromptOverride: "" })}
                                  title="직접 편집 해제 → 자동 조립으로 복귀"
                                  className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)] hover:border-[var(--danger)] hover:text-[var(--danger)]"
                                >
                                  해제(자동으로)
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => videoOne(s.id)}
                                disabled={busy || vidPending.has(s.id)}
                                className="rounded bg-[var(--accent)] px-2 py-0.5 text-[10px] font-medium text-white disabled:opacity-40"
                              >
                                {vidPending.has(s.id) ? "…" : "🎬 이 프롬프트로 생성"}
                              </button>
                            </div>
                          </div>
                        </details>
                      )}
                      </>)}
                      {/* 대사·내레이션 통합 편집 — 각 줄에 화자(캐릭터/내레이션) 지정. 3단계와 싱크. */}
                      {dialogueEditor(s)}
                      {advCut.has(s.id) && (<>
                      {/* 자막 기본위치 — 컷 9분할(3×3). 줄별 지정이 없는 대사·내레이션에 적용. */}
                      <div className="flex items-center gap-2 text-[10px]" title="자막 기본위치 — 줄별(대사 옆 미니 그리드) 지정이 없는 자막에 적용. 얼굴을 피해 9곳 중 선택">
                        <span className="text-[var(--muted)]">자막 기본위치</span>
                        <div className="grid grid-cols-3 gap-px rounded border border-[var(--border)] p-0.5">
                          {SUB_Y.map((fy) =>
                            SUB_X.map((fx) => {
                              const active =
                                Math.abs(subFracX(s.cut) - fx) < 0.03 && Math.abs(subFracY(s.cut) - fy) < 0.03;
                              return (
                                <button
                                  key={`${fx}-${fy}`}
                                  type="button"
                                  onClick={() => updateCut(s.id, { subtitleX: fx, subtitleY: fy })}
                                  title={`가로 ${Math.round(fx * 100)}% · 세로 ${Math.round(fy * 100)}%`}
                                  className={`h-4 w-4 rounded-[2px] ${
                                    active ? "bg-[var(--accent)]" : "bg-[var(--panel-2)] hover:bg-[var(--border)]"
                                  }`}
                                />
                              );
                            })
                          )}
                        </div>
                      </div>
                      {/* 카메라 워크 → 모션 프롬프트 채움. 영상 프롬프트 = 모션(+가이드), 정지컷 내용은 이미지가 담당. */}
                      <div className="flex flex-wrap gap-1">
                        {CAMERA_MOVES.map(([id, label, mprompt]) => (
                          <button
                            key={id}
                            type="button"
                            onClick={() => {
                              // 기존에 넣은 프리셋 문구(현행+레거시)만 빼고 새 걸 붙임 → 사용자가 쓴 텍스트 유지.
                              let base = s.cut?.motion ?? "";
                              for (const [, , pr] of CAMERA_MOVES) base = base.split(pr).join("");
                              for (const pr of LEGACY_MOVE_PHRASES) base = base.split(pr).join("");
                              base = base.replace(/\s+/g, " ").trim();
                              updateCut(s.id, { motion: base ? `${base} ${mprompt}` : mprompt });
                            }}
                            disabled={busy}
                            className={`rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-40 ${
                              (s.cut?.motion ?? "").includes(mprompt)
                                ? "border-[var(--accent)] text-[var(--accent)]"
                                : "border-[var(--border)] hover:bg-[var(--panel-2)]"
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <textarea
                        value={s.cut?.motion ?? ""}
                        onChange={(e) => updateCut(s.id, { motion: e.target.value })}
                        rows={2}
                        placeholder="비디오 모션 프롬프트(영문) — 예: slow camera push-in, gentle wind"
                        className="w-full resize-none rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-1 font-mono text-[10px]"
                      />
                      </>)}
                    </div>
                    </div>
                    )}
                  </div>
                );
              })}
          </div>
        </section>
      )}

      {/* ── 카메라 미리보기(4단계에서 분리) — 생성된 영상 위 카메라워크 설정·미리보기·굽기 전용 ── */}
      {activeStep === "camera" && approved && project.scenes.some((s) => s.generatedImage) && (
        <section className="mb-6 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">🎥 카메라 미리보기</h2>
            <span className="text-xs text-[var(--muted)]">
              생성된 영상 위에 카메라워크를 얹어 미리보고 굽는 단계 — 가장 손이 많이 가고 예측이 어려운 작업이라 따로 뺐습니다. 편집기 프리뷰는 실시간 근사, ‘적용(굽기)’ 후 👁 결과가 최종 픽셀입니다.
            </span>
            <button
              type="button"
              onClick={bakeAllCamera}
              disabled={busy || fxPending.size > 0}
              className="ml-auto rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
              title="카메라워크가 지정된 모든 컷(영상 생성됨·정지 제외)을 한 번에 굽습니다(컷당 ~20-40초)."
            >
              {fxPending.size > 0 ? "굽는 중…" : "🎥 전체 굽기"}
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {project.scenes
              .filter((s) => s.generatedImage && inSection(s))
              .slice()
              .sort((a, b) => a.order - b.order)
              .map((s) => (
                <div key={s.id} className="flex flex-col gap-1.5 rounded border border-[var(--border)] bg-[var(--panel)] p-2">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-medium">컷 {s.order + 1}</span>
                    {(s.fxUrl || s.videoUrl) && (
                      <span className="text-[10px] text-[var(--muted)]" title="이 미리보기가 만들어진 시각 — 굽고 나면 바뀝니다">
                        🕐 {fmtClock(urlTimestamp(s.fxUrl ?? s.videoUrl))}{s.fxUrl ? " · 구움" : " · 원본"}
                      </span>
                    )}
                    {s.videoUrl ? (
                      <button
                        type="button"
                        onClick={() => setScenePreview(s.id)}
                        className="ml-auto rounded border border-[var(--accent)] px-2 py-0.5 text-[var(--accent)] hover:bg-[var(--panel-2)]"
                        title="구운 결과(최종 픽셀)를 영상+자막+더빙으로 확인"
                      >
                        👁 결과 보기
                      </button>
                    ) : (
                      <span className="ml-auto text-[10px] text-[var(--muted)]">영상 미생성 — 4단계에서 먼저 생성</span>
                    )}
                  </div>
                  {/* ★오빗은 후처리 굽기가 아니라 '영상 생성(I2V)' 때만 적용된다(2D로 시점 회전 불가) —
                      인터페이스 문제: 오빗을 고르면 이 컷 영상을 다시 생성해야 반영된다(사용자 지정). */}
                  {s.cut?.cameraWork?.preset === "orbit" && (
                    <div className="flex flex-wrap items-center gap-2 rounded border border-[var(--accent)] bg-[var(--panel-2)] px-2 py-1 text-[10px]">
                      <span className="text-[var(--accent)]">🛰 오빗은 ‘영상 생성’ 때 적용됩니다 — 이 컷 영상을 다시 생성하세요.</span>
                      <button
                        type="button"
                        onClick={() => videoOne(s.id)}
                        disabled={busy || vidPending.has(s.id)}
                        className="ml-auto rounded bg-[var(--accent)] px-2 py-0.5 font-medium text-white disabled:opacity-40"
                        title="오빗 카메라로 이 컷 영상을 다시 생성합니다(I2V)."
                      >
                        {vidPending.has(s.id) ? "생성 중…" : "🎬 오빗으로 영상 재생성"}
                      </button>
                    </div>
                  )}
                  <CameraWorkEditor
                    cameraWork={s.cut?.cameraWork}
                    imageUrl={s.generatedImage ?? s.originalImage}
                    videoUrl={s.videoUrl}
                    onChange={(cw) => updateCut(s.id, { cameraWork: cw })}
                    onApply={() => applyCameraFx(s.id)}
                    onPreview={s.videoUrl ? () => setScenePreview(s.id) : undefined}
                    applying={fxPending.has(s.id)}
                    busy={busy}
                  />
                </div>
              ))}
          </div>
        </section>
      )}

      {/* ── 5단계: 합성(영상 이어붙이기, 오디오·자막 없이) ── */}
      {activeStep === "compose" && approved && project.scenes.some((s) => s.generatedImage) && (
        <section className="mb-6">
          {(() => {
            const nVid = project.scenes.filter((s) => s.videoUrl).length;
            return (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold">{STEP_LABEL.compose}</h2>
                <span className="text-xs text-[var(--muted)]">
                  — 영상 {nVid}개를 하나로 이어붙이기(전환 적용 · 오디오·자막은 나중)
                </span>
                <button
                  onClick={runComposeJob}
                  disabled={busy || composeRunning || nVid === 0}
                  title={nVid === 0 ? "먼저 4단계에서 동영상을 생성하세요" : ""}
                  className="ml-auto rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {composeRunning ? "합성 중…" : project.composedUrl ? "다시 합성" : "영상 묶기"}
                </button>
              </div>
            );
          })()}

          {/* 방향 B — 섹션이 있으면 섹션별 합성 후 최종 이어붙이기(한 잡=섹션치 → OOM·디스크 안전판, 실패 격리) */}
          {sections.length > 0 && (
            <div className="mb-4 rounded border border-[var(--accent)] bg-[var(--panel-2)] p-2 text-[11px]">
              <div className="mb-1.5 font-semibold text-[var(--accent)]">📚 섹션별 합성 → 최종 이어붙이기 <span className="font-normal text-[var(--muted)]">(서버 부하↓·실패 격리·부분 검토)</span></div>
              <div className="flex flex-col gap-1">
                {sections.map((s) => {
                  const secVidIds = orderedScenes.slice(s.start, s.end).filter((x) => x.videoUrl).map((x) => x.id);
                  const key = String(s.start);
                  const done = !!project.sectionVideos?.[key];
                  const pending = secComposePending.has(key);
                  return (
                    <div key={s.i} className="flex flex-wrap items-center gap-2">
                      <span className="w-24 shrink-0 font-medium">섹션 {s.i + 1} <span className="opacity-60">({s.start + 1}–{s.end})</span></span>
                      <span className="text-[var(--muted)]">영상 {secVidIds.length}컷</span>
                      {done && <span className="text-[var(--ok,#3a3)]">✓ 합성됨</span>}
                      <button type="button" onClick={() => composeSection(key, secVidIds)} disabled={busy || pending || secVidIds.length === 0} className="rounded border border-[var(--border)] px-2 py-0.5 hover:border-[var(--accent)] disabled:opacity-40">
                        {pending ? "합성 중…" : done ? "다시 합성" : "이 섹션 합성"}
                      </button>
                      {done && project.sectionVideos?.[key] && (
                        <button type="button" onClick={() => setLightbox({ type: "video", src: project.sectionVideos![key] })} className="rounded border border-[var(--accent)] px-2 py-0.5 text-[var(--accent)] hover:bg-[var(--panel)]">▶ 보기</button>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2">
                {(() => {
                  const allDone = sections.length > 0 && sections.every((s) => project.sectionVideos?.[String(s.start)]);
                  return (
                    <button type="button" onClick={joinSections} disabled={busy || composeRunning || !allDone} title={allDone ? "섹션 합성본들을 순서대로 최종 이어붙이기" : "모든 섹션을 먼저 합성하세요"} className="rounded bg-[var(--accent)] px-3 py-1 font-medium text-white disabled:opacity-40">
                      {composeRunning ? "이어붙이는 중…" : "🎬 최종 이어붙이기"}
                    </button>
                  );
                })()}
                <span className="text-[10px] text-[var(--muted)]">모든 섹션 합성 → 최종 이어붙이기 → 완성 영상(경계는 하드컷). 위 ‘영상 묶기’는 섹션 무시하고 통째 합성(무거움).</span>
              </div>
            </div>
          )}

          {composeRunning && (
            <p className="mb-3 flex items-center gap-2 text-sm text-[var(--muted)]">
              <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
              합성 중… {progress && <span className="opacity-70">{progress}</span>}
              <button
                onClick={() => cancelJob("compose")}
                className="ml-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:border-[var(--danger)] hover:text-[var(--danger)]"
              >
                작업 중지
              </button>
            </p>
          )}
          {composeRunning && progressBar()}
          {composeRunning && progressLog.length > 0 && (
            <pre className="mb-3 max-h-44 w-full max-w-2xl overflow-y-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel-2)] p-2 text-[11px] leading-tight text-[var(--muted)]">
              {progressLog.slice(-14).join("\n")}
            </pre>
          )}
          {composeStatus === "error" && (
            <p className="mb-3 rounded-md border border-[var(--danger)] bg-[var(--panel)] p-3 text-sm text-[var(--danger)]">
              {project.steps.compose.error ?? "합성 오류"}
            </p>
          )}

          {/* ✏️ 대사·자막 수정 — 합성 단계에서도 텍스트를 고치고 바로 저장(updateCut 700ms 자동저장).
              4단계 편집기와 같은 것(같은 저장 = 싱크). 합성 중에도 열려 있음. 자막은 다시 '합성',
              목소리는 4단계 '더빙'을 다시 돌리면 반영된다. */}
          {project.scenes.some((s) => (s.cut?.bubbles?.length ?? 0) > 0 || s.generatedImage) && (
            <details className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--panel)]">
              <summary className="cursor-pointer select-none px-3 py-2 text-sm font-semibold">
                ✏️ 대사·자막 수정{" "}
                <span className="font-normal text-[var(--muted)]">
                  — 여기서 고치면 자동 저장(자막=다시 합성, 목소리=4단계 더빙 다시 돌리면 반영)
                </span>
              </summary>
              <div className="max-h-[60vh] space-y-2 overflow-auto px-2 pb-2">
                {project.scenes
                  .filter((s) => (s.cut?.bubbles?.length ?? 0) > 0 || s.generatedImage)
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map((s) => (
                    <div key={s.id} className="rounded border border-[var(--border)] bg-[var(--panel-2)] p-2">
                      <div className="mb-1 flex items-center gap-2 text-[10px] text-[var(--muted)]">
                        {(s.generatedImage || s.originalImage) && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={s.generatedImage || s.originalImage} alt="" className="h-8 w-8 rounded object-cover" />
                        )}
                        컷 {s.order + 1}
                      </div>
                      {dialogueEditor(s)}
                    </div>
                  ))}
              </div>
            </details>
          )}

          {project.composedUrl && (
            <div className="space-y-2">
              <video
                src={project.composedUrl}
                controls
                className="max-h-[60vh] w-auto rounded border border-[var(--ok)]"
              />
              <div>
                <a href={project.composedUrl} download className="text-sm text-[var(--accent)] underline">
                  ⬇ 최종 영상 다운로드
                </a>
              </div>
            </div>
          )}
        </section>
      )}

      <footer className="mt-8 border-t border-[var(--border)] pt-3 text-xs text-[var(--muted)]">
        누적 API 예상비용:{" "}
        <span className="font-semibold text-[var(--text)]">
          {costKrw === null ? "…" : `₩${costKrw.toLocaleString("ko-KR")}`}
        </span>{" "}
        <span className="opacity-60">(환율 1,500원 기준)</span>
      </footer>

      {/* 💰 추정 제작비 — 스크롤 안 해도 항상 보이게 플로팅(하단 왼쪽). 잡 완료마다 갱신됨. */}
      <div
        className="fixed bottom-4 left-4 z-40 flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-xs shadow-lg"
        title="지금까지 이 프로젝트에 든 API 예상 비용(환율 1,500원 기준). 생성할 때마다 갱신됩니다."
      >
        <span>💰</span>
        <span className="text-[var(--muted)]">추정 제작비</span>
        <span className="font-semibold text-[var(--text)]">
          {costKrw === null ? "…" : `₩${costKrw.toLocaleString("ko-KR")}`}
        </span>
      </div>

      {/* 워커 작업 플로팅 표시 — 스크롤·화면 전환과 무관하게 항상 보임 */}
      {workLabel && (
        <div className="fixed bottom-4 right-4 z-40 flex max-w-[90vw] items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-xs shadow-lg">
          <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
          <span className="font-medium">{workLabel} 중</span>
          {miniBar()}
          {progress && <span className="truncate text-[var(--muted)]">· {progress}</span>}
        </div>
      )}

      {/* 📋 작업 로그 — ★단계를 옮기든 스크롤을 하든 항상 열 수 있어야 한다.
             예전엔 1단계 섹션 안에만 있어서 단계를 넘기면 사라졌다(사용자: "로그가 계속 보이게
             해야 내가 수정을 하지"). 로그를 보면서 컷·대사를 고치는 게 실제 작업 방식이므로,
             화면 전환과 무관한 플로팅 패널로 둔다. 분할·캐스팅·재생성 진행 로그가 모두 여기로 온다. */}
      {progressLog.length > 0 && !logOpen && (
        <button
          onClick={() => setLogOpen(true)}
          className={`fixed ${workLabel ? "bottom-16" : "bottom-4"} right-4 z-40 flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-xs shadow-lg hover:border-[var(--accent)]`}
          title="워커 작업 로그 보기 — 단계별 소요·경고·실패 사유"
        >
          <span>📋</span>
          <span className="text-[var(--muted)]">작업 로그</span>
          <span className="font-semibold">{progressLog.length}</span>
        </button>
      )}
      {logOpen && (
        <div
          className={`fixed ${workLabel ? "bottom-16" : "bottom-4"} right-4 z-40 flex max-h-[52vh] w-[min(92vw,44rem)] flex-col rounded-lg border border-[var(--border)] bg-[var(--panel)] shadow-2xl`}
        >
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-xs">
            <span className="font-medium">📋 작업 로그</span>
            <span className="text-[var(--muted)]">{progressLog.length}줄</span>
            {running && <span className="text-[var(--accent)]">· 진행 중</span>}
            <span className="ml-auto flex items-center gap-1">
              <button
                onClick={() => navigator.clipboard?.writeText(progressLog.join("\n"))}
                className="rounded border border-[var(--border)] px-2 py-0.5 hover:border-[var(--accent)]"
              >
                복사
              </button>
              <button
                onClick={() => setProgressLog([])}
                className="rounded border border-[var(--border)] px-2 py-0.5 hover:border-[var(--accent)]"
              >
                지우기
              </button>
              <button
                onClick={() => setLogOpen(false)}
                className="rounded border border-[var(--border)] px-2 py-0.5 hover:border-[var(--accent)]"
              >
                닫기
              </button>
            </span>
          </div>
          <pre className="overflow-y-auto whitespace-pre-wrap p-3 text-[11px] leading-tight text-[var(--muted)]">
            {progressLog.join("\n")}
          </pre>
        </div>
      )}

      {/* 클릭 확대(라이트박스) — 배경 클릭/✕ 로 닫기 */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          {lightbox.type === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={lightbox.src}
              alt=""
              className="max-h-[92vh] max-w-[92vw] rounded object-contain"
            />
          ) : (
            <video
              src={lightbox.src}
              controls
              autoPlay
              loop
              muted
              onClick={(e) => e.stopPropagation()}
              className="max-h-[92vh] max-w-[92vw] rounded"
            />
          )}
          <button
            onClick={() => setLightbox(null)}
            className="absolute right-4 top-4 rounded-md bg-white/20 px-3 py-1 text-sm text-white hover:bg-white/30"
          >
            ✕ 닫기
          </button>
        </div>
      )}

      {/* 씬 미리보기 — 영상 + 자막(오버레이) + 더빙 오디오를 함께. 합성 전 수시 확인용. */}
      {scenePreview &&
        (() => {
          const s = project.scenes.find((x) => x.id === scenePreview);
          if (!s) return null;
          const units = subtitleUnits(s.cut);
          return (
            <div
              onClick={() => setScenePreview(null)}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
            >
              <div onClick={(e) => e.stopPropagation()} className="flex max-h-[92vh] max-w-[92vw] flex-col items-center gap-3">
                <div className="relative">
                  {s.videoUrl ? (
                    <video src={s.fxUrl ?? s.videoUrl} autoPlay muted loop playsInline className="max-h-[70vh] max-w-[86vw] rounded" />
                  ) : s.generatedImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={s.generatedImage} alt="" className="max-h-[70vh] max-w-[86vw] rounded" />
                  ) : s.cut?.type === "text" && units.length > 0 ? (
                    // 무성영화 자막 씬 — 검은 배경+이중 테두리(합성과 동일 룩), 글자는 아래 자막 오버레이가 표시.
                    <div className="relative h-[60vh] w-[min(86vw,30rem)] rounded bg-black">
                      <span className="pointer-events-none absolute inset-[4%] border-2 border-[#f4efe4]/80" />
                      <span className="pointer-events-none absolute inset-[5.2%] border border-[#f4efe4]/60" />
                    </div>
                  ) : (
                    <div className="grid h-40 w-72 place-items-center rounded bg-[var(--panel)] text-sm text-[var(--muted)]">
                      이미지/영상 없음
                    </div>
                  )}
                  {units.length > 0 && (() => {
                    const u = units[Math.min(subIdx, units.length - 1)];
                    const fx = typeof u.sx === "number" ? Math.max(0.05, Math.min(0.95, u.sx)) : subFracX(s.cut);
                    const cardDefault = s.cut?.type === "text" && !s.cut?.subtitlePos && s.cut?.subtitleY == null; // 카드 씬 기본=정중앙
                    const fy =
                      typeof u.sy === "number" ? Math.max(0.05, Math.min(0.95, u.sy)) : cardDefault ? 0.5 : subFracY(s.cut);
                    return (
                    <div
                      className="pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5"
                      style={{ left: `${fx * 100}%`, top: `${fy * 100}%` }}
                    >
                      {/* 한 번에 한 박스만(순차) — 위치는 그 줄 지정(없으면 컷 기본). [[강조]]는 크게·노랑. */}
                      <span className="max-w-[86vw] whitespace-pre-wrap rounded bg-black/60 px-3 py-1 text-center text-sm font-semibold text-white">
                        {splitRuns(u.text).map((r, ri) =>
                          r.em ? (
                            <span key={ri} className="text-[1.3em] font-extrabold text-[#ffd23f]">
                              {r.t}
                            </span>
                          ) : (
                            <span key={ri}>{r.t}</span>
                          )
                        )}
                      </span>
                      {/* 편집 보조용 번역(최종 자막엔 안 나감) — 원문 아래 작게 */}
                      {u.tr && (
                        <span className="max-w-[86vw] whitespace-pre-wrap rounded bg-black/40 px-2 py-0.5 text-center text-[11px] italic text-white/75">
                          {u.tr}
                        </span>
                      )}
                    </div>
                    );
                  })()}
                </div>
                <div className="flex items-center gap-2 text-sm text-white">
                  <span className="opacity-80">컷 {s.order + 1}</span>
                  {sceneHasAudio(s) ? (
                    <button onClick={() => playSceneAudio(s)} className="rounded border border-white/30 px-3 py-1 hover:bg-white/10">
                      ▶ 더빙 다시 듣기
                    </button>
                  ) : (
                    <span className="opacity-60">더빙 오디오 없음 — 🎙 더빙 먼저</span>
                  )}
                  <button onClick={() => setScenePreview(null)} className="rounded bg-white/20 px-3 py-1 hover:bg-white/30">
                    ✕ 닫기
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
