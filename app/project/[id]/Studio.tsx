"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { type Project, type StepKind, STEP_ORDER } from "@/lib/types";
import BoundaryEditor from "./BoundaryEditor";

const STEP_LABEL: Record<StepKind, string> = {
  source: "1. 소스 · 컷 분할",
  cast: "2. 캐스팅",
  regen: "3. 재생성",
  scene: "4. 씬 · 더빙",
  compose: "5. 합성",
};

export default function Studio({ initialProject }: { initialProject: Project }) {
  const [project, setProject] = useState<Project>(initialProject);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [uploadMsg, setUploadMsg] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const elapsedTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const sourceStatus = project.steps.source.status;
  const running = sourceStatus === "running";

  // ── 분할/추출 진행 폴링 (워커 작업 중일 때만) ──────────────────────────────
  const poll = useCallback(async () => {
    try {
      const r = await fetch(`/api/split?projectId=${project.id}`, { cache: "no-store" });
      const d = await r.json();
      if (!d.ok) return;
      setProgress(d.progress ?? "");
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

  // ── 액션 ────────────────────────────────────────────────────────────────
  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError("");
    setElapsed(0);
    const startedAt = Date.now();
    elapsedTimer.current = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      500
    );
    try {
      const list = Array.from(files);
      const registered: { url: string; width: number; height: number }[] = [];
      // 각 파일을 브라우저에서 Blob 로 "직접" 업로드(서버리스 4.5MB 본문 한계 우회).
      // 큰 웹툰 파일은 multipart 로 청크 전송. 크기는 여기서 재서 함께 등록.
      // 진행률(onUploadProgress)을 파일별로 중계 → 사용자가 멈춤/진행을 구분.
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const bmp = await createImageBitmap(f);
        const dims = { width: bmp.width, height: bmp.height };
        bmp.close?.();
        setUploadMsg(`업로드 중 ${i + 1}/${list.length} · ${f.name} · 0%`);
        const blob = await upload(
          `project/${project.id}/source-${Date.now()}-${f.name}`,
          f,
          {
            access: "public",
            handleUploadUrl: "/api/source/blob-upload",
            onUploadProgress: (p) => {
              const pct = Number.isFinite(p.percentage) ? Math.round(p.percentage) : 0;
              setUploadMsg(`업로드 중 ${i + 1}/${list.length} · ${f.name} · ${pct}%`);
            },
          }
        );
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
      setError(e instanceof Error ? e.message : "업로드 실패");
    } finally {
      setBusy(false);
      setUploadMsg("");
      if (elapsedTimer.current) {
        clearInterval(elapsedTimer.current);
        elapsedTimer.current = null;
      }
      if (fileRef.current) fileRef.current.value = "";
    }
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

  async function saveRegions(regions: { yStart: number; yEnd: number }[]) {
    const r = await fetch("/api/boundaries", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, regions }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error ?? "저장 실패");
    setProject((prev) => ({ ...prev, scenes: d.scenes }));
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

  const canvas = project.virtualCanvas;
  const hasCuts = project.scenes.length > 0;
  const approved = sourceStatus === "approved";

  return (
    <div>
      {/* 헤더 */}
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">{project.name}</h1>
        <span className="text-xs text-[var(--muted)]">{project.aspectRatio}</span>
      </div>

      {/* 단계 네비 (M1 은 1단계만 활성) */}
      <nav className="mb-6 flex gap-1 text-xs">
        {STEP_ORDER.map((k) => {
          const active = k === "source";
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
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">소스 이미지</h2>
          <span className="text-xs text-[var(--muted)]">
            업로드 순서 = 세로 스크롤 순서
          </span>
        </div>

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
          <p className="mb-3 flex items-center gap-2 text-sm text-[var(--muted)]">
            <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
            <span>
              {uploadMsg} · {elapsed}초
            </span>
          </p>
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
            className="mt-4 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {running ? "처리 중…" : hasCuts ? "다시 분할" : "컷 자동 분할"}
          </button>
        )}
      </section>

      {/* 진행 표시 */}
      {running && (
        <p className="mb-6 flex items-center gap-2 text-sm text-[var(--muted)]">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
          워커 작업 중… {progress && <span className="opacity-70">{progress}</span>}
        </p>
      )}

      {/* 2) G1 경계 편집 (검수 대기) */}
      {!running && canvas && hasCuts && sourceStatus === "review" && (
        <section className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              G1 · 컷 경계 검수{" "}
              <span className="font-normal text-[var(--muted)]">
                ({project.scenes.length}컷)
              </span>
            </h2>
            <button
              onClick={confirm}
              disabled={busy}
              className="rounded-md bg-[var(--ok)] px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              경계 확정 · 컷 추출
            </button>
          </div>
          <BoundaryEditor
            sourceFiles={project.sourceFiles}
            canvas={canvas}
            scenes={project.scenes}
            onSave={saveRegions}
          />
        </section>
      )}

      {/* 3) 추출 완료 */}
      {approved && (
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-semibold">
            추출된 컷{" "}
            <span className="font-normal text-[var(--muted)]">
              ({project.scenes.length}컷) — 1단계 완료, 이후 캐스팅(M2)로
            </span>
          </h2>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {project.scenes.map((s) => (
              <div key={s.id} className="rounded border border-[var(--border)] bg-[var(--panel)] p-1">
                {s.originalImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.originalImage} alt={`cut ${s.order}`} className="w-full rounded" />
                ) : (
                  <div className="grid h-24 place-items-center text-xs text-[var(--muted)]">
                    #{s.order}
                  </div>
                )}
                <p className="mt-1 text-center text-xs text-[var(--muted)]">컷 {s.order + 1}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
