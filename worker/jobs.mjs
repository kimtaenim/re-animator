// ============================================================================
// 잡 오케스트레이터 — split(분할), extract(컷 추출). I/O(Redis·Blob·다운로드)는
// 여기서, 픽셀 연산은 imaging.mjs, 경계 판정은 detect.mjs(순수)로 분리.
// ============================================================================

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { getProject, saveProject, logProgress, resetProgress } from "./store.mjs";
import { computeRowProfile, extractRegion } from "./imaging.mjs";
import { buildCanvas, pickRefWidth } from "./canvas.mjs";
import { detectRegions } from "./detect.mjs";
import { groupScenes } from "./group.mjs";
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

  await log("경계 검출…");
  const candidates = detectRegions(global, cfg);
  // 평탄도 후보를 VLM이 의미 장면으로 묶음(키 없으면 후보 그대로 폴백).
  await log(`후보 컷 ${candidates.length}개 — 장면 그룹핑…`);
  const regions = await groupScenes(canvas, buffers, candidates, log);
  await log(`최종 컷 ${regions.length}개`);

  const scenes = regions.map((r, idx) => ({
    id: randomUUID(),
    order: idx,
    sourceRegion: { yStart: r.yStart, yEnd: r.yEnd },
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
      s.sourceRegion.yEnd
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
