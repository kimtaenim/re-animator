"use client";

// ============================================================================
// M2 캐스팅 검수(G0) — VLM 이 묶은 등장인물을 사람이 확정.
// ----------------------------------------------------------------------------
// 캐릭터별로 대표 이미지 + 소속 컷 썸네일. 각 컷을 다른 캐릭터로 재배정하거나
// 새 캐릭터로 분리, 제외 가능. 대표 컷 지정, 라벨 편집. 확정 시 부모(Studio)로 저장.
// 같은 인물=같은 엔티티 → 이후 image-2 재생성에 같은 레퍼런스로 얼굴 일관성.
// ============================================================================

import { useState, type DragEvent } from "react";
import type { Character, Scene } from "@/lib/types";

const CHARACTER_TYPES = new Set(["person"]);

interface Props {
  scenes: Scene[];
  cast: Character[];
  onSave: (
    cast: Character[],
    speakers: Record<string, string>,
    approve: boolean
  ) => Promise<void>;
}

function hasDialogue(s: Scene): boolean {
  const c = s.cut;
  return !!c && (!!c.dialogue?.trim() || (c.type === "text" && c.textKind === "dialogue"));
}
function initSpeakers(scenes: Scene[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const s of scenes) if (hasDialogue(s)) m[s.id] = s.cut?.speakerId ?? "";
  return m;
}

// 자동 라벨(캐릭터 N)만 순서대로 다시 매김 — 사람이 바꾼 이름은 보존.
function relabel(list: Character[]): Character[] {
  return list
    .filter((c) => c.sceneIds.length > 0)
    .map((c, i) => ({
      ...c,
      label: /^캐릭터 \d+$/.test(c.label) ? `캐릭터 ${i + 1}` : c.label,
      refSceneId: c.refSceneId && c.sceneIds.includes(c.refSceneId) ? c.refSceneId : c.sceneIds[0],
    }));
}

export default function CastReview({ scenes, cast: initial, onSave }: Props) {
  const [cast, setCast] = useState<Character[]>(initial);
  const [saving, setSaving] = useState<null | "save" | "approve">(null);

  // prop 갱신(재캐스팅/저장 후) 재동기화 — 렌더 중 조정 패턴.
  const [last, setLast] = useState(initial);
  if (initial !== last) {
    setLast(initial);
    setCast(initial);
  }

  const [speakers, setSpeakers] = useState<Record<string, string>>(() => initSpeakers(scenes));
  const [lastScenes, setLastScenes] = useState(scenes);
  if (scenes !== lastScenes) {
    setLastScenes(scenes);
    setSpeakers(initSpeakers(scenes));
  }
  const dialogueScenes = scenes.filter(hasDialogue);
  const setSpeaker = (sceneId: string, charId: string) =>
    setSpeakers((prev) => ({ ...prev, [sceneId]: charId }));

  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const assigned = new Set(cast.flatMap((c) => c.sceneIds));
  const unassigned = scenes.filter(
    (s) => s.cut?.type && CHARACTER_TYPES.has(s.cut.type) && !assigned.has(s.id)
  );

  function moveScene(sceneId: string, to: string) {
    setCast((prev) => {
      let next = prev.map((c) => ({ ...c, sceneIds: c.sceneIds.filter((id) => id !== sceneId) }));
      if (to === "new") {
        // 새 캐릭터 설명을 그 컷의 인물 서술로 자동 시드 → '외모 미상'으로 비지 않게.
        const src = sceneById.get(sceneId);
        const seeded =
          (src?.cut?.characters?.filter(Boolean).join(", ") || "").trim() ||
          (src?.cut?.description || "").trim().slice(0, 40);
        next.push({
          id: `char-new-${sceneId}`,
          label: `캐릭터 ${next.length + 1}`,
          description: seeded,
          refSceneId: sceneId,
          sceneIds: [sceneId],
        });
      } else if (to !== "none") {
        next = next.map((c) => (c.id === to ? { ...c, sceneIds: [...c.sceneIds, sceneId] } : c));
      }
      return relabel(next);
    });
  }

  function rename(charId: string, label: string) {
    setCast((prev) => prev.map((c) => (c.id === charId ? { ...c, label } : c)));
  }
  function setDescription(charId: string, description: string) {
    setCast((prev) => prev.map((c) => (c.id === charId ? { ...c, description } : c)));
  }
  function setRef(charId: string, sceneId: string) {
    setCast((prev) => prev.map((c) => (c.id === charId ? { ...c, refSceneId: sceneId } : c)));
  }

  async function doSave(approve: boolean) {
    setSaving(approve ? "approve" : "save");
    try {
      await onSave(cast, speakers, approve);
    } finally {
      setSaving(null);
    }
  }

  // 드롭다운·라벨에 붙일 외모 힌트 — "캐릭터 N" 만으론 누군지 몰라서 특징 앞부분을 덧붙인다.
  const hintOf = (c: Character) => (c.description || "").trim().replace(/\s+/g, " ").slice(0, 16);
  const optLabel = (c: Character) => {
    const h = hintOf(c);
    return h ? `${c.label} · ${h}` : c.label;
  };
  const repScene = (c: Character) => c.refSceneId ?? c.sceneIds[0];

  // ── 드래그앤드롭 — 썸네일을 캐릭터 카드/드롭존으로 끌어 이동. 드롭다운은 폴백으로 유지. ──
  const [overTarget, setOverTarget] = useState<string | null>(null);
  const dragProps = (sid: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData("text/plain", sid);
      e.dataTransfer.effectAllowed = "move";
    },
  });
  const dropProps = (target: string) => ({
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (overTarget !== target) setOverTarget(target);
    },
    onDragLeave: () => setOverTarget((t) => (t === target ? null : t)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/plain");
      if (id) moveScene(id, target);
      setOverTarget(null);
    },
  });

  const moveOptions = (excludeId?: string) => [
    ...cast.filter((c) => c.id !== excludeId).map((c) => ({ v: c.id, t: `→ ${optLabel(c)}` })),
    { v: "new", t: "→ 새 캐릭터" },
    { v: "none", t: "제외" },
  ];

  function Thumb({ sceneId, cls = "h-16 w-16" }: { sceneId: string; cls?: string }) {
    const s = sceneById.get(sceneId);
    if (!s?.originalImage) {
      return <div className={`grid ${cls} place-items-center rounded bg-black/40 text-[9px] text-[var(--muted)]`}>?</div>;
    }
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={s.originalImage} alt="" className={`${cls} rounded object-cover`} />;
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          G0 · 캐스팅 검수{" "}
          <span className="font-normal text-[var(--muted)]">({cast.length}명)</span>
        </h2>
        <div className="flex gap-2">
          <button
            onClick={() => doSave(false)}
            disabled={saving !== null}
            className="rounded border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-40"
          >
            {saving === "save" ? "저장 중…" : "저장"}
          </button>
          <button
            onClick={() => doSave(true)}
            disabled={saving !== null}
            className="rounded bg-[var(--ok)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {saving === "approve" ? "확정 중…" : "캐스팅 확정"}
          </button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
        <span>썸네일을 캐릭터 카드로 끌어다 놓으면 이동돼요 →</span>
        <div
          {...dropProps("new")}
          className="rounded border border-dashed px-3 py-1.5"
          style={{
            borderColor: overTarget === "new" ? "var(--accent)" : "var(--border)",
            color: overTarget === "new" ? "var(--accent)" : undefined,
          }}
        >
          ＋ 새 캐릭터로
        </div>
        <div
          {...dropProps("none")}
          className="rounded border border-dashed px-3 py-1.5"
          style={{
            borderColor: overTarget === "none" ? "var(--danger)" : "var(--border)",
            color: overTarget === "none" ? "var(--danger)" : undefined,
          }}
        >
          ✕ 제외
        </div>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {cast.map((c) => (
          <div
            key={c.id}
            {...dropProps(c.id)}
            className="rounded-lg border bg-[var(--panel)] p-3 transition-colors"
            style={{
              borderColor: overTarget === c.id ? "var(--accent)" : "var(--border)",
              boxShadow: overTarget === c.id ? "0 0 0 2px var(--accent) inset" : undefined,
            }}
          >
            <div className="mb-2 flex items-center gap-3">
              <Thumb sceneId={repScene(c)} cls="h-14 w-14 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <input
                  value={c.label}
                  onChange={(e) => rename(c.id, e.target.value)}
                  className="w-full rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-sm font-semibold"
                />
                <input
                  value={c.description ?? ""}
                  onChange={(e) => setDescription(c.id, e.target.value)}
                  placeholder="외모·특징 (예: 빨간머리 여자, 검은 정장)"
                  className="w-full rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-xs text-[var(--muted)]"
                />
              </div>
              <span className="ml-auto shrink-0 text-xs text-[var(--muted)]">{c.sceneIds.length}컷</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {c.sceneIds.map((sid) => {
                const isRef = c.refSceneId === sid;
                return (
                  <div
                    key={sid}
                    {...dragProps(sid)}
                    className="flex cursor-move flex-col items-center gap-0.5 rounded border p-1"
                    style={{ borderColor: isRef ? "var(--accent)" : "var(--border)" }}
                    title="드래그해서 다른 캐릭터로 이동"
                  >
                    <Thumb sceneId={sid} />
                    <button
                      onClick={() => setRef(c.id, sid)}
                      className="text-[9px]"
                      style={{ color: isRef ? "var(--accent)" : "var(--muted)" }}
                      title="대표 이미지로 지정(레퍼런스)"
                    >
                      {isRef ? "★ 대표" : "대표로"}
                    </button>
                    <select
                      value=""
                      onChange={(e) => e.target.value && moveScene(sid, e.target.value)}
                      className="w-16 rounded border border-[var(--border)] bg-[var(--panel-2)] text-[9px]"
                    >
                      <option value="">이동…</option>
                      {moveOptions(c.id).map((o) => (
                        <option key={o.v} value={o.v}>
                          {o.t}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        </div>

        {unassigned.length > 0 && (
          <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--panel)] p-3">
            <h3 className="mb-2 text-sm font-semibold text-[var(--muted)]">
              미배정 인물 컷 {unassigned.length}개{" "}
              <span className="font-normal">— 어느 캐릭터인지 지정하세요</span>
            </h3>
            <div className="flex flex-wrap gap-2">
              {unassigned.map((s) => (
                <div
                  key={s.id}
                  {...dragProps(s.id)}
                  className="flex cursor-move flex-col items-center gap-0.5 rounded border border-[var(--border)] p-1"
                  title="드래그해서 캐릭터로 배정"
                >
                  <Thumb sceneId={s.id} />
                  <select
                    value=""
                    onChange={(e) => e.target.value && moveScene(s.id, e.target.value)}
                    className="w-16 rounded border border-[var(--border)] bg-[var(--panel-2)] text-[9px]"
                  >
                    <option value="">배정…</option>
                    {moveOptions().map((o) => (
                      <option key={o.v} value={o.v}>
                        {o.t}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}

        {cast.length === 0 && unassigned.length === 0 && (
          <p className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 text-sm text-[var(--muted)]">
            인물(중심인물·반응인물·인물들) 타입 컷이 없습니다. 1단계 컷 카드에서 인물이 나온
            컷의 타입을 인물로 지정한 뒤 다시 캐스팅하거나, 개인 인물이 crowd_space·사물로
            잘못 분류됐는지 확인하세요.
          </p>
        )}
      </div>

      {/* 대사 · 화자 — 각 대사를 어느 캐릭터가 말하는지(더빙 목소리 매핑) */}
      {dialogueScenes.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold">
            대사 · 화자{" "}
            <span className="font-normal text-[var(--muted)]">— 누가 말하는지 (더빙용)</span>
          </h3>
          <div className="max-h-[40vh] space-y-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-2">
            {dialogueScenes.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs"
              >
                <span className="shrink-0 text-[var(--muted)]">컷 {s.order + 1}</span>
                {(() => {
                  const sc = cast.find((c) => c.id === speakers[s.id]);
                  return sc ? <Thumb sceneId={repScene(sc)} cls="h-6 w-6 shrink-0" /> : null;
                })()}
                <select
                  value={speakers[s.id] ?? ""}
                  onChange={(e) => setSpeaker(s.id, e.target.value)}
                  className="shrink-0 rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-0.5"
                >
                  <option value="">나레이션/미상</option>
                  {cast.map((c) => (
                    <option key={c.id} value={c.id}>
                      {optLabel(c)}
                    </option>
                  ))}
                </select>
                <span className="truncate" title={s.cut?.dialogue}>
                  “{s.cut?.dialogue}”
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
