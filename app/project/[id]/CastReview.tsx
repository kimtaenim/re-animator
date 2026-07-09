"use client";

// ============================================================================
// M2 캐스팅 검수(G0) — VLM 이 묶은 등장인물을 사람이 확정.
// ----------------------------------------------------------------------------
// 캐릭터별로 대표 이미지 + 소속 컷 썸네일. 각 컷을 다른 캐릭터로 재배정하거나
// 새 캐릭터로 분리, 제외 가능. 대표 컷 지정, 라벨 편집. 확정 시 부모(Studio)로 저장.
// 같은 인물=같은 엔티티 → 이후 image-2 재생성에 같은 레퍼런스로 얼굴 일관성.
// ============================================================================

import { useState, useEffect, type DragEvent } from "react";
import type { Character, Scene } from "@/lib/types";

// 캐스팅 대상 = 인물이 담긴 컷. person(정지·반응) + action(동작 중 인물) 모두 포함.
const CHARACTER_TYPES = new Set(["person", "action"]);

type VoiceOpt = { id: string; name: string; language?: string; provider?: string; gender?: string; note?: string };

// 실사 초상 인종/유형 칩 — [프롬프트용 영문, 표시 라벨]. 판타지(엘프·로봇)도 포함.
const ETHNICITIES: [string, string][] = [
  ["East Asian", "황인"],
  ["White / Caucasian", "백인"],
  ["Black", "흑인"],
  ["an elf with pointed ears (fantasy)", "엘프"],
  ["a robot / android (mechanical, sci-fi)", "로봇"],
];

interface Props {
  scenes: Scene[];
  cast: Character[];
  onSave: (
    cast: Character[],
    speakers: Record<string, string>,
    bubbleSpeakers: Record<string, string>,
    narrationSpeakers: Record<string, string>,
    approve: boolean
  ) => Promise<void>;
  onDesignPortrait: (charId: string, prompt?: string) => void;
  portraitPending: Map<string, string>;
  onZoom: (src: string) => void;
}

// 컷의 대사 단위 목록 — bubbles 있으면 풍선별(idx≥0), 없으면 레거시 통대사(idx=-1).
function bubblesOf(s: Scene): { idx: number; text: string }[] {
  const bs = s.cut?.bubbles;
  if (bs && bs.length) {
    return bs.map((b, i) => ({ idx: i, text: b.text ?? "" })).filter((b) => b.text.trim() !== "");
  }
  const legacy = s.cut?.dialogue?.trim();
  return legacy ? [{ idx: -1, text: legacy }] : [];
}
const narrationOf = (s: Scene) => (s.cut?.narration ?? "").trim();
// 이 컷에 화자를 붙일 게 하나라도 있나(대사 or 나레이션).
const hasSpeakable = (s: Scene) => bubblesOf(s).length > 0 || narrationOf(s) !== "";
// 화자 맵 키: `${sceneId}#${idx}`(idx=-1 레거시), `${sceneId}#nar`(나레이션). 초기값=기존 화자.
function initSpeakerMap(scenes: Scene[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const s of scenes) {
    const bs = s.cut?.bubbles;
    if (bs && bs.length) {
      bs.forEach((b, i) => {
        if (b.text?.trim()) m[`${s.id}#${i}`] = b.speakerId ?? "";
      });
    } else if (s.cut?.dialogue?.trim()) {
      m[`${s.id}#-1`] = s.cut.speakerId ?? "";
    }
    if (narrationOf(s) !== "") m[`${s.id}#nar`] = s.cut?.narrationSpeakerId ?? "";
  }
  return m;
}
// 저장용 분리: #nar→narrationSpeakers, idx=-1→speakers, idx≥0→bubbleSpeakers.
function splitSpeakerMap(map: Record<string, string>) {
  const speakers: Record<string, string> = {};
  const bubbleSpeakers: Record<string, string> = {};
  const narrationSpeakers: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    const hash = k.lastIndexOf("#");
    const sid = k.slice(0, hash);
    const suffix = k.slice(hash + 1);
    if (suffix === "nar") narrationSpeakers[sid] = v;
    else if (Number(suffix) === -1) speakers[sid] = v;
    else bubbleSpeakers[k] = v;
  }
  return { speakers, bubbleSpeakers, narrationSpeakers };
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

export default function CastReview({
  scenes,
  cast: initial,
  onSave,
  onDesignPortrait,
  portraitPending,
  onZoom,
}: Props) {
  const [cast, setCast] = useState<Character[]>(initial);
  const [saving, setSaving] = useState<null | "save" | "approve">(null);

  // prop 갱신(재캐스팅/저장 후) 재동기화 — 렌더 중 조정 패턴.
  const [last, setLast] = useState(initial);
  if (initial !== last) {
    setLast(initial);
    setCast(initial);
  }

  const [speakerMap, setSpeakerMap] = useState<Record<string, string>>(() => initSpeakerMap(scenes));
  const [lastScenes, setLastScenes] = useState(scenes);
  if (scenes !== lastScenes) {
    setLastScenes(scenes);
    setSpeakerMap(initSpeakerMap(scenes));
  }
  const dialogueScenes = scenes.filter(hasSpeakable);

  // 목소리 목록(Typecast) — 캐릭터별 더빙 목소리 선택용. 키 없으면 빈 목록(수동 입력 폴백).
  const [voices, setVoices] = useState<VoiceOpt[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/api/voices", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (alive && d.ok) setVoices(d.voices ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // ── 자동 저장(중간중간) — 변경 표시(dirty) 후 1.2s 디바운스로 저장(approve=false).
  // 확정은 버튼으로. ref 대신 state+effect 라 render 중 ref 접근 없음.
  const [dirty, setDirty] = useState(false);
  const [autoSavedAt, setAutoSavedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      const { speakers, bubbleSpeakers, narrationSpeakers } = splitSpeakerMap(speakerMap);
      onSave(cast, speakers, bubbleSpeakers, narrationSpeakers, false)
        .then(() => setAutoSavedAt(Date.now()))
        .catch(() => {});
      setDirty(false);
    }, 1200);
    return () => clearTimeout(t);
  }, [dirty, cast, speakerMap, onSave]);
  const scheduleSave = () => setDirty(true);

  const setSpeaker = (key: string, charId: string) => {
    setSpeakerMap((prev) => ({ ...prev, [key]: charId }));
    scheduleSave();
  };
  const setVoice = (charId: string, voice: string, voiceName: string, provider: string) => {
    setCast((prev) =>
      prev.map((c) =>
        c.id === charId
          ? {
              ...c,
              voice: voice || undefined,
              voiceName: voiceName || undefined,
              voiceProvider: voice ? provider || undefined : undefined,
            }
          : c
      )
    );
    scheduleSave();
  };

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
    scheduleSave();
  }

  function rename(charId: string, label: string) {
    setCast((prev) => prev.map((c) => (c.id === charId ? { ...c, label } : c)));
  }
  function setDescription(charId: string, description: string) {
    setCast((prev) => prev.map((c) => (c.id === charId ? { ...c, description } : c)));
  }
  function setRealPrompt(charId: string, realPrompt: string) {
    setCast((prev) => prev.map((c) => (c.id === charId ? { ...c, realPrompt } : c)));
  }
  function setRealEthnicity(charId: string, realEthnicity: string) {
    setCast((prev) => prev.map((c) => (c.id === charId ? { ...c, realEthnicity } : c)));
    scheduleSave();
  }
  // 실사화에 넘길 지시 = 인종 + 자유 지시 조합.
  const buildRealInstr = (c: Character) =>
    [c.realEthnicity ? `The person is ${c.realEthnicity}.` : "", c.realPrompt || ""]
      .filter(Boolean)
      .join(" ")
      .trim();
  function setRef(charId: string, sceneId: string) {
    setCast((prev) => prev.map((c) => (c.id === charId ? { ...c, refSceneId: sceneId } : c)));
    scheduleSave();
  }

  async function doSave(approve: boolean) {
    setSaving(approve ? "approve" : "save");
    try {
      const { speakers, bubbleSpeakers, narrationSpeakers } = splitSpeakerMap(speakerMap);
      await onSave(cast, speakers, bubbleSpeakers, narrationSpeakers, approve);
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
        <div className="flex items-center gap-2">
          {autoSavedAt && <span className="text-xs text-[var(--muted)]">자동 저장됨 ✓</span>}
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
                  onBlur={scheduleSave}
                  className="w-full rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-sm font-semibold"
                />
                <input
                  value={c.description ?? ""}
                  onChange={(e) => setDescription(c.id, e.target.value)}
                  onBlur={scheduleSave}
                  placeholder="외모·특징 (예: 빨간머리 여자, 검은 정장)"
                  className="w-full rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-xs text-[var(--muted)]"
                />
                {voices.length > 0 ? (
                  <select
                    value={c.voice ?? ""}
                    onChange={(e) => {
                      const v = voices.find((x) => x.id === e.target.value);
                      setVoice(c.id, e.target.value, v?.name ?? "", v?.provider ?? "");
                    }}
                    title="이 캐릭터 더빙 목소리(카탈로그 config/voices.json)"
                    className="w-full rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-xs"
                  >
                    <option value="">🎙 목소리 선택…</option>
                    {["eleven", "typecast"].map((pv) => {
                      const list = voices.filter((v) => (v.provider ?? "eleven") === pv);
                      if (!list.length) return null;
                      return (
                        <optgroup key={pv} label={pv === "eleven" ? "ElevenLabs" : "Typecast"}>
                          {list.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name}
                              {v.gender ? ` · ${v.gender === "female" ? "여" : v.gender === "male" ? "남" : v.gender}` : ""}
                              {v.note ? ` · ${v.note}` : ""}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                ) : (
                  <input
                    value={c.voice ?? ""}
                    onChange={(e) => setVoice(c.id, e.target.value, "", "")}
                    onBlur={scheduleSave}
                    placeholder="🎙 목소리 id — config/voices.json 에 등록"
                    className="w-full rounded border border-dashed border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[11px] text-[var(--muted)]"
                  />
                )}
              </div>
              <span className="ml-auto shrink-0 text-xs text-[var(--muted)]">{c.sceneIds.length}컷</span>
            </div>
            {/* 실사화 얼굴 고정용 초상 — 3단계 '실사화' 재생성에서 이 캐릭터 얼굴 레퍼런스로 쓰임 */}
            <div className="mb-2 flex items-center gap-2">
              {c.realImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={c.realImage}
                  alt="실사"
                  onClick={() => onZoom(c.realImage!)}
                  className="h-14 w-14 shrink-0 cursor-zoom-in rounded border border-[var(--accent)] object-cover"
                />
              ) : (
                <div className="grid h-14 w-14 shrink-0 place-items-center rounded border border-dashed border-[var(--border)] text-center text-[9px] text-[var(--muted)]">
                  실사 초상
                </div>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <button
                  onClick={() => onDesignPortrait(c.id, buildRealInstr(c))}
                  disabled={portraitPending.has(c.id)}
                  className="self-start rounded bg-[var(--accent)] px-2 py-0.5 text-xs font-medium text-white disabled:opacity-40"
                  title="대표 컷 → 실사 인물 초상(실사화 재생성 얼굴 고정)"
                >
                  {portraitPending.has(c.id) ? "생성 중…" : c.realImage ? "🧑 실사 다시" : "🧑 실사화"}
                </button>
                <div className="flex flex-wrap gap-1">
                  {ETHNICITIES.map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setRealEthnicity(c.id, c.realEthnicity === val ? "" : val)}
                      className={`rounded border px-1.5 py-0.5 text-[10px] ${
                        c.realEthnicity === val
                          ? "border-[var(--accent)] font-medium text-[var(--accent)]"
                          : "border-[var(--border)] hover:bg-[var(--panel-2)]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <input
                  value={c.realPrompt ?? ""}
                  onChange={(e) => setRealPrompt(c.id, e.target.value)}
                  onBlur={scheduleSave}
                  placeholder="실사 지시(선택): 예 30대, 부드러운 인상"
                  className="w-full rounded border border-dashed border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[11px] text-[var(--muted)]"
                />
              </div>
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

      {/* 대사 · 화자 — 말풍선별로 어느 캐릭터가 말하는지(더빙 목소리 매핑) */}
      {dialogueScenes.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold">
            대사 · 화자{" "}
            <span className="font-normal text-[var(--muted)]">
              — 말풍선·나레이션마다 누가 읽는지 (더빙용)
            </span>
          </h3>
          <div className="max-h-[45vh] space-y-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-2">
            {dialogueScenes.map((s) => {
              const rows = bubblesOf(s);
              return (
                <div
                  key={s.id}
                  className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1"
                >
                  <div className="mb-0.5 text-[10px] text-[var(--muted)]">
                    컷 {s.order + 1}
                    {rows.length > 1 ? ` · 말풍선 ${rows.length}개` : ""}
                  </div>
                  <div className="space-y-1">
                    {rows.map(({ idx, text }) => {
                      const key = `${s.id}#${idx}`;
                      const sc = cast.find((c) => c.id === speakerMap[key]);
                      return (
                        <div key={key} className="flex items-center gap-2 text-xs">
                          {sc ? (
                            <Thumb sceneId={repScene(sc)} cls="h-6 w-6 shrink-0" />
                          ) : (
                            <span className="h-6 w-6 shrink-0" />
                          )}
                          <select
                            value={speakerMap[key] ?? ""}
                            onChange={(e) => setSpeaker(key, e.target.value)}
                            className="shrink-0 rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-0.5"
                          >
                            <option value="">나레이션/미상</option>
                            {cast.map((c) => (
                              <option key={c.id} value={c.id}>
                                {optLabel(c)}
                              </option>
                            ))}
                          </select>
                          <span className="truncate" title={text}>
                            “{text}”
                          </span>
                        </div>
                      );
                    })}
                    {narrationOf(s) !== "" &&
                      (() => {
                        const key = `${s.id}#nar`;
                        const sc = cast.find((c) => c.id === speakerMap[key]);
                        return (
                          <div className="flex items-center gap-2 text-xs">
                            {sc ? (
                              <Thumb sceneId={repScene(sc)} cls="h-6 w-6 shrink-0" />
                            ) : (
                              <span className="h-6 w-6 shrink-0" />
                            )}
                            <span className="shrink-0 rounded bg-[var(--panel)] px-1 text-[10px] text-[var(--muted)]">
                              나레이션
                            </span>
                            <select
                              value={speakerMap[key] ?? ""}
                              onChange={(e) => setSpeaker(key, e.target.value)}
                              className="shrink-0 rounded border border-[var(--border)] bg-[var(--panel)] px-1 py-0.5"
                            >
                              <option value="">나레이터/미상</option>
                              {cast.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {optLabel(c)}
                                </option>
                              ))}
                            </select>
                            <span className="truncate italic text-[var(--muted)]" title={narrationOf(s)}>
                              ({narrationOf(s)})
                            </span>
                          </div>
                        );
                      })()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
