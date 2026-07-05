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
import { splitTallRegions } from "./group.mjs";
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

  const scenes = regions.map((r, idx) => ({
    id: randomUUID(),
    order: idx,
    sourceRegion: { yStart: r.yStart, yEnd: r.yEnd, xStart: r.xStart, xEnd: r.xEnd },
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
