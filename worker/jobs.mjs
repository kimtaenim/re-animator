// ============================================================================
// 잡 오케스트레이터 — split(분할), extract(컷 추출). I/O(Redis·Blob·다운로드)는
// 여기서, 픽셀 연산은 imaging.mjs, 경계 판정은 detect.mjs(순수)로 분리.
// ============================================================================

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { getProject, saveProject, logProgress, resetProgress } from "./store.mjs";
import { computeRowProfile, extractRegion, trimBox } from "./imaging.mjs";
import { buildCanvas, pickRefWidth } from "./canvas.mjs";
import { detectRegions } from "./detect.mjs";
import { splitTallRegions, forceSplit } from "./group.mjs";
import { classifyScenes } from "./classify.mjs";
import { classifyCast } from "./cast.mjs";

const CHARACTER_TYPES = new Set(["lead", "reaction", "characters"]);
import { loadSplitConfig } from "./config.mjs";

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`다운로드 실패 ${r.status} ${String(url).slice(0, 80)}`);
  return Buffer.from(await r.arrayBuffer());
}

function sortedFiles(p) {
  return (p.sourceFiles ?? []).slice().sort((a, b) => a.order - b.order);
}

// ── split: 소스 파일들 → 가상 캔버스 + 컷 경계(Scene) ────────────────────────
export async function runSplit(projectId) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[split]", m);
    await logProgress(projectId, m);
  };

  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const files = sortedFiles(p);
  if (files.length === 0) throw new Error("소스 파일이 없어요");

  const cfg = loadSplitConfig();
  const refWidth = pickRefWidth(files.map((f) => f.width), cfg.refWidthMode);
  await log(`기준폭 ${refWidth}px, 파일 ${files.length}개 — 행 프로파일 계산…`);

  // 파일을 하나씩 열어 프로파일 계산. 버퍼는 VLM 그룹핑 썸네일용으로 보관.
  const profiles = [];
  const normHeights = [];
  const buffers = [];
  for (let i = 0; i < files.length; i++) {
    await log(`파일 ${i + 1}/${files.length} 프로파일…`);
    const buf = await download(files[i].url);
    buffers.push(buf);
    const { profile, normHeight } = await computeRowProfile(buf, refWidth);
    profiles.push(profile);
    normHeights.push(normHeight);
  }

  const canvas = buildCanvas(refWidth, normHeights);

  // 전역 프로파일 이어붙이기(수백만 원소여도 float 라 수 MB).
  const global = new Float32Array(canvas.totalHeight);
  let acc = 0;
  for (const pr of profiles) {
    global.set(pr, acc);
    acc += pr.length;
  }

  // 1) 어디서 자를지 = 알고리즘. 실제 평탄 행(패널 사이 거터)에서만 자른다.
  //    → 인물 몸(평탄하지 않음)을 물리적으로 못 자르고, 거터 없는 패널을 못 쪼갠다.
  await log("경계 검출(실제 거터)…");
  let regions = detectRegions(global, cfg).map((c) => ({ yStart: c.yStart, yEnd: c.yEnd }));
  await log(`거터 컷 ${regions.length}개`);

  // 2) 무엇이 장면인지 = VLM. 거터 없는 '키 큰' 구간만 여러 장면인지 판정하고,
  //    그 위치도 실제 경계로 엄격 스냅 — 진짜 경계 없으면 안 자른다(연속 그림·몸 보호).
  const key = process.env.OPENAI_API_KEY;
  const VLM_MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o";
  if (key) {
    try {
      regions = await splitTallRegions(canvas, buffers, regions, key, VLM_MODEL, log, projectId);
    } catch (e) {
      await log(`분할 검사 실패(거터 컷 유지): ${e?.message ?? e}`);
    }
  }

  // 3) 여백 트림: 각 박스를 그려진 내용에 4변으로 딱 조인다(검은/단색/그라데이션 여백 제거).
  regions = regions.map((r) => ({ yStart: r.yStart, yEnd: r.yEnd, xStart: 0, xEnd: refWidth }));
  await log(`장면 ${regions.length}개 여백 트림…`);
  const trimmed = [];
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const x0 = r.xStart ?? 0;
    const x1 = r.xEnd ?? refWidth;
    let box = { yStart: r.yStart, yEnd: r.yEnd, xStart: x0, xEnd: x1 };
    try {
      const png = await extractRegion(canvas, buffers, r.yStart, r.yEnd, x0, x1);
      const t = await trimBox(png);
      const ny0 = r.yStart + t.top;
      const ny1 = r.yStart + t.bottom;
      const nx0 = x0 + t.left;
      const nx1 = x0 + t.right;
      if (ny1 - ny0 >= 40 && nx1 - nx0 >= 40) box = { yStart: ny0, yEnd: ny1, xStart: nx0, xEnd: nx1 };
    } catch (e) {
      await log(`컷 ${i + 1} 트림 건너뜀: ${e?.message ?? e}`);
    }
    trimmed.push(box);
  }
  regions = trimmed;
  await log(`최종 장면 ${regions.length}개`);

  // 4) 컷 온톨로지 분류 — 각 컷의 타입(중심)+내용. 사람이 G1 에서 확정.
  let cuts = regions.map(() => null);
  if (key) {
    try {
      cuts = await classifyScenes(canvas, buffers, regions, key, VLM_MODEL, log, projectId);
    } catch (e) {
      await log(`컷 분류 실패(미분류): ${e?.message ?? e}`);
    }
  }

  const scenes = regions.map((r, idx) => ({
    id: randomUUID(),
    order: idx,
    sourceRegion: { yStart: r.yStart, yEnd: r.yEnd, xStart: r.xStart, xEnd: r.xEnd },
    cut: cuts[idx] ?? undefined,
    status: "review",
  }));

  // 최신 프로젝트를 다시 읽어 결과만 병합(중간에 다른 갱신 있었을 수 있음).
  const p2 = await getProject(projectId);
  if (!p2) throw new Error("프로젝트가 사라졌어요");
  p2.virtualCanvas = canvas;
  p2.scenes = scenes;
  p2.steps.source = {
    ...p2.steps.source,
    kind: "source",
    status: "review", // G1 경계 검수 대기
    error: undefined,
    updatedAt: Date.now(),
  };
  await saveProject(p2);
  return scenes.length;
}

// ── extract: G1 확정된 경계로 컷 이미지 추출 → Blob → Scene.originalImage ─────
export async function runExtract(projectId) {
  const log = async (m) => {
    console.error("[extract]", m);
    await logProgress(projectId, m);
  };

  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  if (!p.virtualCanvas) throw new Error("가상 캔버스가 없어요(분할 먼저)");
  const files = sortedFiles(p);
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  if (scenes.length === 0) throw new Error("추출할 컷이 없어요");

  await log(`소스 ${files.length}개 다운로드…`);
  const buffers = [];
  for (const f of files) buffers.push(await download(f.url));

  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    await log(`컷 ${i + 1}/${scenes.length} 추출·업로드…`);
    const png = await extractRegion(
      p.virtualCanvas,
      buffers,
      s.sourceRegion.yStart,
      s.sourceRegion.yEnd,
      s.sourceRegion.xStart,
      s.sourceRegion.xEnd
    );
    const { url } = await put(
      `project/${projectId}/cut-${s.order}-${Date.now()}.png`,
      png,
      { access: "public", contentType: "image/png", addRandomSuffix: false }
    );
    s.originalImage = url;
    s.status = "approved";
  }

  const p2 = await getProject(projectId);
  if (!p2) throw new Error("프로젝트가 사라졌어요");
  p2.scenes = scenes;
  p2.steps.source = {
    ...p2.steps.source,
    kind: "source",
    status: "approved", // 1단계 완료 → 이후 M2 진입 가능
    error: undefined,
    updatedAt: Date.now(),
  };
  await saveProject(p2);
  return scenes.length;
}

// ── resplit: 한 컷(order)을 다시 분할 → 서브컷으로 교체 → G1 재검수 ────────────
export async function runResplit(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[resplit]", m);
    await logProgress(projectId, m);
  };

  const order = Number(payload?.order);
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  if (!p.virtualCanvas) throw new Error("가상 캔버스가 없어요");
  const canvas = p.virtualCanvas;
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  const target = scenes.find((s) => s.order === order) ?? scenes[order];
  if (!target) throw new Error("재분할할 컷을 찾을 수 없어요");

  const cfg = loadSplitConfig();
  const files = sortedFiles(p);
  await log(`소스 ${files.length}개 다운로드…`);
  const buffers = [];
  for (const f of files) buffers.push(await download(f.url));

  // 전역 프로파일 → 대상 구간 슬라이스 → 더 민감한 거터 재검출.
  await log("대상 구간 프로파일…");
  const global = new Float32Array(canvas.totalHeight);
  let acc = 0;
  for (const buf of buffers) {
    const { profile } = await computeRowProfile(buf, canvas.refWidth);
    global.set(profile, acc);
    acc += profile.length;
  }
  const y0 = Math.round(target.sourceRegion.yStart);
  const y1 = Math.round(target.sourceRegion.yEnd);
  const cfg2 = {
    ...cfg,
    minGapPx: Math.max(12, Math.round((cfg.minGapPx ?? 40) / 2)),
    minSceneHeightPx: Math.max(30, Math.round((cfg.minSceneHeightPx ?? 60) / 2)),
  };
  let subs = detectRegions(global.subarray(y0, y1), cfg2).map((r) => ({
    yStart: y0 + r.yStart,
    yEnd: y0 + r.yEnd,
  }));
  if (subs.length === 0) subs = [{ yStart: y0, yEnd: y1 }];
  await log(`거터 재검출 ${subs.length}개`);

  // VLM 강제 분할(경계 있을 때만) — 거터로 못 나눈 붙은 장면도 나눔.
  const key = process.env.OPENAI_API_KEY;
  const VLM_MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o";
  if (key) {
    const out = [];
    for (const s of subs) {
      try {
        out.push(...(await forceSplit(canvas, buffers, s, key, VLM_MODEL, log)));
      } catch (e) {
        await log(`VLM 분할 실패(유지): ${e?.message ?? e}`);
        out.push(s);
      }
    }
    subs = out;
  }

  // 여백 트림(대상의 x 범위 상속).
  const x0 = target.sourceRegion.xStart ?? 0;
  const x1 = target.sourceRegion.xEnd ?? canvas.refWidth;
  const trimmed = [];
  for (const s of subs) {
    let box = { yStart: s.yStart, yEnd: s.yEnd, xStart: x0, xEnd: x1 };
    try {
      const png = await extractRegion(canvas, buffers, s.yStart, s.yEnd, x0, x1);
      const t = await trimBox(png);
      const ny0 = s.yStart + t.top;
      const ny1 = s.yStart + t.bottom;
      const nx0 = x0 + t.left;
      const nx1 = x0 + t.right;
      if (ny1 - ny0 >= 40 && nx1 - nx0 >= 40) box = { yStart: ny0, yEnd: ny1, xStart: nx0, xEnd: nx1 };
    } catch (e) {
      await log(`트림 건너뜀: ${e?.message ?? e}`);
    }
    trimmed.push(box);
  }
  await log(`재분할 결과 ${trimmed.length}개`);

  // 새 서브컷 분류.
  let cuts = trimmed.map(() => null);
  if (key) {
    try {
      cuts = await classifyScenes(canvas, buffers, trimmed, key, VLM_MODEL, log, projectId);
    } catch (e) {
      await log(`재분류 실패(미분류): ${e?.message ?? e}`);
    }
  }

  const newScenes = trimmed.map((b, k) => ({
    id: randomUUID(),
    order: 0,
    sourceRegion: b,
    cut: cuts[k] ?? undefined,
    status: "review",
  }));

  // 대상 컷을 새 서브컷으로 교체, 전체 정렬·order 재부여.
  const p2 = await getProject(projectId);
  if (!p2) throw new Error("프로젝트가 사라졌어요");
  const kept = (p2.scenes ?? []).filter((s) => s.id !== target.id);
  p2.scenes = [...kept, ...newScenes]
    .sort((a, b) => a.sourceRegion.yStart - b.sourceRegion.yStart)
    .map((s, i) => ({ ...s, order: i }));
  p2.steps.source = {
    ...p2.steps.source,
    kind: "source",
    status: "review",
    error: undefined,
    updatedAt: Date.now(),
  };
  await saveProject(p2);
  return newScenes.length;
}

// ── cast(M2): 캐릭터 타입 컷을 VLM 이 인물별로 묶어 캐스트 생성 → G0 검수 ────────
export async function runCast(projectId) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[cast]", m);
    await logProgress(projectId, m);
  };

  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  if (!p.virtualCanvas) throw new Error("가상 캔버스가 없어요(분할 먼저)");
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  const charScenes = scenes.filter((s) => s.cut?.type && CHARACTER_TYPES.has(s.cut.type));
  await log(`인물 컷 ${charScenes.length}개 (전체 ${scenes.length})`);

  let cast = [];
  if (charScenes.length > 0) {
    const files = sortedFiles(p);
    await log(`소스 ${files.length}개 다운로드…`);
    const buffers = [];
    for (const f of files) buffers.push(await download(f.url));

    const key = process.env.OPENAI_API_KEY;
    const VLM_MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o";
    cast = await classifyCast(p.virtualCanvas, buffers, charScenes, key, VLM_MODEL, log, projectId);
  }

  const p2 = await getProject(projectId);
  if (!p2) throw new Error("프로젝트가 사라졌어요");
  p2.cast = cast;

  // 화자 자동 귀속: 대사 있는 컷에 배정된 캐릭터가 정확히 1명이면 그 사람이 화자.
  const charsBySceneId = new Map();
  for (const c of cast) {
    for (const sid of c.sceneIds) {
      if (!charsBySceneId.has(sid)) charsBySceneId.set(sid, []);
      charsBySceneId.get(sid).push(c.id);
    }
  }
  let attributed = 0;
  for (const s of p2.scenes ?? []) {
    if (!s.cut) continue;
    const hasDialogue =
      (s.cut.dialogue && s.cut.dialogue.trim()) ||
      (s.cut.type === "text" && s.cut.textKind === "dialogue");
    if (!hasDialogue) continue;
    const chars = charsBySceneId.get(s.id) ?? [];
    if (chars.length === 1) {
      s.cut.speakerId = chars[0];
      attributed++;
    } else if (s.cut.speakerId === undefined) {
      s.cut.speakerId = null; // 애매(0명·여러명) → 사람이 지정
    }
  }
  await log(`화자 자동 귀속 ${attributed}건`);

  p2.steps.cast = {
    ...p2.steps.cast,
    kind: "cast",
    status: "review", // G0 캐스트 검수 대기
    error: undefined,
    updatedAt: Date.now(),
  };
  await saveProject(p2);
  return cast.length;
}
