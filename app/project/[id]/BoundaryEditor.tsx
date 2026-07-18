"use client";

// ============================================================================
// G1 컷 경계 편집기 — 스펙 §5.3 (콘텐츠-박스 방식)
// ----------------------------------------------------------------------------
// 웹툰은 세로로 길고 좁다. 좌: 좁은 스트립(원본+컷 박스, 드래그로 경계 조정).
// 우: 넓은 가로 공간을 채우는 컷 카드 갤러리 — 각 컷 썸네일(원본에서 클립) + 중심
// (타입) 선택 + 묘사. 두 열은 각자 독립 스크롤. 사람은 카드에서 그림 보며 확정한다.
// 저장 시 regions({yStart,yEnd,xStart?,xEnd?,cut?}[])를 상위(Studio)의 onSave 로.
// ============================================================================

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SourceFile, VirtualCanvas, Scene, CutOntology, CutType, TextKind } from "@/lib/types";
import { CUT_TYPES, TEXT_KINDS, blankCut } from "@/lib/ontology";

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
  projectId: string;
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

// 타입별 색(중심 구분용). 캐릭터=파랑 계열, 맥락=초록, 사물=노랑, 액션=빨강, 텍스트=회색.
const TYPE_COLOR: Record<string, string> = {
  person: "#1e90ff",
  action: "#e0574d",
  object: "#e0a021",
  background_crowd: "#12b886",
  transition: "#a855f7",
  text: "#8a8f98",
};

const MIN_PX = 8; // 화면 픽셀 기준 최소 컷 높이
const THUMB_W = 150;
const THUMB_H = 116;

// 컷 영역을 원본에서 클립해 작은 썸네일로. 별도 추출 없이 CSS 로 잘라 보여준다.
function CutThumb({
  canvas,
  files,
  region,
  maxW = THUMB_W,
  maxH = THUMB_H,
}: {
  canvas: VirtualCanvas;
  files: SourceFile[];
  region: Region;
  maxW?: number;
  maxH?: number;
}) {
  const x0 = region.xStart ?? 0;
  const x1 = region.xEnd ?? canvas.refWidth;
  const regW = Math.max(1, x1 - x0);
  const regH = Math.max(1, region.yEnd - region.yStart);
  const scale = Math.min(maxW / regW, maxH / regH);
  const tw = Math.max(1, regW * scale);
  const th = Math.max(1, regH * scale);
  return (
    <div className="relative overflow-hidden rounded bg-black/50" style={{ width: tw, height: th }}>
      <div
        className="absolute"
        style={{
          width: canvas.refWidth * scale,
          height: canvas.totalHeight * scale,
          left: -x0 * scale,
          top: -region.yStart * scale,
        }}
      >
        {files.map((f, i) => {
          const top = canvas.offsets[i];
          const bottom = top + canvas.normHeights[i];
          if (bottom <= region.yStart || top >= region.yEnd) return null; // 이 컷과 안 겹침
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={f.id}
              src={f.url}
              alt=""
              draggable={false}
              className="absolute left-0 w-full select-none"
              style={{ top: top * scale, height: canvas.normHeights[i] * scale }}
            />
          );
        })}
      </div>
    </div>
  );
}

export default function BoundaryEditor({ sourceFiles, canvas, scenes, projectId, onSave }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [displayW, setDisplayW] = useState(220);
  const [selected, setSelected] = useState<number | null>(null);
  const [splitting, setSplitting] = useState<number | null>(null);
  const [zoom, setZoom] = useState<Region | null>(null);
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
    const measure = () => setDisplayW(el.clientWidth || 220);
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

  // 자동 저장 — 변경(타입·내용·경계) 후 잠시 뒤 자동으로 저장. 드래그 중엔 재예약돼
  // 손 뗀 900ms 뒤 한 번만 저장. 저장되면 scenes prop 갱신으로 dirty 가 풀린다.
  useEffect(() => {
    if (!dirty || saving) return;
    const t = setTimeout(() => {
      setSaving(true);
      onSave(regions.map((r) => ({ ...r }))).finally(() => setSaving(false));
    }, 900);
    return () => clearTimeout(t);
  }, [regions, dirty, saving, onSave]);

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
        else if (!cut.textKind) cut.textKind = "dialogue";
        return { ...r, cut };
      })
    );
    setDirty(true);
  }

  function setTextKind(i: number, textKind: TextKind) {
    setRegions((prev) =>
      prev.map((r, idx) =>
        idx === i ? { ...r, cut: { ...(r.cut ?? blankCut()), textKind, confirmed: true } } : r
      )
    );
    setDirty(true);
  }

  // VLM 이 읽은 컷 내용(묘사·대사 등)을 사람이 편집. 자동 저장됨.
  function setCutField(i: number, field: "description" | "dialogue" | "setting", value: string) {
    setRegions((prev) =>
      prev.map((r, idx) =>
        idx === i ? { ...r, cut: { ...(r.cut ?? blankCut()), [field]: value } } : r
      )
    );
    setDirty(true);
  }

  // 인접 컷과 합병(dir -1=앞, +1=뒤). 합쳐진 컷은 내용이 바뀌므로 미분류로(재확정).
  function mergeWith(i: number, dir: -1 | 1) {
    const j = i + dir;
    setRegions((prev) => {
      if (j < 0 || j >= prev.length) return prev;
      const a = prev[i];
      const b = prev[j];
      const merged: Region = {
        yStart: Math.min(a.yStart, b.yStart),
        yEnd: Math.max(a.yEnd, b.yEnd),
        xStart: Math.min(a.xStart ?? 0, b.xStart ?? 0),
        xEnd: Math.max(a.xEnd ?? canvas.refWidth, b.xEnd ?? canvas.refWidth),
        cut: blankCut(),
      };
      const next = prev.filter((_, idx) => idx !== i && idx !== j);
      next.push(merged);
      return next.sort((x, y) => x.yStart - y.yStart);
    });
    setDirty(true);
  }

  // 오른쪽 카드 클릭 → 왼쪽 스트립을 그 컷 위치로 스크롤.
  function scrollToCut(r: Region) {
    leftScrollRef.current?.scrollTo({ top: Math.max(0, r.yStart * scale - 40), behavior: "smooth" });
  }

  // 양방향 선택: 한쪽에서 고르면 반대쪽으로 스크롤 + 양쪽 하이라이트.
  function selectFromLeft(i: number) {
    setSelected(i);
    cardRefs.current[i]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function selectFromRight(i: number) {
    setSelected(i);
    scrollToCut(regions[i]);
  }

  // 이 컷만 즉시 분할 — 저장된 프로파일로 API 가 계산(워커·VLM·재다운로드 없음).
  async function doSplit(i: number) {
    const r = regions[i];
    setSplitting(i);
    try {
      const res = await fetch("/api/resplit-local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          region: { yStart: r.yStart, yEnd: r.yEnd, xStart: r.xStart, xEnd: r.xEnd },
        }),
      });
      const d = await res.json();
      if (!d.ok) {
        window.alert(d.error ?? "분할 실패");
        return;
      }
      // 새 서브컷은 부모 컷의 분류(타입·textKind)를 물려받는다 → 미분류로 안 남음.
      // 내용(대사·묘사 등)은 부분마다 다르므로 비우고, 타입만 상속. 다르면 사람이 조정.
      const parent = r.cut ?? blankCut();
      const subs = (d.subs ?? []).map(
        (s: { yStart: number; yEnd: number; xStart?: number; xEnd?: number }) => ({
          yStart: s.yStart,
          yEnd: s.yEnd,
          xStart: s.xStart,
          xEnd: s.xEnd,
          cut: {
            ...blankCut(),
            type: parent.type,
            textKind: parent.textKind,
            confirmed: parent.confirmed,
          },
        })
      );
      if (subs.length < 2) {
        window.alert("나눌 경계를 못 찾았어요");
        return;
      }
      setRegions((prev) =>
        prev
          .filter((_, idx) => idx !== i)
          .concat(subs)
          .sort((a, b) => a.yStart - b.yStart)
      );
      setSelected(null);
      setDirty(true);
    } catch {
      window.alert("분할 실패");
    } finally {
      setSplitting(null);
    }
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
        <span>
          왼쪽: 박스 드래그=경계 · 빈 곳 더블클릭=추가 · 오른쪽 카드에서 중심·내용 편집 (자동 저장) ·{" "}
          <span className="rounded border border-dashed border-cyan-300/80 bg-cyan-400/20 px-1">하늘색 점선</span>
=컷 밖 대사 OCR 예약(추출 때 이웃 컷 대사로 들어감)
        </span>
        <button
          onClick={save}
          disabled={saving}
          className="rounded border border-[var(--border)] px-3 py-1 disabled:opacity-40"
        >
          {saving ? "저장 중…" : dirty ? "곧 자동 저장…" : "자동 저장됨 ✓"}
        </button>
      </div>

      <div className="flex gap-3">
        {/* 왼쪽: 경계 편집 스트립 (세로 원본 + 컷 박스, 드래그로 경계 조정) */}
        <div
          ref={leftScrollRef}
          className="max-h-[80vh] shrink-0 overflow-y-auto rounded-lg border border-[var(--border)] bg-black/40"
        >
          <div
            ref={boxRef}
            onDoubleClick={addAt}
            className="relative"
            style={{ width: "clamp(140px, 18vw, 220px)", height: totalPx }}
          >
            {files.map((f, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={f.id}
                src={f.url}
                alt={`source ${f.order}`}
                draggable={false}
                className="absolute left-0 w-full select-none"
                style={{ top: canvas.offsets[i] * scale, height: canvas.normHeights[i] * scale }}
              />
            ))}

            {dims.map((d, i) => (
              <div
                key={`dim-${i}`}
                className="pointer-events-none absolute left-0 w-full bg-black/65"
                style={{ top: d.top * scale, height: d.height * scale }}
              />
            ))}

            {/* 내레이션 OCR 예약 밴드(하늘색 점선) — 컷 밖 텍스트가 '잡혀 있음'을 보이게.
                안 보이면 사용자가 유실로 오해한다(실제로는 추출 때 이웃 컷 대사로 붙음). */}
            {regions.flatMap((r, ri) =>
              (r.cut?.textRegions ?? []).map((tr, ti) => (
                <div
                  key={`band-${ri}-${ti}`}
                  className="pointer-events-none absolute border border-dashed border-cyan-300/80 bg-cyan-400/20"
                  style={{
                    top: tr.yStart * scale,
                    height: Math.max(2, (tr.yEnd - tr.yStart) * scale),
                    left: (tr.xStart ?? 0) * scale,
                    width: ((tr.xEnd ?? canvas.refWidth) - (tr.xStart ?? 0)) * scale,
                  }}
                  title="컷 밖 대사 OCR 예약 — 추출(2단계) 때 이 영역 글자를 이웃 컷 대사로 붙입니다"
                />
              ))
            )}

            {regions.map((r, i) => {
              const xs = r.xStart ?? 0;
              const xe = r.xEnd ?? canvas.refWidth;
              const color = (r.cut?.type && TYPE_COLOR[r.cut.type]) || "var(--accent)";
              return (
                <div
                  key={`reg-${i}`}
                  onClick={() => selectFromLeft(i)}
                  className="absolute cursor-pointer border-2"
                  style={{
                    top: r.yStart * scale,
                    height: (r.yEnd - r.yStart) * scale,
                    left: xs * scale,
                    width: (xe - xs) * scale,
                    borderColor: selected === i ? "#fff" : color,
                    boxShadow: selected === i ? `0 0 0 2px #fff, 0 0 10px ${color}` : `0 0 5px ${color}`,
                  }}
                >
                  <div
                    className="pointer-events-none absolute left-0 top-0 rounded-br px-1 text-[10px] font-bold text-white"
                    style={{ backgroundColor: color }}
                  >
                    {i + 1}
                  </div>
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

        {/* 오른쪽: 컷 카드 갤러리 (썸네일 + 중심 + 묘사) — 넓은 가로 공간을 채운다 */}
        <div className="max-h-[80vh] min-w-0 flex-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-2">
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(158px, 1fr))" }}
          >
            {regions.map((r, i) => {
              const cut = r.cut ?? blankCut();
              const color = (cut.type && TYPE_COLOR[cut.type]) || "var(--muted)";
              return (
                <div
                  key={`card-${i}`}
                  ref={(el) => {
                    cardRefs.current[i] = el;
                  }}
                  className="flex flex-col overflow-hidden rounded-lg border bg-[var(--panel-2)]"
                  style={{
                    borderColor: cut.type ? color : "var(--border)",
                    outline: selected === i ? "2px solid #fff" : undefined,
                    outlineOffset: "1px",
                  }}
                >
                  <div
                    className="relative flex items-center justify-center bg-black/40"
                    style={{ height: THUMB_H + 8 }}
                  >
                    <button
                      type="button"
                      onClick={() => selectFromRight(i)}
                      title="왼쪽 스트립에서 이 컷 위치로 이동"
                      className="cursor-pointer"
                    >
                      <CutThumb canvas={canvas} files={files} region={r} />
                    </button>
                    <span
                      className="pointer-events-none absolute left-1 top-1 rounded px-1 text-[10px] font-bold text-white"
                      style={{ backgroundColor: color }}
                    >
                      {i + 1}
                    </span>
                    <button
                      onClick={() => deleteRegion(i)}
                      className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-[var(--danger)] text-[9px] leading-none text-white"
                      title="이 컷 삭제"
                    >
                      ✕
                    </button>
                    {cut.type && !cut.confirmed && (
                      <span
                        className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[9px] text-white"
                        title="AI 제안(미확정)"
                      >
                        AI
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setZoom(r)}
                      title="크게 보기"
                      className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[11px] leading-none text-white hover:bg-black/80"
                    >
                      ⤢
                    </button>
                  </div>
                  <div className="flex flex-col gap-1 p-1.5">
                    <div className="flex items-center gap-1">
                      <select
                        value={cut.type ?? ""}
                        onChange={(e) => setCutType(i, e.target.value as CutType)}
                        className="min-w-0 flex-1 rounded border bg-[var(--panel)] px-1 py-0.5 text-xs font-medium"
                        style={{ borderColor: color, color: cut.type ? color : "var(--muted)" }}
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
                        <select
                          value={cut.textKind ?? "dialogue"}
                          onChange={(e) => setTextKind(i, e.target.value as TextKind)}
                          className="shrink-0 rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-0.5 text-xs"
                        >
                          {TEXT_KINDS.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.ko}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    <textarea
                      value={cut.description}
                      onChange={(e) => setCutField(i, "description", e.target.value)}
                      placeholder="그림 내용 (편집 가능)"
                      rows={2}
                      className="w-full resize-none rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-0.5 text-[11px] leading-tight text-[var(--text)]"
                    />
                    {/* 분할이 미리 읽은 대사(내레이션 포함 — 내레이션도 대사다) — '처음부터' 보이게. */}
                    {(cut.bubbles?.length ?? 0) > 0 && (
                      <div
                        className="flex flex-col gap-0.5 rounded border border-cyan-300/40 bg-cyan-400/10 px-1 py-0.5"
                        title="이 컷의 대사(내레이션 포함) — 추출(2단계) 후 대사 편집기에서 화자 지정·수정"
                      >
                        <span className="text-[9px] text-cyan-300/90">대사 {cut.bubbles!.length}줄</span>
                        {cut.bubbles!.slice(0, 3).map((b, bi) => (
                          <span key={bi} className="truncate text-[10px]" title={b.text}>
                            {b.text}
                            {(b.translation || "").trim() && (
                              <span className="italic text-cyan-200/70"> · 역: {b.translation}</span>
                            )}
                          </span>
                        ))}
                        {cut.bubbles!.length > 3 && (
                          <span className="text-[9px] text-[var(--muted)]">+{cut.bubbles!.length - 3}줄</span>
                        )}
                      </div>
                    )}
                    <input
                      value={cut.dialogue}
                      onChange={(e) => setCutField(i, "dialogue", e.target.value)}
                      placeholder="대사"
                      className="w-full rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-0.5 text-[11px] text-[var(--text)]"
                    />
                    <div className="flex items-center gap-1 text-[10px] text-[var(--muted)]">
                      <span>합병</span>
                      <button
                        type="button"
                        disabled={i === 0}
                        onClick={() => mergeWith(i, -1)}
                        className="rounded border border-[var(--border)] px-1 disabled:opacity-30"
                        title="앞 컷과 합치기"
                      >
                        ◀앞
                      </button>
                      <button
                        type="button"
                        disabled={i === regions.length - 1}
                        onClick={() => mergeWith(i, 1)}
                        className="rounded border border-[var(--border)] px-1 disabled:opacity-30"
                        title="뒤 컷과 합치기"
                      >
                        뒤▶
                      </button>
                      <button
                        type="button"
                        onClick={() => doSplit(i)}
                        disabled={splitting !== null || r.yEnd - r.yStart < 80}
                        className="ml-auto rounded border border-[var(--border)] px-1 disabled:opacity-30"
                        title="이 컷을 즉시 분할"
                      >
                        {splitting === i ? "분할…" : "분할"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <p className="mt-2 text-xs text-[var(--muted)]">
        왼쪽 스트립에서 박스 모서리 드래그로 경계 조정, 빈 곳 더블클릭으로 컷 추가. 오른쪽 카드에서 각
        컷의 <b>중심</b>을 확정하세요(재생성·자막에 사용). 썸네일의 ⤢ 로 크게 볼 수 있어요.
      </p>

      {zoom && (
        <div
          onClick={() => setZoom(null)}
          className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative rounded-lg border border-[var(--border)] bg-[var(--panel)] p-2"
          >
            <CutThumb canvas={canvas} files={files} region={zoom} maxW={720} maxH={720} />
            <button
              onClick={() => setZoom(null)}
              className="absolute right-2 top-2 rounded bg-[var(--danger)] px-2 py-0.5 text-xs text-white"
            >
              닫기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
