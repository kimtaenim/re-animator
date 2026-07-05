"use client";

// ============================================================================
// G1 컷 경계 편집기 — 스펙 §5.3 (콘텐츠-박스 방식)
// ----------------------------------------------------------------------------
// 컷 = 거터 사이 콘텐츠 구간(위·아래 거터 제외). 각 컷을 밝은 박스로, 사이 거터·
// 여백은 어둡게. 박스 위/아래 모서리 드래그=크기조절, ✕=삭제, 빈 곳 더블클릭=추가.
// 저장 시 regions({yStart,yEnd}[])를 상위(Studio)의 onSave 로 넘긴다.
// ============================================================================

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SourceFile, VirtualCanvas, Scene, CutOntology, CutType } from "@/lib/types";
import { CUT_TYPES, cutTypeKo, textKindKo, blankCut } from "@/lib/ontology";

export type SavedRegion = {
  yStart: number;
  yEnd: number;
  xStart?: number;
  xEnd?: number;
  cut?: CutOntology;
};

interface Props {
  sourceFiles: SourceFile[];
  canvas: VirtualCanvas;
  scenes: Scene[];
  onSave: (regions: SavedRegion[]) => Promise<void>;
}

type Region = SavedRegion;

// scenes → 정렬된 region 배열(좌우 크롭 + 컷 온톨로지 포함).
function scenesToRegions(scenes: Scene[]): Region[] {
  return [...scenes]
    .sort((a, b) => a.order - b.order)
    .map((s) => ({
      yStart: s.sourceRegion.yStart,
      yEnd: s.sourceRegion.yEnd,
      xStart: s.sourceRegion.xStart,
      xEnd: s.sourceRegion.xEnd,
      cut: s.cut ?? blankCut(),
    }));
}

// 타입별 색(중심 구분용). 캐릭터=액센트 계열, 맥락=중립, 텍스트=경고.
const TYPE_COLOR: Record<string, string> = {
  lead: "#1e90ff",
  reaction: "#3aa0ff",
  characters: "#5bb0ff",
  crowd_space: "#12b886",
  object: "#e0a021",
  action: "#e0574d",
  text: "#8a8f98",
};

const MIN_PX = 8; // 화면 픽셀 기준 최소 컷 높이

export default function BoundaryEditor({ sourceFiles, canvas, scenes, onSave }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [displayW, setDisplayW] = useState(360);
  // regions 는 항상 yStart 오름차순 유지(렌더 인덱스=드래그 인덱스 일치).
  const [regions, setRegions] = useState<Region[]>(() => scenesToRegions(scenes));
  const [drag, setDrag] = useState<{ index: number; edge: "top" | "bottom" } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // scenes prop 갱신 시(저장 후 서버 반영) 재동기화 — 렌더 중 조정 패턴.
  const [lastScenes, setLastScenes] = useState(scenes);
  if (scenes !== lastScenes) {
    setLastScenes(scenes);
    setRegions(scenesToRegions(scenes));
    setDirty(false);
  }

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
  const minH = MIN_PX / scale;
  const files = [...sourceFiles].sort((a, b) => a.order - b.order);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const el = boxRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const y = Math.round((e.clientY - rect.top) / scale);
      setRegions((prev) => {
        const next = prev.map((r) => ({ ...r }));
        const r = next[drag.index];
        if (!r) return prev;
        if (drag.edge === "top") {
          const lo = drag.index > 0 ? next[drag.index - 1].yEnd : 0;
          r.yStart = Math.max(lo, Math.min(r.yEnd - minH, y));
        } else {
          const hi =
            drag.index < next.length - 1 ? next[drag.index + 1].yStart : canvas.totalHeight;
          r.yEnd = Math.min(hi, Math.max(r.yStart + minH, y));
        }
        return next;
      });
      setDirty(true);
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, scale, minH, canvas.totalHeight]);

  function deleteRegion(i: number) {
    setRegions((prev) => prev.filter((_, idx) => idx !== i));
    setDirty(true);
  }

  // 빈 곳(거터·여백) 더블클릭 → 그 틈을 채우는 새 컷 추가.
  function addAt(e: React.MouseEvent) {
    const el = boxRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const y = Math.round((e.clientY - rect.top) / scale);
    if (regions.some((r) => y >= r.yStart && y < r.yEnd)) return; // 이미 컷 안
    let lo = 0;
    let hi = canvas.totalHeight;
    for (const r of regions) {
      if (r.yEnd <= y) lo = r.yEnd;
      if (r.yStart > y) {
        hi = r.yStart;
        break;
      }
    }
    if (hi - lo < minH) return;
    setRegions((prev) =>
      [...prev, { yStart: lo, yEnd: hi, cut: blankCut() }].sort((a, b) => a.yStart - b.yStart)
    );
    setDirty(true);
  }

  // 컷 타입(중심) 확정 — 사람이 드롭다운으로 선택. confirmed=true 로 표시.
  function setCutType(i: number, type: CutType) {
    setRegions((prev) =>
      prev.map((r, idx) => {
        if (idx !== i) return r;
        const cut = { ...(r.cut ?? blankCut()), type, confirmed: true };
        if (type !== "text") cut.textKind = null;
        return { ...r, cut };
      })
    );
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(regions.map((r) => ({ ...r })));
    } finally {
      setSaving(false);
    }
  }

  // 컷 밖(거터·여백) = 어둡게. 정렬된 region 사이 계산.
  const dims: { top: number; height: number }[] = [];
  let cur = 0;
  for (const r of regions) {
    if (r.yStart > cur) dims.push({ top: cur, height: r.yStart - cur });
    cur = Math.max(cur, r.yEnd);
  }
  if (cur < canvas.totalHeight) dims.push({ top: cur, height: canvas.totalHeight - cur });

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-[var(--muted)]">
        <span>박스 위·아래 모서리 드래그=크기 · ✕=삭제 · 빈 곳 더블클릭=컷 추가</span>
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="rounded bg-[var(--accent)] px-3 py-1 text-white disabled:opacity-40"
        >
          {saving ? "저장 중…" : dirty ? `경계 저장 (${regions.length}컷)` : "저장됨"}
        </button>
      </div>

      <div className="max-h-[70vh] overflow-y-auto rounded-lg border border-[var(--border)] bg-black/40">
        <div
          ref={boxRef}
          onDoubleClick={addAt}
          className="relative mx-auto"
          style={{ width: "100%", maxWidth: 420, height: totalPx }}
        >
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

          {/* 컷 밖(거터·여백) 어둡게 */}
          {dims.map((d, i) => (
            <div
              key={`dim-${i}`}
              className="pointer-events-none absolute left-0 w-full bg-black/65"
              style={{ top: d.top * scale, height: d.height * scale }}
            />
          ))}

          {/* 컷 박스 */}
          {regions.map((r, i) => {
            const xs = r.xStart ?? 0;
            const xe = r.xEnd ?? canvas.refWidth;
            const color = (r.cut?.type && TYPE_COLOR[r.cut.type]) || "var(--accent)";
            return (
            <div
              key={`reg-${i}`}
              className="absolute border-2"
              style={{
                top: r.yStart * scale,
                height: (r.yEnd - r.yStart) * scale,
                left: xs * scale,
                width: (xe - xs) * scale,
                borderColor: color,
                boxShadow: `0 0 8px ${color}, 0 0 3px ${color}`,
              }}
            >
              <div
                className="pointer-events-none absolute left-0.5 top-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
                style={{ backgroundColor: color }}
              >
                {i + 1} · {cutTypeKo(r.cut?.type)}
              </div>
              <button
                onClick={() => deleteRegion(i)}
                className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-[var(--danger)] text-[9px] leading-none text-white"
                title="이 컷 삭제"
              >
                ✕
              </button>
              <div
                onPointerDown={(e) => {
                  e.preventDefault();
                  setDrag({ index: i, edge: "top" });
                }}
                className="absolute left-0 top-[-3px] h-1.5 w-full cursor-ns-resize"
              />
              <div
                onPointerDown={(e) => {
                  e.preventDefault();
                  setDrag({ index: i, edge: "bottom" });
                }}
                className="absolute bottom-[-3px] left-0 h-1.5 w-full cursor-ns-resize"
              />
            </div>
            );
          })}
        </div>
      </div>

      <p className="mt-2 text-xs text-[var(--muted)]">
        밝은 박스 = 컷(패널 내용만). 어두운 띠 = 컷 사이 거터·여백(제외됨). 배경이 이어져 자동
        분할이 놓친 곳은 빈 곳을 더블클릭해 컷을 추가하세요.
      </p>

      {/* 컷 중심(타입) 확정 — 사람이 각 컷의 중심을 고른다. 나중에 image-2 재생성에 쓰임. */}
      <div className="mt-4">
        <h3 className="mb-2 text-sm font-semibold">
          컷 중심 확정{" "}
          <span className="font-normal text-[var(--muted)]">
            — 각 컷이 무엇 중심인지 (재생성·자막에 사용)
          </span>
        </h3>
        <div className="max-h-[40vh] space-y-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-2">
          {regions.map((r, i) => {
            const cut = r.cut ?? blankCut();
            const color = (cut.type && TYPE_COLOR[cut.type]) || "var(--muted)";
            const brief =
              [
                cut.characters?.length ? `인물: ${cut.characters.join(", ")}` : "",
                cut.setting ? `장소: ${cut.setting}` : "",
                cut.dialogue ? `“${cut.dialogue}”` : "",
                cut.sfx ? `효과음: ${cut.sfx}` : "",
              ]
                .filter(Boolean)
                .join(" · ") || "내용 미검출";
            return (
              <div
                key={`row-${i}`}
                className="flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs"
              >
                <span
                  className="grid h-5 w-6 shrink-0 place-items-center rounded text-[10px] font-bold text-white"
                  style={{ backgroundColor: color }}
                >
                  {i + 1}
                </span>
                <select
                  value={cut.type ?? ""}
                  onChange={(e) => setCutType(i, e.target.value as CutType)}
                  className="shrink-0 rounded border border-[var(--border)] bg-[var(--panel)] px-1.5 py-1 text-xs"
                >
                  <option value="" disabled>
                    미분류
                  </option>
                  {CUT_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.ko}
                    </option>
                  ))}
                </select>
                {cut.type === "text" && (
                  <span className="shrink-0 text-[var(--muted)]">{textKindKo(cut.textKind) || "말풍선?"}</span>
                )}
                <span className="truncate text-[var(--muted)]" title={brief}>
                  {brief}
                </span>
                {!cut.confirmed && cut.type && (
                  <span className="ml-auto shrink-0 rounded bg-[var(--panel)] px-1 text-[10px] text-[var(--muted)]">
                    AI
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
