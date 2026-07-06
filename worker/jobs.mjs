// ============================================================================
// 잡 오케스트레이터 — split(분할), extract(컷 추출). I/O(Redis·Blob·다운로드)는
// 여기서, 픽셀 연산은 imaging.mjs, 경계 판정은 detect.mjs(순수)로 분리.
// ============================================================================

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import {
  getProject,
  saveProject,
  logProgress,
  resetProgress,
  saveRowProfile,
  recordCost,
} from "./store.mjs";
import { computeRowProfile, extractRegion, trimBox } from "./imaging.mjs";
import { buildCanvas, pickRefWidth } from "./canvas.mjs";
import { detectRegions } from "./detect.mjs";
import { splitTallRegions, forceSplit } from "./group.mjs";
import { classifyScenes } from "./classify.mjs";
import { classifyCast } from "./cast.mjs";
import {
  regenScene,
  regenSceneMasked,
  regenScenePhoto,
  makePortrait,
  REGEN_CONCURRENCY,
} from "./regen.mjs";
import { regenSceneFal, regenSceneMaskedFal } from "./fal.mjs";
import { grokVideoFromImage, GROK_VIDEO_COST } from "./grok.mjs";
import { readCutText } from "./ocr.mjs";

// 영상(I2V)은 여러 컷을 병렬로 생성(각자 submit→poll). xAI 초당 1건 제한은 grok.mjs
// 레이트 게이트가 처리하므로, 여기선 병렬 개수만 정한다(제출은 1초 간격으로 자동 스로틀).
const VIDEO_CONCURRENCY = Number(process.env.VIDEO_CONCURRENCY || 6);

// 캐스팅 대상 = 인물이 담긴 컷. person(정지·반응) + action(동작 중 인물) 모두 포함.
const CHARACTER_TYPES = new Set(["person", "action"]);

// 말풍선·효과음 등 '글자만' 컷(text, textKind≠title)은 독립 이미지 컷으로 두지 않는다.
// ★ 이미지 컷 영역은 안 건드린다(깨끗하게 자기 영역만). 대신 그 글자 밴드의 '영역'을 y 로
// 가장 가까운 실제 컷의 cut.textRegions 에 기록 → 추출(extract) 때 그 밴드만 따로 OCR 해서
// 대사를 이웃 컷에 붙인다(이미지엔 말풍선을 합치지 않음). 유실·부정확 방지.
function absorbTextCuts(scenes) {
  const arr = scenes.slice().sort((a, b) => a.sourceRegion.yStart - b.sourceRegion.yStart);
  const h = (s) => s.sourceRegion.yEnd - s.sourceRegion.yStart;
  const heights = arr.map(h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 300;
  // 흡수 대상: 타이틀 아닌 text 이면서 '작은' 컷(말풍선·자막 크기). 큰 패널이 text 로
  // 오분류돼도 통째로 사라지지 않게 — 큰 text 는 실제 컷으로 남긴다(사람이 재분류).
  const isAbsorbable = (s) => s.cut?.type === "text" && h(s) < Math.max(280, median * 0.5);
  const reals = arr.filter((s) => !isAbsorbable(s));
  if (reals.length === 0) return arr; // 전부 흡수대상이면 안전하게 그대로 둔다
  const center = (s) => (s.sourceRegion.yStart + s.sourceRegion.yEnd) / 2;
  for (const s of arr) {
    if (!isAbsorbable(s) || !s.cut) continue;
    let best = null;
    let bestD = Infinity;
    for (const r of reals) {
      const d = Math.abs(center(r) - center(s));
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    if (!best || !best.cut) continue;
    // 이미지 컷 영역은 그대로. 이 글자 밴드 영역만 이웃 컷에 기록(추출 때 따로 OCR).
    if (!best.cut.textRegions) best.cut.textRegions = [];
    best.cut.textRegions.push({
      yStart: s.sourceRegion.yStart,
      yEnd: s.sourceRegion.yEnd,
      xStart: s.sourceRegion.xStart,
      xEnd: s.sourceRegion.xEnd,
    });
  }
  return reals;
}

// 재추출/분할/합병 시 풍선별 화자(speakerId) 보존 — 새 OCR 풍선을 옛 풍선과 글자로 매칭해
// 화자를 옮긴다. 옛 풍선이 없고 컷 단위 레거시 화자만 있으면 풍선 1개일 때 그걸 물려준다.
function mergeBubbleSpeakers(newBubbles, oldBubbles, legacySpeakerId) {
  const bubbles = (newBubbles || []).map((b) => ({ text: b.text, box: b.box }));
  const old = oldBubbles || [];
  const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
  for (const nb of bubbles) {
    const match = old.find((ob) => ob.speakerId && norm(ob.text) === norm(nb.text));
    if (match) nb.speakerId = match.speakerId;
  }
  if (!old.some((o) => o.speakerId) && legacySpeakerId && bubbles.length === 1 && !bubbles[0].speakerId) {
    bubbles[0].speakerId = legacySpeakerId;
  }
  return bubbles;
}
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
  // 프로파일 저장 → 앱이 '그 컷만 분할'을 워커 왕복 없이 즉시 계산.
  await saveRowProfile(
    projectId,
    Buffer.from(global.buffer, global.byteOffset, global.byteLength).toString("base64")
  );

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
    if (i % 2 === 0 || i === regions.length - 1)
      await log(`여백 트림 ${i + 1}/${regions.length}… (${Math.round((i / regions.length) * 100)}%)`);
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

  const rawScenes = regions.map((r, idx) => ({
    id: randomUUID(),
    order: idx,
    sourceRegion: { yStart: r.yStart, yEnd: r.yEnd, xStart: r.xStart, xEnd: r.xEnd },
    cut: cuts[idx] ?? undefined,
    status: "review",
  }));
  // 말풍선·효과음(글자만) 컷 흡수 → 대사만 옆 장면에 붙이고 컷은 제거.
  const before = rawScenes.length;
  const scenes = absorbTextCuts(rawScenes).map((s, i) => ({ ...s, order: i }));
  if (scenes.length !== before) await log(`말풍선 컷 흡수: ${before} → ${scenes.length}컷`);

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

  // ★ 증분: 이미 추출된 컷(originalImage 있음 = 경계 안 바뀜)은 건너뛴다. 새/바뀐 컷만.
  const todo = scenes.filter((s) => !s.originalImage);
  await log(`추출 대상 ${todo.length}컷 (전체 ${scenes.length}, 기존 유지 ${scenes.length - todo.length})`);
  for (const s of scenes) if (s.originalImage) s.status = "approved";

  // ★ 메모리: 추출 PNG 를 전부 들고 있지 않는다(예전 pngById 41장 누적 → raw 캔버스+소스와
  // 겹쳐 OOM 크래시=먹통). 컷당 추출→업로드만 하고 버림. OCR 은 아래에서 그 영역만 다시 추출.
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i];
    await log(`컷 추출·업로드 ${i + 1}/${todo.length}… (${Math.round((i / todo.length) * 100)}%)`);
    try {
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
    } catch (e) {
      await log(`컷 ${s.order + 1} 추출 실패: ${String(e?.message ?? e).slice(0, 100)}`);
    }
  }

  // 글씨 읽기(OCR) — ★ 증분 아님. 이미지 있는 '모든' 컷을 매번 다시 읽는다(예전엔 새 컷만
  // 읽어서, 재추출해도 옛 컷 대사가 안 갱신됐음). 메모리 위해 그 영역만 다시 추출해서 읽음.
  const key = process.env.OPENAI_API_KEY;
  const ocrTodo = scenes.filter((s) => s.originalImage);
  if (key && ocrTodo.length > 0) {
    const OCR_MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o";
    const C = Number(process.env.OCR_CONCURRENCY || 2); // 업스케일 이미지가 커서 동시성 낮게
    let done = 0;
    for (let i = 0; i < ocrTodo.length; i += C) {
      const chunk = ocrTodo.slice(i, i + C);
      await Promise.all(
        chunk.map(async (s) => {
          try {
            const png = await extractRegion(
              p.virtualCanvas,
              buffers,
              s.sourceRegion.yStart,
              s.sourceRegion.yEnd,
              s.sourceRegion.xStart,
              s.sourceRegion.xEnd
            );
            const own = await readCutText(png, key, OCR_MODEL);
            if (!s.cut) s.cut = { dialogue: "", sfx: "", type: null };
            // ★ OCR(풀해상도)이 이 컷 대사의 유일 정답. 자기 이미지 안 글자 = own.
            let allBubbles = [...(own.bubbles || [])];
            let sfx = own.sfx || "";
            // 흡수된 '대사만' 밴드: 그 영역만 따로 추출·OCR → 대사를 이 컷에 붙인다(이미지엔 안 합침).
            for (const tr of s.cut.textRegions ?? []) {
              try {
                const tpng = await extractRegion(
                  p.virtualCanvas,
                  buffers,
                  tr.yStart,
                  tr.yEnd,
                  tr.xStart,
                  tr.xEnd
                );
                const t = await readCutText(tpng, key, OCR_MODEL);
                if (t.bubbles?.length) allBubbles = allBubbles.concat(t.bubbles);
                if (t.sfx) sfx = sfx ? `${sfx} ${t.sfx}` : t.sfx;
              } catch {}
            }
            // 풍선별 speakerId 는 기존 값(텍스트 매칭)으로 보존해 화자 귀속이 안 날아가게.
            s.cut.bubbles = mergeBubbleSpeakers(allBubbles, s.cut.bubbles, s.cut.speakerId);
            s.cut.dialogue = allBubbles
              .map((b) => (b.text || "").trim())
              .filter(Boolean)
              .join("\n")
              .slice(0, 500);
            if (sfx) s.cut.sfx = sfx;
            s.cut.textBoxes = own.boxes; // 마스크는 '이 컷 이미지 안' 글자만(흡수 밴드는 이미지에 없음)
          } catch (e) {
            await log(`컷 ${s.order + 1} 글씨읽기 실패: ${String(e?.message ?? e).slice(0, 100)}`);
          }
        })
      );
      done = Math.min(i + C, ocrTodo.length);
      await log(`글씨 읽기 ${done}/${ocrTodo.length} (${Math.round((done / ocrTodo.length) * 100)}%)`);
    }
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
    const room = global.length - acc;
    if (room <= 0) break;
    global.set(room >= profile.length ? profile : profile.subarray(0, room), acc);
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

  // 여전히 1개면(강한 경계 못 찾음) 가장 평탄한 행에서 강제 2분할 — 사람이 '분할'을
  // 눌렀으니 최소 한 번은 나눈다. 평탄(=거터 같은) 행을 골라 인물 몸 관통 최소화.
  if (subs.length === 1 && subs[0].yEnd - subs[0].yStart >= 120) {
    const s = subs[0];
    const lo = s.yStart + Math.round((s.yEnd - s.yStart) * 0.3);
    const hi = s.yStart + Math.round((s.yEnd - s.yStart) * 0.7);
    let bestY = -1;
    let bestStd = Infinity;
    for (let y = lo; y < hi; y++) {
      if (global[y] < bestStd) {
        bestStd = global[y];
        bestY = y;
      }
    }
    if (bestY > s.yStart + 20 && bestY < s.yEnd - 20) {
      subs = [
        { yStart: s.yStart, yEnd: bestY },
        { yStart: bestY, yEnd: s.yEnd },
      ];
      await log(`강제 2분할 @${bestY} (평탄도 ${bestStd.toFixed(1)})`);
    }
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
  const merged = [...kept, ...newScenes].sort(
    (a, b) => a.sourceRegion.yStart - b.sourceRegion.yStart
  );
  p2.scenes = absorbTextCuts(merged).map((s, i) => ({ ...s, order: i }));
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

// ── regen(M3): 각 컷을 이미지 모델(gpt-image-2 기본 · fal Flux)로 재생성 → 청크 병렬
//    → Scene.generatedImage ─
// payload.sceneIds 주면 그 컷들만(컷 하나씩 테스트/다시생성). 청크마다 저장 → 진행 표시.
export async function runRegen(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[regen]", m);
    await logProgress(projectId, m);
  };

  // 모델 선택 — 컷별(payload.models[sceneId]) 우선 → payload.model → gpt-image-2.
  // gpt-image* → OpenAI, fal/flux → fal.ai Flux. 컷마다 달라도 워커 메모리엔 영향 없음
  // (모델은 라우팅 문자열일 뿐, 피크 메모리는 REGEN_CONCURRENCY 개 이미지 버퍼로 결정).
  const key = process.env.OPENAI_API_KEY;
  const falKey = process.env.FAL_KEY;
  const models = payload?.models && typeof payload.models === "object" ? payload.models : null;
  const defModel = payload?.model || "gpt-image-2";
  const resolveModel = (id) => (models && models[id]) || defModel;

  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  // 텍스트 오버레이 제외, 추출된 컷만(원본 이미지 필요).
  let cand = scenes.filter((s) => s.originalImage && s.cut?.type !== "text");
  if (Array.isArray(payload?.sceneIds) && payload.sceneIds.length) {
    const set = new Set(payload.sceneIds);
    cand = cand.filter((s) => set.has(s.id));
  }
  await log(`재생성 대상 ${cand.length}컷 · 모델 ${models ? "컷별" : defModel} · 동시 ${REGEN_CONCURRENCY}`);
  if (cand.length === 0) throw new Error("재생성할 컷이 없어요(컷 추출 먼저)");

  const genById = new Map(); // sceneId → { url } | { error }
  let costTotal = 0;
  let ok = 0;

  // 누적 결과를 프로젝트에 반영 저장(청크마다 호출 → 진행되는 대로 화면에 채워짐).
  const flush = async (finalStep) => {
    const pp = await getProject(projectId);
    if (!pp) return;
    for (const s of pp.scenes ?? []) {
      const g = genById.get(s.id);
      if (!g) continue;
      if (g.url) {
        s.generatedImage = g.url;
        s.regenError = undefined;
      } else {
        s.regenError = g.error || "생성 실패";
      }
    }
    if (finalStep) {
      pp.steps.regen = {
        ...pp.steps.regen,
        kind: "regen",
        status: "review",
        error: undefined,
        updatedAt: Date.now(),
      };
    }
    await saveProject(pp);
  };

  for (let i = 0; i < cand.length; i += REGEN_CONCURRENCY) {
    const chunk = cand.slice(i, i + REGEN_CONCURRENCY);
    await log(`이미지 생성 ${i + 1}~${i + chunk.length}/${cand.length}…`);
    await Promise.all(
      chunk.map(async (s) => {
        try {
          let buf, cost;
          const sel = resolveModel(s.id);
          const photoreal = sel === "photoreal"; // 실사화(image-2 + 캐릭터 실사 레퍼런스)
          const useFal = !photoreal && (sel === "fal" || sel.startsWith("flux"));
          const openaiModel = sel.startsWith("gpt-image")
            ? sel
            : process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
          if (useFal && !falKey) throw new Error("FAL_KEY 없음(Render 워커 환경변수)");
          if (!useFal && !key) throw new Error("OPENAI_API_KEY 없음");
          const mode = s.regenMode || p.regenMode || "mask";
          if (photoreal) {
            const imgBuf = await download(s.originalImage);
            // 이 컷에 등장하는 캐릭터의 실사 초상을 얼굴 고정 레퍼런스로(최대 3장).
            const refBufs = [];
            for (const c of p.cast ?? []) {
              if (refBufs.length >= 3) break;
              if (c.realImage && (c.sceneIds ?? []).includes(s.id)) {
                try {
                  refBufs.push(await download(c.realImage));
                } catch {}
              }
            }
            ({ buf, cost } = await regenScenePhoto(s, imgBuf, p, key, refBufs));
          } else if (useFal) {
            if (mode === "mask") {
              const imgBuf = await download(s.originalImage);
              ({ buf, cost } = await regenSceneMaskedFal(s, imgBuf, p, falKey));
            } else {
              ({ buf, cost } = await regenSceneFal(s, p, falKey));
            }
          } else {
            const imgBuf = await download(s.originalImage);
            const gen = mode === "mask" ? regenSceneMasked : regenScene;
            ({ buf, cost } = await gen(s, imgBuf, p, key, openaiModel));
          }
          costTotal += cost;
          const { url } = await put(
            `project/${projectId}/gen-${s.order}-${Date.now()}.png`,
            buf,
            { access: "public", contentType: "image/png", addRandomSuffix: false }
          );
          genById.set(s.id, { url });
          ok++;
          await log(`컷 ${s.order + 1} 완료`);
        } catch (e) {
          genById.set(s.id, { error: String(e?.message ?? e) });
          await log(`컷 ${s.order + 1} 실패: ${String(e?.message ?? e).slice(0, 120)}`);
        }
        await flush(false); // ★ 이미지 하나 끝날 때마다 반영 → 그때그때 화면에
      })
    );
    const doneN = Math.min(i + chunk.length, cand.length);
    await log(`진행 ${doneN}/${cand.length} (${Math.round((doneN / cand.length) * 100)}%)`);
  }

  try {
    await recordCost({
      projectId,
      vendor: "openai",
      model: models ? "mixed" : defModel,
      costUsd: costTotal,
      meta: { kind: "regen", images: cand.length, ok },
    });
  } catch {}

  await flush(true); // 마지막 반영 + 단계 review
  await log(`재생성 완료: ${ok}/${cand.length} (~$${costTotal.toFixed(3)})`);
  return ok;
}

// ── portrait: 캐릭터 대표 컷 → 실사 인물 초상 생성 → Character.realImage. 캐스팅 얼굴 고정용.
//    payload { charId }. cast 단계 상태는 안 건드림(캐스팅 UI 유지) — 앱이 cast 를 폴링해 반영.
export async function runPortrait(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[portrait]", m);
    await logProgress(projectId, m);
  };
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY 없음");
  const charId = payload?.charId;
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const ch = (p.cast ?? []).find((c) => c.id === charId);
  if (!ch) throw new Error("캐릭터를 찾을 수 없어요");
  // 대표 컷(refSceneId) 원본 이미지. 없으면 첫 sceneId.
  const refSid = ch.refSceneId || ch.sceneIds?.[0];
  const refScene = (p.scenes ?? []).find((s) => s.id === refSid);
  const srcUrl = refScene?.originalImage;
  if (!srcUrl) throw new Error("대표 컷 이미지가 없어요(컷 추출 먼저)");
  await log(`${ch.label} 실사 초상 생성…`);
  const refBuf = await download(srcUrl);
  const { buf } = await makePortrait(refBuf, key, ch.realPrompt);
  const { url } = await put(`project/${projectId}/portrait-${charId}-${Date.now()}.png`, buf, {
    access: "public",
    contentType: "image/png",
    addRandomSuffix: false,
  });
  // 최신 상태 재읽기 후 그 캐릭터만 realImage 반영(다른 편집 안 덮게).
  const pp = (await getProject(projectId)) ?? p;
  const c2 = (pp.cast ?? []).find((c) => c.id === charId);
  if (c2) {
    c2.realImage = url;
    await saveProject(pp);
  }
  try {
    await recordCost({ projectId, vendor: "openai", model: "gpt-image-2", costUsd: 0.04, meta: { kind: "portrait", charId } });
  } catch {}
  await log(`${ch.label} 실사 초상 완료`);
  return 1;
}

// 영상 길이(초) 추정. 우선순위: ①사람 지정(cut.durationSec) → ②대사 글자 수(한국어 ~5자/초)
// → ③무대사 장면전환(transition)은 길게 → ④그 외 최소 비트. 나중에 TTS 오디오 길이가 마스터.
const half = (x) => Math.max(0.5, Math.min(15, Math.round(x * 2) / 2)); // 0.5초 단위로 스냅
function estimateVideoSeconds(cut) {
  const MIN = Number(process.env.VIDEO_MIN_SEC || 2);
  const MAX = Number(process.env.VIDEO_MAX_SEC || 8);
  if (cut?.durationSec) return half(cut.durationSec);
  const parts = [];
  if (cut?.bubbles?.length) for (const b of cut.bubbles) parts.push(b.text || "");
  else if (cut?.dialogue) parts.push(cut.dialogue);
  if (cut?.narration) parts.push(cut.narration);
  const chars = parts.join(" ").replace(/\s+/g, "").length;
  if (chars > 0) {
    const CPS = Number(process.env.VIDEO_CHARS_PER_SEC || 5);
    return Math.max(MIN, Math.min(MAX, Math.round(chars / CPS)));
  }
  if (cut?.type === "transition") return Number(process.env.VIDEO_TRANSITION_SEC || 1.5);
  return Number(process.env.VIDEO_SILENT_SEC || 1); // 대사 없는 정지컷 기본 1초
}

// 영상 모션 프롬프트 = 컷 모션(카메라 워크) + 가이드(스톱모션 느낌). aninews video_motion 계승.
// 정지컷 내용은 이미지가 담고 있으니 프롬프트엔 '어떻게 움직일지'만 넣는다.
const MOTION_GUIDANCE =
  "Keep motion subtle and minimal — small, gentle movements and a slow, steady camera; " +
  "keep the subject, art style and colors consistent with the still image. No new objects, no text, no morphing.";
function buildVideoPrompt(cut) {
  const motion = String(cut?.motion || "").trim();
  return motion ? `${motion}. ${MOTION_GUIDANCE}` : MOTION_GUIDANCE;
}

// ── video(M4): 재생성 컷(generatedImage)을 Grok I2V 로 영상화 → Scene.videoUrl ─
//    scene 단계로 진행 표시. payload.sceneIds 있으면 그 컷만. 길이는 대사 기반 추정.
export async function runVideo(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[video]", m);
    await logProgress(projectId, m);
  };

  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  let cand = scenes.filter((s) => s.generatedImage); // 재생성된 컷만 I2V 대상
  if (Array.isArray(payload?.sceneIds) && payload.sceneIds.length) {
    const set = new Set(payload.sceneIds);
    cand = cand.filter((s) => set.has(s.id));
  }
  if (cand.length === 0) throw new Error("영상 만들 컷이 없어요(먼저 3단계 재생성)");
  await log(`영상 생성 대상 ${cand.length}컷 · Grok · 동시 ${VIDEO_CONCURRENCY}`);

  const byId = new Map(); // sceneId → { url } | { error }
  let costTotal = 0;
  let ok = 0;

  const flush = async (finalStep) => {
    const pp = await getProject(projectId);
    if (!pp) return;
    for (const s of pp.scenes ?? []) {
      const g = byId.get(s.id);
      if (!g) continue;
      if (g.url) {
        s.videoUrl = g.url;
        s.videoError = undefined;
      } else {
        s.videoError = g.error || "영상 실패";
      }
    }
    if (finalStep) {
      pp.steps.scene = {
        ...pp.steps.scene,
        kind: "scene",
        status: "review",
        error: undefined,
        updatedAt: Date.now(),
      };
    }
    await saveProject(pp);
  };

  for (let i = 0; i < cand.length; i += VIDEO_CONCURRENCY) {
    const chunk = cand.slice(i, i + VIDEO_CONCURRENCY);
    await log(`영상 ${i + 1}~${i + chunk.length}/${cand.length}…`);
    await Promise.all(
      chunk.map(async (s) => {
        try {
          const dur = estimateVideoSeconds(s.cut); // 대사/타입/지정 기반 초(0.5 단위 가능)
          const grokDur = Math.max(1, Math.min(10, Math.round(dur))); // Grok 은 정수만
          const videoUrl = await grokVideoFromImage(
            { imageUrl: s.generatedImage, prompt: buildVideoPrompt(s.cut), duration: grokDur },
            () => log(`컷 ${s.order + 1} 생성 중…(${grokDur}s)`)
          );
          const buf = await download(videoUrl);
          const { url } = await put(
            `project/${projectId}/vid-${s.order}-${Date.now()}.mp4`,
            buf,
            { access: "public", contentType: "video/mp4", addRandomSuffix: false }
          );
          byId.set(s.id, { url });
          costTotal += GROK_VIDEO_COST * dur; // 초당 단가 × 길이
          ok++;
          await log(`컷 ${s.order + 1} 영상 완료 (${dur}s)`);
        } catch (e) {
          byId.set(s.id, { error: String(e?.message ?? e) });
          await log(`컷 ${s.order + 1} 영상 실패: ${String(e?.message ?? e).slice(0, 120)}`);
        }
        await flush(false);
      })
    );
    const doneN = Math.min(i + chunk.length, cand.length);
    await log(`진행 ${doneN}/${cand.length} (${Math.round((doneN / cand.length) * 100)}%)`);
  }

  try {
    await recordCost({
      projectId,
      vendor: "xai",
      model: "grok-imagine-video",
      costUsd: costTotal,
      meta: { kind: "video", clips: cand.length, ok },
    });
  } catch {}

  await flush(true);
  await log(`영상 완료: ${ok}/${cand.length} (~$${costTotal.toFixed(3)})`);
  return ok;
}

// ── splitcut(M3+): 이후 단계에서도 컷 하나를 분할 → 서브컷 추출+글씨읽기까지 →
//    바로 M3 재생성 준비. source 단계는 approved 유지, regen 단계로 진행 표시.
export async function runSplitCut(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[splitcut]", m);
    await logProgress(projectId, m);
  };
  const sceneId = payload?.sceneId;
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  if (!p.virtualCanvas) throw new Error("가상 캔버스가 없어요");
  const canvas = p.virtualCanvas;
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  const target = scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error("분할할 컷을 찾을 수 없어요");

  const cfg = loadSplitConfig();
  const files = sortedFiles(p);
  await log(`소스 ${files.length}개 다운로드…`);
  const buffers = [];
  for (const f of files) buffers.push(await download(f.url));

  // 프로파일 → 대상 구간 재검출 + VLM 강제 분할 + 평탄행 폴백(runResplit 과 동일 로직).
  const global = new Float32Array(canvas.totalHeight);
  let acc = 0;
  for (const buf of buffers) {
    const { profile } = await computeRowProfile(buf, canvas.refWidth);
    const room = global.length - acc;
    if (room <= 0) break;
    global.set(room >= profile.length ? profile : profile.subarray(0, room), acc);
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
  const key = process.env.OPENAI_API_KEY;
  const VLM_MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o";
  if (key) {
    const out = [];
    for (const s of subs) {
      try {
        out.push(...(await forceSplit(canvas, buffers, s, key, VLM_MODEL, log)));
      } catch {
        out.push(s);
      }
    }
    subs = out;
  }
  if (subs.length === 1 && subs[0].yEnd - subs[0].yStart >= 120) {
    const s = subs[0];
    const lo = s.yStart + Math.round((s.yEnd - s.yStart) * 0.3);
    const hi = s.yStart + Math.round((s.yEnd - s.yStart) * 0.7);
    let bestY = -1;
    let bestStd = Infinity;
    for (let y = lo; y < hi; y++) {
      if (global[y] < bestStd) {
        bestStd = global[y];
        bestY = y;
      }
    }
    if (bestY > s.yStart + 20 && bestY < s.yEnd - 20) {
      subs = [
        { yStart: s.yStart, yEnd: bestY },
        { yStart: bestY, yEnd: s.yEnd },
      ];
    }
  }
  await log(`분할 ${subs.length}개 — 추출·글씨읽기…`);

  // 트림 + 추출 + OCR + 분류 → 새 서브컷(originalImage 까지) 만든다.
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
    } catch {}
    trimmed.push(box);
  }
  let cuts = trimmed.map(() => null);
  if (key) {
    try {
      cuts = await classifyScenes(canvas, buffers, trimmed, key, VLM_MODEL, log, projectId);
    } catch {}
  }
  const newScenes = [];
  for (let k = 0; k < trimmed.length; k++) {
    const box = trimmed[k];
    const png = await extractRegion(canvas, buffers, box.yStart, box.yEnd, box.xStart, box.xEnd);
    const { url } = await put(`project/${projectId}/cut-split-${Date.now()}-${k}.png`, png, {
      access: "public",
      contentType: "image/png",
      addRandomSuffix: false,
    });
    const cut = cuts[k] ?? { type: null, dialogue: "", sfx: "" };
    if (key) {
      try {
        const ocr = await readCutText(png, key, VLM_MODEL);
        cut.bubbles = mergeBubbleSpeakers(ocr.bubbles, cut.bubbles, cut.speakerId);
        cut.dialogue = ocr.dialogue;
        if (ocr.sfx) cut.sfx = ocr.sfx;
        cut.textBoxes = ocr.boxes;
      } catch {}
    }
    newScenes.push({
      id: randomUUID(),
      order: 0,
      sourceRegion: box,
      cut,
      originalImage: url,
      status: "approved",
    });
  }

  const p2 = await getProject(projectId);
  if (!p2) throw new Error("프로젝트가 사라졌어요");
  const kept = (p2.scenes ?? []).filter((s) => s.id !== target.id);
  const merged = [...kept, ...newScenes].sort(
    (a, b) => a.sourceRegion.yStart - b.sourceRegion.yStart
  );
  p2.scenes = absorbTextCuts(merged).map((s, i) => ({ ...s, order: i }));
  p2.steps.regen = {
    ...p2.steps.regen,
    kind: "regen",
    status: "review",
    error: undefined,
    updatedAt: Date.now(),
  };
  await saveProject(p2);
  await log(`분할 완료: ${target.order + 1}번 → ${newScenes.length}개`);
  return newScenes.length;
}

// ── mergecut(M3+): 컷을 앞/뒤 이웃과 합병 → 합친 영역 추출+글씨읽기 → M3 재생성 준비.
export async function runMergeCut(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[mergecut]", m);
    await logProgress(projectId, m);
  };
  const sceneId = payload?.sceneId;
  const dir = payload?.dir === "prev" ? -1 : 1;
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  if (!p.virtualCanvas) throw new Error("가상 캔버스가 없어요");
  const canvas = p.virtualCanvas;
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  const idx = scenes.findIndex((s) => s.id === sceneId);
  if (idx < 0) throw new Error("합병할 컷을 찾을 수 없어요");
  const j = idx + dir;
  if (j < 0 || j >= scenes.length) throw new Error("합칠 이웃 컷이 없어요");
  const a = scenes[idx];
  const b = scenes[j];

  const region = {
    yStart: Math.min(a.sourceRegion.yStart, b.sourceRegion.yStart),
    yEnd: Math.max(a.sourceRegion.yEnd, b.sourceRegion.yEnd),
    xStart: Math.min(a.sourceRegion.xStart ?? 0, b.sourceRegion.xStart ?? 0),
    xEnd: Math.max(a.sourceRegion.xEnd ?? canvas.refWidth, b.sourceRegion.xEnd ?? canvas.refWidth),
  };

  const files = sortedFiles(p);
  await log(`소스 ${files.length}개 다운로드…`);
  const buffers = [];
  for (const f of files) buffers.push(await download(f.url));

  await log("합친 영역 추출·글씨읽기…");
  const png = await extractRegion(canvas, buffers, region.yStart, region.yEnd, region.xStart, region.xEnd);
  const { url } = await put(`project/${projectId}/cut-merge-${Date.now()}.png`, png, {
    access: "public",
    contentType: "image/png",
    addRandomSuffix: false,
  });
  const key = process.env.OPENAI_API_KEY;
  const VLM_MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o";
  const cut = { type: a.cut?.type ?? b.cut?.type ?? null, dialogue: "", sfx: "", textBoxes: [] };
  // 대사: 합친 이미지 OCR + 두 컷의 기존 대사(흡수 나레이션 포함) 합쳐 중복 줄 제거.
  let ocr = null;
  if (key) {
    try {
      ocr = await readCutText(png, key, VLM_MODEL);
    } catch (e) {
      await log(`글씨읽기 실패: ${String(e?.message ?? e).slice(0, 100)}`);
    }
  }
  const lines = [ocr?.dialogue, a.cut?.dialogue, b.cut?.dialogue]
    .flatMap((t) => String(t || "").split("\n"))
    .map((x) => x.trim())
    .filter(Boolean);
  cut.dialogue = [...new Set(lines)].join("\n");
  cut.sfx = ocr?.sfx || a.cut?.sfx || b.cut?.sfx || "";
  cut.textBoxes = ocr?.boxes ?? [];
  // 풍선별 화자: 합친 이미지 OCR 풍선에, 두 원본 컷의 풍선 화자를 글자 매칭으로 보존.
  cut.bubbles = mergeBubbleSpeakers(
    ocr?.bubbles ?? [],
    [...(a.cut?.bubbles ?? []), ...(b.cut?.bubbles ?? [])],
    a.cut?.speakerId ?? b.cut?.speakerId
  );

  const merged = {
    id: randomUUID(),
    order: 0,
    sourceRegion: region,
    cut,
    originalImage: url,
    status: "approved",
  };

  const p2 = await getProject(projectId);
  if (!p2) throw new Error("프로젝트가 사라졌어요");
  const kept = (p2.scenes ?? []).filter((s) => s.id !== a.id && s.id !== b.id);
  p2.scenes = [...kept, merged]
    .sort((x, y) => x.sourceRegion.yStart - y.sourceRegion.yStart)
    .map((s, i) => ({ ...s, order: i }));
  p2.steps.regen = {
    ...p2.steps.regen,
    kind: "regen",
    status: "review",
    error: undefined,
    updatedAt: Date.now(),
  };
  await saveProject(p2);
  await log("합병 완료");
  return 1;
}
