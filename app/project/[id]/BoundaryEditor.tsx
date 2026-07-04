"use client";

// ============================================================================
// G1 경계 편집기 — 스펙 §5.3
// ----------------------------------------------------------------------------
// 가상 캔버스를 축소 렌더(소스 파일 썸네일을 offsets 대로 세로로 쌓음)하고 경계선을
// 오버레이한다. 경계선 드래그=이동, ✕=삭제, 빈 곳 더블클릭=추가. 저장 시 regions 로
// 변환해 상위(Studio)의 onSave 로 넘긴다. 실제 컷 이미지 추출은 확정(워커)에서.
// ============================================================================

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SourceFile, VirtualCanvas, Scene } from "@/lib/types";

interface Props {
  sourceFiles: SourceFile[];
  canvas: VirtualCanvas;
  scenes: Scene[];
  onSave: (regions: { yStart: number; yEnd: number }[]) => Promise<void>;
}

// scenes(regions) → 정렬된 cut 점 배열 [top, ...interior, bottom].
function scenesToCuts(scenes: Scene[]): number[] {
  const sorted = [...scenes].sort((a, b) => a.order - b.order);
  if (sorted.length === 0) return [0, 0];
  const cuts = [sorted[0].sourceRegion.yStart];
  for (const s of sorted) cuts.push(s.sourceRegion.yEnd);
  return cuts;
}

function cutsToRegions(cuts: number[]) {
  const out: { yStart: number; yEnd: number }[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    if (cuts[i + 1] - cuts[i] >= 1) out.push({ yStart: cuts[i], yEnd: cuts[i + 1] });
  }
  return out;
}

const MIN_SEP = 8; // 화면 픽셀 기준 최소 경계 간격(겹침 방지)

export default function BoundaryEditor({ sourceFiles, canvas, scenes, onSave }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [displayW, setDisplayW] = useState(360);
  const [cuts, setCuts] = useState<number[]>(() => scenesToCuts(scenes));
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // scenes prop 이 바뀌면(저장 후 서버 반영) 로컬 편집 상태를 재동기화.
  // effect 안 setState 대신 React 권장 "렌더 중 조정" 패턴 → 여분 리렌더·경고 없음.
  const [lastScenes, setLastScenes] = useState(scenes);
  if (scenes !== lastScenes) {
    setLastScenes(scenes);
    setCuts(scenesToCuts(scenes));
    setDirty(false);
  }

  // 표시 폭 측정 → scale.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setDisplayW(el.clientWidth || 360);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = displayW / canvas.refWidth;
  const totalPx = canvas.totalHeight * scale;
  const files = [...sourceFiles].sort((a, b) => a.order - b.order);

  // ── 드래그 ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (dragIdx === null) return;
    const onMove = (e: PointerEvent) => {
      const el = boxRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const y = (e.clientY - rect.top) / scale;
      setCuts((prev) => {
        const next = [...prev];
        const loBound = dragIdx > 0 ? next[dragIdx - 1] + MIN_SEP / scale : 0;
        const hiBound =
          dragIdx < next.length - 1
            ? next[dragIdx + 1] - MIN_SEP / scale
            : canvas.totalHeight;
        next[dragIdx] = Math.max(loBound, Math.min(hiBound, Math.round(y)));
        return next;
      });
      setDirty(true);
    };
    const onUp = () => setDragIdx(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragIdx, scale, canvas.totalHeight]);

  function deleteCut(i: number) {
    // 첫/마지막(콘텐츠 상·하단)은 삭제 불가 — 내부 경계만.
    if (i <= 0 || i >= cuts.length - 1) return;
    setCuts((prev) => prev.filter((_, idx) => idx !== i));
    setDirty(true);
  }

  function addCut(e: React.MouseEvent) {
    const el = boxRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const y = Math.round((e.clientY - rect.top) / scale);
    // 콘텐츠 범위 안 + 기존 경계와 너무 가깝지 않을 때만.
    const top = cuts[0];
    const bottom = cuts[cuts.length - 1];
    if (y <= top + MIN_SEP / scale || y >= bottom - MIN_SEP / scale) return;
    if (cuts.some((c) => Math.abs(c - y) < MIN_SEP / scale)) return;
    setCuts((prev) => [...prev, y].sort((a, b) => a - b));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(cutsToRegions(cuts));
    } finally {
      setSaving(false);
    }
  }

  const regionCount = Math.max(0, cuts.length - 1);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-[var(--muted)]">
        <span>드래그=이동 · ✕=삭제 · 빈 곳 더블클릭=추가</span>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="rounded bg-[var(--accent)] px-3 py-1 text-[var(--text)] disabled:opacity-40"
        >
          {saving ? "저장 중…" : dirty ? `경계 저장 (${regionCount}컷)` : "저장됨"}
        </button>
      </div>

      <div className="max-h-[70vh] overflow-y-auto rounded-lg border border-[var(--border)] bg-black/40">
        <div
          ref={boxRef}
          onDoubleClick={addCut}
          className="relative mx-auto"
          style={{ width: "100%", maxWidth: 420, height: totalPx }}
        >
          {/* 소스 파일 스택 (offsets 대로 배치) */}
          {files.map((f, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={f.id}
              src={f.url}
              alt={`source ${f.order}`}
              draggable={false}
              className="absolute left-0 w-full select-none"
              style={{
                top: canvas.offsets[i] * scale,
                height: canvas.normHeights[i] * scale,
              }}
            />
          ))}

          {/* 콘텐츠 바깥(상·하단 여백) 음영 */}
          <div
            className="pointer-events-none absolute left-0 w-full bg-black/60"
            style={{ top: 0, height: cuts[0] * scale }}
          />
          <div
            className="pointer-events-none absolute left-0 w-full bg-black/60"
            style={{
              top: cuts[cuts.length - 1] * scale,
              height: Math.max(0, totalPx - cuts[cuts.length - 1] * scale),
            }}
          />

          {/* 컷 번호 배지 (각 구간 시작에) */}
          {cutsToRegions(cuts).map((r, i) => (
            <div
              key={`lbl-${i}`}
              className="pointer-events-none absolute left-1 rounded bg-[var(--accent)]/80 px-1.5 py-0.5 text-[10px] font-semibold"
              style={{ top: r.yStart * scale + 2 }}
            >
              {i + 1}
            </div>
          ))}

          {/* 경계선 */}
          {cuts.map((c, i) => {
            const isEdge = i === 0 || i === cuts.length - 1;
            return (
              <div
                key={`cut-${i}`}
                className="group absolute left-0 w-full"
                style={{ top: c * scale - 6, height: 12 }}
              >
                <div
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setDragIdx(i);
                  }}
                  className={`absolute left-0 top-[5px] h-0.5 w-full cursor-ns-resize ${
                    isEdge ? "bg-[var(--ok)]" : "bg-[var(--danger)]"
                  }`}
                />
                {!isEdge && (
                  <button
                    onClick={() => deleteCut(i)}
                    className="absolute right-1 top-0 grid h-3 w-3 place-items-center rounded-full bg-[var(--danger)] text-[8px] leading-none text-white"
                    title="이 경계 삭제(두 컷 병합)"
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-2 text-xs text-[var(--muted)]">
        초록선 = 콘텐츠 상·하단(이동만) · 빨간선 = 컷 경계(이동·삭제). 배경 유사·여백 없는
        연출은 자동 분할이 놓칠 수 있으니 여기서 손봅니다.
      </p>
    </div>
  );
}
