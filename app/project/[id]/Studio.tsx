"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import {
  type Project,
  type StepKind,
  type Character,
  type CutOntology,
  STEP_ORDER,
} from "@/lib/types";
import { blankCut } from "@/lib/ontology";
import BoundaryEditor, { type SavedRegion } from "./BoundaryEditor";
import CastReview from "./CastReview";

const STEP_LABEL: Record<StepKind, string> = {
  source: "1. 소스 · 컷 분할",
  cast: "2. 캐스팅",
  regen: "3. 재생성",
  scene: "4. 씬 · 더빙",
  compose: "5. 합성",
};

export default function Studio({ initialProject }: { initialProject: Project }) {
  const [project, setProject] = useState<Project>(initialProject);
  const projectRef = useRef(project);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [srcOpen, setSrcOpen] = useState<boolean | null>(null); // null=기본(승인되면 접힘)
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
      setProject((prev) => ({
        ...prev,
        scenes: d.scenes ?? prev.scenes,
        steps: { ...prev.steps, regen: { ...prev.steps.regen, status: d.status, error: d.error } },
      }));
    } catch {
      /* 다음 틱 재시도 */
    }
  }, [project.id]);

  useEffect(() => {
    if (!regenRunning) return;
    const t = setInterval(pollRegen, 2500);
    const first = setTimeout(pollRegen, 0);
    return () => {
      clearInterval(t);
      clearTimeout(first);
    };
  }, [regenRunning, pollRegen]);

  // projectRef 를 최신 project 로 동기화(자동저장 디바운스에서 최신 cut 읽기용).
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // 누적 API 비용(₩) — 마운트 + 단계 변화(분할 완료 등) 때 갱신.
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
  }, [project.id, sourceStatus]);

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

  async function saveRegions(regions: SavedRegion[]) {
    const r = await fetch("/api/boundaries", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, regions }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error ?? "저장 실패");
    setProject((prev) => ({ ...prev, scenes: d.scenes }));
  }

  async function runRegenJob() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/regen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "재생성 실패");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, regen: { ...prev.steps.regen, status: "running" } },
      }));
    } catch (e) {
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

  // 출력 비율 선택(세로/가로/1:1) — 모든 컷이 이 비율로 일관되게 생성됨.
  async function setAspect(aspectRatio: "16:9" | "9:16" | "1:1") {
    setProject((prev) => ({ ...prev, aspectRatio }));
    await fetch(`/api/project/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aspectRatio }),
    }).catch(() => {});
  }

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
  async function regenSelected() {
    if (selForRegen.size === 0) return;
    setError("");
    try {
      const r = await fetch("/api/regen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, sceneIds: [...selForRegen] }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "생성 실패");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, regen: { ...prev.steps.regen, status: "running" } },
      }));
      setSelForRegen(new Set());
    } catch (e) {
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
    try {
      const r = await fetch("/api/regen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, sceneIds: [sceneId] }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "생성 실패");
      setProject((prev) => ({
        ...prev,
        steps: { ...prev.steps, regen: { ...prev.steps.regen, status: "running" } },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "생성 실패");
    }
  }

  // 워커 작업 중지 — 워커 프로세스는 못 죽이지만 UI 가 '진행 중'에 갇히지 않게 단계를 되돌림.
  async function cancelJob(step: "source" | "cast" | "regen") {
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

  async function saveCast(
    cast: Character[],
    speakers: Record<string, string>,
    approve: boolean
  ) {
    const r = await fetch("/api/cast", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, cast, speakers, approve }),
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

  const canvas = project.virtualCanvas;
  const hasCuts = project.scenes.length > 0;
  const approved = sourceStatus === "approved";
  const typedCount = project.scenes.filter((s) => s.cut?.type).length;
  const showSrc = srcOpen ?? !approved; // 1단계 완료(승인)되면 소스 섹션 기본 접힘
  const charCutCount = project.scenes.filter((s) => s.cut?.type === "person").length;

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

      {/* 단계 네비 (M1 은 1단계만 활성) */}
      <nav className="mb-6 flex gap-1 text-xs">
        {STEP_ORDER.map((k) => {
          const active = k === "source" || ((k === "cast" || k === "regen") && approved);
          return (
            <span
              key={k}
              className={`rounded px-2.5 py-1 ${
                active
                  ? "bg-[var(--panel-2)] text-[var(--text)]"
                  : "bg-transparent text-[var(--muted)] opacity-50"
              }`}
              title={active ? "" : "다음 마일스톤"}
            >
              {STEP_LABEL[k]}
            </span>
          );
        })}
      </nav>

      {error && (
        <p className="mb-4 rounded-md border border-[var(--danger)] bg-[var(--panel)] p-3 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

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

      {/* 진행 표시 */}
      {running && (
        <div className="mb-6">
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
          {(() => {
            const m = progress.match(/\((\d+)%\)/);
            const pct = m ? Number(m[1]) : null;
            if (pct === null) return null;
            return (
              <div className="mt-2 h-1.5 w-full max-w-md overflow-hidden rounded-full bg-[var(--panel-2)]">
                <div
                  className="h-full bg-[var(--accent)] transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
            );
          })()}
          {progressLog.length > 0 && (
            <pre className="mt-2 max-h-44 w-full max-w-2xl overflow-y-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel-2)] p-2 text-[11px] leading-tight text-[var(--muted)]">
              {progressLog.slice(-14).join("\n")}
            </pre>
          )}
        </div>
      )}

      {/* 2) G1 경계 편집 (검수 대기) */}
      {!running && canvas && hasCuts && sourceStatus === "review" && (
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
              disabled={busy}
              className="rounded-md bg-[var(--ok)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              경계 확정 · 컷 추출
            </button>
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

      {/* M2) 캐스팅 — 등장인물 구분 */}
      {approved && (
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
                onClick={runCastJob}
                disabled={busy || castRunning}
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
              <CastReview scenes={project.scenes} cast={project.cast ?? []} onSave={saveCast} />
            </>
          )}
        </section>
      )}

      {/* M3) 재생성 — 좌(원본) / 우(생성) */}
      {approved && (
        <section className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold">
                3. 재생성{" "}
                <span className="font-normal text-[var(--muted)]">— gpt-image-1, 병렬</span>
              </h2>
              <div className="flex items-center gap-1 text-xs">
                <span className="text-[var(--muted)]">출력 비율:</span>
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
                    { v: "mask", t: "원본 유지", d: "그림은 그대로 두고 빈 공간·글씨만 채움(권장)" },
                    { v: "full", t: "새로 그리기", d: "컷을 통째로 다시 생성" },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.v}
                    onClick={() => setProjectRegenMode(o.v)}
                    title={o.d}
                    className={`rounded border px-2 py-0.5 ${
                      (project.regenMode || "mask") === o.v
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
              {selForRegen.size > 0 && (
                <button
                  onClick={regenSelected}
                  disabled={busy || regenRunning}
                  className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  선택 {selForRegen.size}개 생성
                </button>
              )}
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

          {regenRunning && (
            <p className="mb-3 flex items-center gap-2 text-sm text-[var(--muted)]">
              <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
              이미지 생성 중… {progress && <span className="opacity-70">{progress}</span>}
              <button
                onClick={() => cancelJob("regen")}
                className="ml-1 rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:border-[var(--danger)] hover:text-[var(--danger)]"
              >
                작업 중지
              </button>
            </p>
          )}
          {regenRunning && progressLog.length > 0 && (
            <pre className="mb-3 max-h-44 w-full max-w-2xl overflow-y-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--panel-2)] p-2 text-[11px] leading-tight text-[var(--muted)]">
              {progressLog.slice(-14).join("\n")}
            </pre>
          )}

          {regenStatus === "error" && (
            <p className="mb-3 rounded-md border border-[var(--danger)] bg-[var(--panel)] p-3 text-sm text-[var(--danger)]">
              {project.steps.regen.error ?? "재생성 오류"}
            </p>
          )}

          {project.scenes.some((s) => s.originalImage) && (
            <div className="space-y-2">
              {project.scenes
                .filter((s) => s.originalImage && s.cut?.type !== "text")
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
                        className="h-28 w-auto shrink-0 rounded border border-[var(--border)]"
                      />
                      <span className="shrink-0 pt-11 text-[var(--muted)]">→</span>
                      {s.generatedImage ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={s.generatedImage}
                          alt="생성"
                          className="glow-accent h-28 w-auto shrink-0 rounded border border-[var(--accent)]"
                        />
                      ) : (
                        <div className="grid h-28 w-24 shrink-0 place-items-center rounded border border-dashed border-[var(--border)] px-1 text-center text-[10px] text-[var(--muted)]">
                          {s.regenError
                            ? `실패: ${s.regenError}`
                            : regenRunning
                              ? "생성 대기…"
                              : "미생성"}
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
                        <input
                          value={s.cut?.dialogue ?? ""}
                          onChange={(e) => updateCut(s.id, { dialogue: e.target.value })}
                          placeholder="대사 (이 칸에 들어갈 자막·더빙)"
                          className="w-full rounded border border-[var(--border)] bg-[var(--panel-2)] px-1.5 py-1 text-[11px]"
                        />
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

      <footer className="mt-8 border-t border-[var(--border)] pt-3 text-xs text-[var(--muted)]">
        누적 API 예상비용:{" "}
        <span className="font-semibold text-[var(--text)]">
          {costKrw === null ? "…" : `₩${costKrw.toLocaleString("ko-KR")}`}
        </span>{" "}
        <span className="opacity-60">(환율 1,500원 기준)</span>
      </footer>
    </div>
  );
}
