// ============================================================================
// 잡 오케스트레이터 — split(분할), extract(컷 추출). I/O(Redis·Blob·다운로드)는
// 여기서, 픽셀 연산은 imaging.mjs, 경계 판정은 detect.mjs(순수)로 분리.
// ============================================================================

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { put } from "@vercel/blob";
import {
  getProject,
  saveProject,
  logProgress,
  resetProgress,
  saveRowProfile,
  recordCost,
} from "./store.mjs";
import sharp from "sharp";
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
import { translateBubbles, translateTexts } from "./translate.mjs";
import { synthesize, synthSfx } from "./tts.mjs";

// 만화 효과음(한글 의성어) → ElevenLabs Sound Effects 용 짧은 영어 사운드 묘사. 실패 시 원문.
async function sfxToEnglish(korean, key) {
  if (!key) return korean;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_SFX_MODEL || "gpt-4o-mini",
        temperature: 0,
        max_tokens: 30,
        messages: [
          {
            role: "user",
            content: `만화 효과음 의성어 "${korean}" 를 그 소리를 만들 짧은 영어 사운드 묘사로만 답해. 예: 쾅→loud explosion bang, 두근→heartbeat thump, 쏴→pouring rain. 오직 묘사구(따옴표 없이).`,
          },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return korean;
    const d = await r.json();
    const t = d.choices?.[0]?.message?.content?.trim();
    return t ? t.replace(/^["']|["']$/g, "").slice(0, 200) : korean;
  } catch {
    return korean;
  }
}

// 영상(I2V)은 여러 컷을 병렬로 생성(각자 submit→poll). xAI 초당 1건 제한은 grok.mjs
// 레이트 게이트가 처리하므로, 여기선 병렬 개수만 정한다(제출은 1초 간격으로 자동 스로틀).
const VIDEO_CONCURRENCY = Number(process.env.VIDEO_CONCURRENCY || 6);

// 캐스팅 대상 = 인물이 담긴 컷. person(정지·반응) + action(동작 중 인물) 모두 포함.
const CHARACTER_TYPES = new Set(["person", "action"]);

// 말풍선·효과음 등 '글자만' 작은 컷(text)은 독립 이미지 컷으로 두지 않고 제거한다.
// 제거로 생긴 '틈'과 원래 컷 사이 빈 구간의 텍스트(내레이션 등)는 아래 addGapTextRegions 가
// 이웃 컷의 textRegions 로 잡아 추출 때 따로 OCR 한다(이미지엔 안 합침).
function absorbTextCuts(scenes) {
  const arr = scenes.slice().sort((a, b) => a.sourceRegion.yStart - b.sourceRegion.yStart);
  const h = (s) => s.sourceRegion.yEnd - s.sourceRegion.yStart;
  const heights = arr.map(h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 300;
  const isAbsorbable = (s) => s.cut?.type === "text" && h(s) < Math.max(280, median * 0.5);
  const reals = arr.filter((s) => !isAbsorbable(s));
  if (!reals.length) return arr; // 전부 흡수대상이면 그대로
  // ★제거되는 '텍스트만' 컷(말풍선·내레이션 밴드)의 영역을 가장 가까운 살아남은 컷의
  //   textRegions 로 확실히 넘긴다(검출 임계값에 안 의존 → 안 놓침). 추출이 그 영역만 따로
  //   OCR 해 그 컷 대사에 붙인다(영역엔 안 합침 → 재생성 이미지 오염 없음).
  for (const t of arr) {
    if (!isAbsorbable(t)) continue;
    const tc = (t.sourceRegion.yStart + t.sourceRegion.yEnd) / 2;
    let best = null;
    let bd = Infinity;
    for (const s of reals) {
      const c = (s.sourceRegion.yStart + s.sourceRegion.yEnd) / 2;
      const d = Math.abs(c - tc);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (!best) continue;
    if (!best.cut) best.cut = { dialogue: "", sfx: "", type: null };
    if (!best.cut.textRegions) best.cut.textRegions = [];
    best.cut.textRegions.push({
      yStart: t.sourceRegion.yStart,
      yEnd: t.sourceRegion.yEnd,
      xStart: t.sourceRegion.xStart,
      xEnd: t.sourceRegion.xEnd,
    });
  }
  return reals;
}

// ★가장자리 확장 — 컷 위/아래 가장자리가 '내용 행'과 맞닿아 이어지면 내용이 끝나는 데까지
//   컷을 늘린다. 어두운 만화에서 거터 오판으로 그림 중간(머리통 등)에 경계가 서는 문제의
//   결정론적 수술(사용자 실측: 컷 가장자리 밖으로 그림이 이어져 잘려 보임). 텍스트 밴드가
//   맞닿아 있으면 컷 안으로 들어오는데, 컷 안 글자는 정상 경로(OCR+textBoxes 마스크)라 무해.
function extendRegionEdges(regions, profile, totalH) {
  const STD = Number(process.env.EDGE_EXT_STD || 8); // 이 이상 = 내용 있는 행
  const BLANK_OK = 10; // 그림 내 미세 공백 허용(px) — 이보다 길게 비면 진짜 여백으로 보고 중단
  const MAX_EXT = 1600; // 폭주 방지
  const sorted = regions.slice().sort((a, b) => a.yStart - b.yStart);
  let grown = 0;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const before = r.yEnd - r.yStart;
    // 아래쪽 가장자리
    const nextStart = Math.round(sorted[i + 1]?.yStart ?? totalH);
    let y = Math.round(r.yEnd);
    let blank = 0;
    let moved = 0;
    while (y < nextStart - 4 && moved < MAX_EXT) {
      if (profile[y] > STD) {
        r.yEnd = y + 1;
        blank = 0;
      } else if (++blank > BLANK_OK) break;
      y++;
      moved++;
    }
    // 위쪽 가장자리(앞 컷은 이미 확장 완료된 yEnd 를 경계로)
    const prevEnd = Math.round(sorted[i - 1]?.yEnd ?? 0);
    y = Math.round(r.yStart) - 1;
    blank = 0;
    moved = 0;
    while (y > prevEnd + 4 && moved < MAX_EXT) {
      if (profile[y] > STD) {
        r.yStart = y;
        blank = 0;
      } else if (++blank > BLANK_OK) break;
      y--;
      moved++;
    }
    if (r.yEnd - r.yStart > before + 24) {
      grown++;
      // 세로로 크게 늘었으면 트림된 가로 크롭이 새 내용과 안 맞을 수 있어 전체 폭으로 해제.
      delete r.xStart;
      delete r.xEnd;
    }
  }
  return grown;
}

// ★ 컷이 아닌 '빈 구간'(내레이션 밴드 등)도 텍스트가 있을 수 있다. 컷들이 안 덮은 y 구간 중
// '내용 있는'(행별 평탄도 프로파일이 높은) 곳을 가장 가까운 컷의 textRegions 로 추가 → 추출 때
// 따로 OCR 해 대사/내레이션을 그 컷에 붙인다. 평탄한 거터(내용 없음)는 건너뛴다.
function addGapTextRegions(scenes, profile, totalHeight, log) {
  if (!scenes.length) return 0;
  const sorted = scenes.slice().sort((a, b) => a.sourceRegion.yStart - b.sourceRegion.yStart);
  const gaps = [];
  let cursor = 0;
  const push = (a, b) => {
    if (b - a > 24) gaps.push({ yStart: a, yEnd: b });
  };
  for (const s of sorted) {
    push(cursor, s.sourceRegion.yStart);
    cursor = Math.max(cursor, s.sourceRegion.yEnd);
  }
  push(cursor, totalHeight);
  // ★핵심 수정: 갭이 텍스트인지 '평균'이 아니라 '글자 있는 행(피크)'으로 판정한다. 여백에
  // 둘러싸인 얇은 내레이션 밴드는 평균을 내면 임계 아래로 깔려 통째로 스킵됐다(= 못 잡던 원인).
  // 글자 행의 위·아래 끝을 찾아 그 밴드로 좁혀 저장 → 추출이 그 부분만 OCR 해 이웃 컷에 붙인다.
  const TEXT_STD = Number(process.env.GAP_TEXT_STD || 8); // 이 이상 = 글자(잉크) 있는 행
  const MIN_ROWS = Number(process.env.GAP_MIN_ROWS || 4); // 글자 행이 이만큼은 있어야 텍스트
  const MAX_BANDS = Number(process.env.GAP_MAX_BANDS || 240); // ★24→120→240: 중국 만화 실측서 120도 14개 초과(그림 run 이 슬롯을 먹음)
  // absorbTextCuts 가 이미 넘긴 밴드는 건너뛴다(중복 OCR·중복 대사 방지).
  const existing = [];
  for (const s of scenes) for (const tr of s.cut?.textRegions ?? []) existing.push([tr.yStart, tr.yEnd]);
  const overlapsExisting = (a, b) => existing.some(([x, y]) => Math.min(b, y) - Math.max(a, x) > 8);
  // ★갭 안의 '내용 있는 행'을 연속 구간(run)별로 쪼갠다(빈 행 20px 이상이면 분리).
  //   예전엔 갭당 첫~끝 행을 밴드 1개로 묶고, 흡수 밴드와 겹치면 갭 전체를 버렸다 —
  //   같은 갭에 있던 다른 내레이션까지 같이 유실(중국 만화에서 실측 확인). run 단위로
  //   각각 판정하면 겹치는 run 만 스킵되고 나머지는 산다.
  const textyRuns = (a, b) => {
    const y0 = Math.max(0, Math.floor(a));
    const y1 = Math.min(profile.length, Math.ceil(b));
    const runs = [];
    let first = -1;
    let last = -1;
    let count = 0;
    let blank = 0;
    const flush = () => {
      if (first >= 0 && count >= MIN_ROWS) runs.push({ yStart: Math.max(y0, first - 6), yEnd: Math.min(y1, last + 6) });
      first = -1;
      last = -1;
      count = 0;
    };
    for (let y = y0; y < y1; y++) {
      if (profile[y] > TEXT_STD) {
        if (first < 0) first = y;
        last = y;
        count++;
        blank = 0;
      } else if (first >= 0 && ++blank >= 20) {
        flush();
        blank = 0;
      }
    }
    flush();
    // ★run 이 갭 끝에 붙어 있으면(=글줄이 씬 경계에 잘려 이어짐) 이웃 씬 쪽으로 90px 연장해
    //   잘린 줄 전체가 OCR 되게 한다(밴드는 OCR 전용이라 씬 영역과 겹쳐도 무해).
    for (const r of runs) {
      if (r.yStart <= y0 + 8) r.yStart = Math.max(0, y0 - 90);
      if (r.yEnd >= y1 - 8) r.yEnd = Math.min(profile.length, y1 + 90);
    }
    return runs;
  };
  let added = 0;
  let dropped = 0;
  for (const g of gaps) {
    for (const band of textyRuns(g.yStart, g.yEnd)) {
      if (overlapsExisting(band.yStart, band.yEnd)) continue; // 이미 흡수로 넘어간 run 만 스킵
      if (added >= MAX_BANDS) {
        dropped++;
        continue;
      }
      const gc = (band.yStart + band.yEnd) / 2;
      let best = null;
      let bd = Infinity;
      for (const s of scenes) {
        const c = (s.sourceRegion.yStart + s.sourceRegion.yEnd) / 2;
        const d = Math.abs(c - gc);
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
      if (!best) continue;
      if (!best.cut) best.cut = { dialogue: "", sfx: "", type: null };
      if (!best.cut.textRegions) best.cut.textRegions = [];
      best.cut.textRegions.push({ yStart: band.yStart, yEnd: band.yEnd });
      added++;
    }
  }
  // ★침묵 상한 금지 — 잘렸으면 로그로 알린다(예전엔 24개에서 조용히 중단 = 유실 은폐).
  if (dropped > 0 && log) log(`⚠ 텍스트 밴드 상한(${MAX_BANDS}) 초과 — ${dropped}개 구간 예약 못함(GAP_MAX_BANDS 상향 필요)`);
  return added;
}

// 재추출/분할/합병 시 풍선별 화자(speakerId)·자막위치(subtitleX/Y) 보존 — 새 OCR 풍선을
// 옛 풍선과 글자로 매칭해 옮긴다. 옛 풍선이 없고 컷 단위 레거시 화자만 있으면 풍선 1개일 때 물려준다.
function mergeBubbleSpeakers(newBubbles, oldBubbles, legacySpeakerId) {
  const bubbles = (newBubbles || []).map((b) => ({ text: b.text, box: b.box }));
  const old = oldBubbles || [];
  const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
  for (const nb of bubbles) {
    const match = old.find(
      (ob) =>
        (ob.speakerId || ob.subtitleX != null || ob.subtitleY != null || ob.emotion) &&
        norm(ob.text) === norm(nb.text)
    );
    if (match) {
      if (match.speakerId) nb.speakerId = match.speakerId;
      if (typeof match.subtitleX === "number") nb.subtitleX = match.subtitleX;
      if (typeof match.subtitleY === "number") nb.subtitleY = match.subtitleY;
      if (match.emotion) nb.emotion = match.emotion; // 감정 연기도 화자처럼 보존
      if (match.translation) nb.translation = match.translation; // 번역도 보존 → 재추출 때 재번역 안 함(원문 같으면)
    }
  }
  if (!old.some((o) => o.speakerId) && legacySpeakerId && bubbles.length === 1 && !bubbles[0].speakerId) {
    bubbles[0].speakerId = legacySpeakerId;
  }
  return bubbles;
}
import { loadSplitConfig } from "./config.mjs";
import { directCut, CAMERA_PROMPTS } from "./director.mjs";

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`다운로드 실패 ${r.status} ${String(url).slice(0, 80)}`);
  return Buffer.from(await r.arrayBuffer());
}

// ffmpeg 경로(지연 확정) — ffmpeg-static 있으면 그걸, 없으면 PATH. env override 우선.
let _ffPath = null;
async function ffmpegPath() {
  if (_ffPath !== null) return _ffPath;
  try {
    _ffPath = process.env.FFMPEG_PATH || (await import("ffmpeg-static")).default || "ffmpeg";
  } catch {
    _ffPath = process.env.FFMPEG_PATH || "ffmpeg";
  }
  return _ffPath;
}

// mp4 버퍼에서 오디오 트랙 제거(그록 I2V가 자동으로 넣는 소리 삭제). 실패하면 null → 원본 사용.
// 재인코딩 없이 -c copy -an 이라 빠르다.
async function stripAudio(buf) {
  let dir;
  try {
    const ff = await ffmpegPath();
    dir = await mkdtemp(join(tmpdir(), "vstrip-"));
    const inp = join(dir, "in.mp4");
    const out = join(dir, "out.mp4");
    await writeFile(inp, buf);
    await new Promise((res, rej) => {
      const pr = spawn(ff, ["-y", "-i", inp, "-c", "copy", "-an", "-movflags", "+faststart", out]);
      let err = "";
      pr.stderr.on("data", (d) => (err += d));
      pr.on("error", rej);
      pr.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}: ${err.slice(-200)}`))));
    });
    return await readFile(out);
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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
  // 가장자리가 그림을 자르고 있으면 내용 끝까지 확장(머리통 절단 방지).
  const grown = extendRegionEdges(regions, global, canvas.totalHeight);
  if (grown) await log(`경계 확장: ${grown}개 컷 가장자리가 그림에 걸려 있어 내용 끝까지 늘림`);
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
  // 컷 밖 빈 구간(내레이션 등)도 OCR 잡히게 이웃 컷 textRegions 로 예약.
  const gapN = addGapTextRegions(scenes, global, canvas.totalHeight, log);
  if (gapN) await log(`컷 밖 텍스트 구간 ${gapN}개 → 이웃 컷에 OCR 예약`);
  // ── 진단: 텍스트 캡처가 어디서 새는지 보이게 ──
  const typeCounts = {};
  for (const s of scenes) {
    const t = s.cut?.type ?? "(미분류)";
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  const totalTR = scenes.reduce((n, s) => n + (s.cut?.textRegions?.length || 0), 0);
  await log(`[진단] 컷 타입 ${JSON.stringify(typeCounts)}`);
  await log(`[진단] 텍스트 밴드 예약 총 ${totalTR}개(흡수+갭) — 이 수만큼 내레이션이 이웃 컷 OCR에 붙음`);

  // ★내레이션 미리 읽기(사용자 요구: "처음부터 나와야지") — 예약 밴드를 분할 단계에서
  //   바로 OCR 해 컷 bubbles(내레이션)로 붙인다 → G1 카드에서 즉시 글자로 확인 가능.
  //   추출(2단계)이 나중에 전체를 다시 읽어 덮어쓰므로 여기서 실패해도 유실은 아니다.
  if (key && totalTR > 0) {
    // ★순서 보존: 동시 OCR 은 하되(속도), 부착은 전부 끝난 뒤 '위치(y) 오름차순'으로.
    //   응답 순서대로 붙이면 위 문장이 아래로 가는 등 읽는 순서가 뒤집힌다(사용자 실측).
    const units = [];
    for (const s of scenes) {
      const trs = (s.cut?.textRegions ?? []).slice().sort((a, b) => a.yStart - b.yStart);
      for (const tr of trs) units.push({ s, tr, out: null });
    }
    await log(`내레이션 미리 읽기 ${units.length}개 밴드…`);
    const C2 = 3;
    for (let i = 0; i < units.length; i += C2) {
      await Promise.all(
        units.slice(i, i + C2).map(async (u) => {
          try {
            const png = await extractRegion(canvas, buffers, u.tr.yStart, u.tr.yEnd, u.tr.xStart, u.tr.xEnd);
            const t = await readCutText(png, key, VLM_MODEL);
            if (t.bubbles?.length) u.out = t.bubbles.map((b) => ({ text: b.text }));
          } catch {}
        })
      );
      const done = Math.min(i + C2, units.length);
      if (done === units.length || done % 15 < C2) await log(`내레이션 미리 읽기 ${done}/${units.length}…`);
    }
    let got = 0;
    for (const u of units) {
      if (!u.out) continue;
      if (!u.s.cut) u.s.cut = { dialogue: "", sfx: "", type: null };
      u.s.cut.bubbles = [...(u.s.cut.bubbles ?? []), ...u.out];
      got++;
    }
    await log(`내레이션 미리 읽기 완료 — ${got}개 밴드에서 글자 확보(G1 컷 카드에 표시)`);
  }

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

  // ★내레이션 재예약(구조 수정): 분할이 예약한 textRegions 를 G1 경계 저장(/api/boundaries
  //   cleanCut)이 지워버려 추출은 늘 '밴드 0개'로 돌았다(= 내레이션 반복 소실의 원인).
  //   소비자인 추출이 시작할 때 '최종 경계' 기준으로 컷 밖 텍스트 밴드를 다시 계산해 예약한다
  //   → 경계를 어떤 경로(G1 저장·재분할·컷 분할/합병)로 고쳤어도 안 사라진다.
  //   이미 있는 밴드와 겹치면 스킵(addGapTextRegions 내장)이라 중복 OCR 없음.
  try {
    const global = new Float32Array(p.virtualCanvas.totalHeight);
    let acc = 0;
    for (const buf of buffers) {
      const { profile } = await computeRowProfile(buf, p.virtualCanvas.refWidth);
      const room = global.length - acc;
      if (room <= 0) break;
      global.set(room >= profile.length ? profile : profile.subarray(0, room), acc);
      acc += profile.length;
    }
    const gapN = addGapTextRegions(scenes, global, p.virtualCanvas.totalHeight, log);
    const totalTR = scenes.reduce((n, s) => n + (s.cut?.textRegions?.length || 0), 0);
    await log(`[진단] 내레이션 밴드: 추출 직전 재예약 ${gapN}개 → 총 ${totalTR}개`);
  } catch (e) {
    await log(`내레이션 밴드 재예약 실패(추출은 계속): ${String(e?.message ?? e).slice(0, 80)}`);
  }

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
    let trTotal = 0; // [진단] textRegion(넘어온 내레이션 밴드) OCR 시도/성공 수
    let trHit = 0;
    let dirOk = 0; // [진단] AI 연출 성공 컷 수
    let dirCost = 0; // AI 연출 비용 합계(USD)
    let trlOk = 0; // [진단] 번역 채운 줄 수(외국어 원문 → 한국어 주석)
    let trlCost = 0; // 번역 비용 합계(USD)
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
            // ★읽는 순서 보존: 밴드를 y 오름차순으로 돌고, 컷 '위' 밴드 글은 컷 안 글보다
            //   앞에, '아래' 밴드 글은 뒤에 둔다(위 문장이 아래로 가는 역전 방지).
            const above = [];
            const below = [];
            let sfx = own.sfx || "";
            const trs = (s.cut.textRegions ?? []).slice().sort((a, b) => a.yStart - b.yStart);
            for (const tr of trs) {
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
                trTotal++;
                if (t.bubbles?.length) {
                  (tr.yStart < s.sourceRegion.yStart ? above : below).push(...t.bubbles);
                  trHit++;
                }
                if (t.sfx) sfx = sfx ? `${sfx} ${t.sfx}` : t.sfx;
              } catch {}
            }
            let allBubbles = [...above, ...(own.bubbles || []), ...below];
            // 풍선별 speakerId 는 기존 값(텍스트 매칭)으로 보존해 화자 귀속이 안 날아가게.
            s.cut.bubbles = mergeBubbleSpeakers(allBubbles, s.cut.bubbles, s.cut.speakerId);
            s.cut.dialogue = allBubbles
              .map((b) => (b.text || "").trim())
              .filter(Boolean)
              .join("\n")
              .slice(0, 500);
            if (sfx) s.cut.sfx = sfx;
            s.cut.textBoxes = own.boxes; // 마스크는 '이 컷 이미지 안' 글자만(흡수 밴드는 이미지에 없음)
            // ── 대사 번역(편집자용 주석) — 외국어 원문에 한국어 뜻을 곁들인다. 원문 text·더빙은 불변.
            //   translateBubbles 가 한국어·이미 번역된 줄은 스킵(재실행 보존). 실패해도 대사엔 무해.
            try {
              const { translated, cost } = await translateBubbles(s.cut.bubbles, key);
              trlOk += translated;
              trlCost += cost;
              // 레거시 내레이션 문자열(별도 필드)도 번역 — 대부분 bubbles 로 흡수되지만 있으면 채움.
              if ((s.cut.narration || "").trim() && !(s.cut.narrationTranslation || "").trim()) {
                const { translations, cost: nc } = await translateTexts([s.cut.narration], key);
                if (translations[0]) s.cut.narrationTranslation = translations[0];
                trlCost += nc;
              }
            } catch {}
            // ── AI 연출: 번역을 읽고 풀 연출안(카메라·길이·전환·동작·줄별 감정·자막위치)을
            //   디폴트로 채운다. ★사용자가 이미 지정한 값은 절대 안 덮는다(미지정 필드만).
            const needCam = !(s.cut.motion || "").trim();
            const needDur = s.cut.durationSec == null;
            const needTrans = s.cut.transition == null;
            const needAction = s.cut.action == null;
            const needEmo = (s.cut.bubbles ?? []).some((b) => !b.emotion && b.speakerId !== "__sfx__" && (b.text || "").trim());
            const needSubY = (s.cut.bubbles ?? []).some((b) => b.subtitleY == null && b.speakerId !== "__sfx__" && (b.text || "").trim());
            if (needCam || needDur || needTrans || needAction || needEmo || needSubY) {
              try {
                const lines = (s.cut.bubbles ?? [])
                  .map((b, bi) => ({ index: bi, speaker: b.speakerId === "__sfx__" ? null : b.speakerId ? "character" : "narration", text: (b.text || "").trim(), translation: (b.translation || "").trim() }))
                  .filter((l) => l.speaker && l.text);
                const d = await directCut(png, s.cut, lines);
                if (d) {
                  if (needCam && d.camera !== "none" && CAMERA_PROMPTS[d.camera]) s.cut.motion = CAMERA_PROMPTS[d.camera];
                  if (needDur && d.durationSec) s.cut.durationSec = d.durationSec;
                  if (needTrans && d.transition) s.cut.transition = d.transition;
                  if (needAction) s.cut.action = d.action; // "" 도 저장 → '동작 없음'으로 확정(재실행 방지)
                  for (const e of d.emotions) {
                    const b = s.cut.bubbles?.[e.index];
                    if (!b || b.speakerId === "__sfx__" || !(b.text || "").trim()) continue;
                    if (!b.emotion && e.emotion !== "none") b.emotion = e.emotion;
                    if (b.subtitleY == null && typeof e.subtitleY === "number") b.subtitleY = e.subtitleY;
                  }
                  dirOk++;
                  dirCost += d.costUsd || 0;
                }
              } catch (e) {
                await log(`컷 ${s.order + 1} ${String(e?.message ?? e).slice(0, 120)}`);
              }
            }
          } catch (e) {
            await log(`컷 ${s.order + 1} 글씨읽기 실패: ${String(e?.message ?? e).slice(0, 100)}`);
          }
        })
      );
      done = Math.min(i + C, ocrTodo.length);
      await log(`글씨 읽기 ${done}/${ocrTodo.length} (${Math.round((done / ocrTodo.length) * 100)}%)`);
    }
    await log(`[진단] 내레이션 밴드 OCR: ${trHit}/${trTotal} 성공(글자 잡힘) — 0/0이면 밴드가 분할서 안 넘어온 것`);
    if (trlOk > 0) {
      await log(`[진단] 대사 번역: ${trlOk}줄에 한국어 주석 채움(외국어 원문, $${trlCost.toFixed(3)}) — 원문·더빙은 그대로`);
      try {
        await recordCost({
          projectId,
          vendor: "openai",
          model: process.env.OPENAI_TRANSLATE_MODEL || "gpt-4o-mini",
          costUsd: trlCost,
          meta: { kind: "translate", lines: trlOk },
        });
      } catch {}
    }
    if (dirOk > 0) {
      await log(`[진단] AI 연출: ${dirOk}컷에 카메라·감정 디폴트 채움(Claude, $${dirCost.toFixed(3)})`);
      try {
        await recordCost({
          projectId,
          vendor: "anthropic",
          model: process.env.CLAUDE_DIRECTOR_MODEL || "claude-opus-4-8",
          costUsd: dirCost,
          meta: { kind: "direct", cuts: dirOk },
        });
      } catch {}
    } else if (!process.env.ANTHROPIC_API_KEY) {
      await log("AI 연출 건너뜀 — 워커 env 에 ANTHROPIC_API_KEY 를 넣으면 카메라·감정 자동 지정");
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
  const buffers = []; // 화자 추론 패스도 씀 — 블록 밖으로 호이스트
  if (charScenes.length > 0) {
    const files = sortedFiles(p);
    await log(`소스 ${files.length}개 다운로드…`);
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

  // ★화자 자동 배정(VLM) — 컷 이미지 + 앞뒤 컷 맥락 + 캐스트 명단으로 각 대사 줄의 화자를
  //   추론해 기본값으로 채운다(사용자 요구: 자동으로 골라주고 사람은 나중에 터치만).
  //   이미 지정된 줄(speakerId !== undefined)은 절대 안 건드린다. 판단 불가는 미지정으로 남김.
  const keyA = process.env.OPENAI_API_KEY;
  const VLM_A = process.env.OPENAI_VLM_MODEL || "gpt-4o";
  if (keyA && cast.length > 0 && buffers.length > 0) {
    const scList = (p2.scenes ?? []).slice().sort((a, b) => a.order - b.order);
    // ★추론 대상 = 캐릭터로 안 정해진 모든 줄(undefined + null). null(내레이션)도 다시 판정한다 —
    //   추출/화면 저장 경로가 전 줄을 null 로 깔아버려 '미지정만' 조건이면 대상 0개가 됨(실측).
    //   보호는 문자열 id(캐릭터·효과음)만: 사람이 캐릭터로 고른 줄은 절대 안 덮는다.
    const open = (b) => b.speakerId == null && (b.text || "").trim();
    const todo = scList.filter((s) => (s.cut?.bubbles ?? []).some(open));
    const roster = cast.map((c) => `${c.id}: ${c.label}${c.note ? " — " + c.note : ""}`).join("\n");
    const castIds = new Set(cast.map((c) => c.id));
    await log(`화자 추론(앞뒤 맥락) 대상 ${todo.length}컷…`);
    let assigned = 0;
    let usdA = 0;
    const CC = 2;
    for (let i = 0; i < todo.length; i += CC) {
      await Promise.all(
        todo.slice(i, i + CC).map(async (s) => {
          try {
            const idx = scList.findIndex((x) => x.id === s.id);
            const ctx = (x) =>
              x
                ? `컷${x.order + 1}(${x.cut?.type ?? "?"}): ${(x.cut?.description ?? "").slice(0, 80)} / 대사: ${(x.cut?.bubbles ?? [])
                    .map((b) => (b.translation || b.text || "").slice(0, 25))
                    .join(" | ")
                    .slice(0, 120)}`
                : "(없음)";
            const png = await extractRegion(
              p2.virtualCanvas,
              buffers,
              s.sourceRegion.yStart,
              s.sourceRegion.yEnd,
              s.sourceRegion.xStart,
              s.sourceRegion.xEnd
            );
            const img = await sharp(png).resize({ width: 512, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
            const ask = (s.cut.bubbles ?? [])
              .map((b, bi) => ({ bi, t: (b.text || "").trim(), tr: (b.translation || "").trim(), open: open(b) }))
              .filter((l) => l.open);
            if (!ask.length) return;
            const body = {
              model: VLM_A,
              temperature: 0,
              response_format: { type: "json_object" },
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "image_url", image_url: { url: "data:image/jpeg;base64," + img.toString("base64") } },
                    {
                      type: "text",
                      text:
                        `웹툰 컷 이미지와 앞뒤 맥락으로 각 대사 줄의 화자를 정하라.\n등장인물 명단(id: 이름):\n${roster}\n\n` +
                        `앞 컷: ${ctx(scList[idx - 1])}\n뒤 컷: ${ctx(scList[idx + 1])}\n\n이 컷의 대사 줄:\n` +
                        ask.map((l) => `${l.bi}. ${l.t.slice(0, 60)}${l.tr ? ` (뜻: ${l.tr.slice(0, 60)})` : ""}`).join("\n") +
                        `\n\n규칙: 장면 밖 서술·해설이면 "narration". 명단 인물이 말하는 대사면 그 id(입 모양·시선·말풍선 꼬리·앞뒤 대화 흐름으로 판단). ★이 컷 화면에 안 보이는 인물이 말할 수도 있다(오프스크린 대사) — 호명·대화 흐름상 명단 인물이 확실하면 그 id 를 써라. 판단이 어려우면 "unknown". ` +
                        `JSON 만: {"speakers":[{"i":줄번호,"s":"id|narration|unknown"}]}`,
                    },
                  ],
                },
              ],
            };
            const r = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { authorization: `Bearer ${keyA}`, "content-type": "application/json" },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(60_000),
            });
            if (!r.ok) return;
            const j = await r.json();
            usdA += ((j.usage?.prompt_tokens ?? 0) * 2.5 + (j.usage?.completion_tokens ?? 0) * 10) / 1e6;
            const out = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
            for (const e of out.speakers ?? []) {
              const b = s.cut.bubbles?.[e.i];
              if (!b || typeof b.speakerId === "string") continue; // 캐릭터·효과음으로 지정된 줄만 보호
              if (e.s === "narration") {
                b.speakerId = null;
                assigned++;
              } else if (castIds.has(e.s)) {
                b.speakerId = e.s;
                assigned++;
              }
            }
          } catch {}
        })
      );
      const done = Math.min(i + CC, todo.length);
      if (done === todo.length || done % 10 < CC) await log(`화자 추론 ${done}/${todo.length}…`);
    }
    await log(`[진단] 화자 자동 배정 ${assigned}줄 (~$${usdA.toFixed(3)}) — unknown 은 미지정, 캐스팅 화면에서 확인·수정`);
    try {
      await recordCost({ projectId, vendor: "openai", model: VLM_A, costUsd: usdA, meta: { kind: "speakers", lines: assigned } });
    } catch {}
  }

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
  const { buf } = await makePortrait(refBuf, key, payload?.prompt ?? ch.realPrompt);
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
// ★기본 톤(사용자 지정): 무조건 스타일리시. '작고 느리고 잔잔하게'는 aninews 용이고
//   re-animator 는 빠르고 스타일리시하게 — 정적 샷도 허용하되 '디자인된 것처럼' 멋있어야 한다.
//   일관성 가드(스타일·인물 유지, 새 오브젝트·텍스트·변형 금지)는 그대로 지킨다.
// ★설계 교훈(2026-07-18): 공통 지침에 'LARGE fast movement 가 정답'을 넣었더니 모델이
//   '피사체를 크게 움직여라'로 해석 — 쓸데없는 인물 동작만 커지고 정작 카메라 문법(급가속·
//   스냅)은 실종(사용자: "싸구려"). 역할 분리로 재설계: 프리셋(cut.motion)이 카메라의
//   '무엇·언제'를 시간 구조로 지시하고, 공통 지침은 '그대로 정밀 실행 + 피사체는 정지'만.
// 인물 동작 규칙(2026-07-18 사용자 확정): 잔잔한 동작은 살리되 작게 — 고개 들기/내리기/돌리기
// 같은 3D 움직임 권장, 표정은 원본 그대로, ★없는 인물·사물 생성 절대 금지★.
const MOTION_GUIDANCE =
  "Execute the camera direction above EXACTLY, especially its timing profile (the slow and fast phases) — " +
  "clean, controlled, professional camera work like a high-end music video. " +
  "Characters may move subtly and naturally: small 3D head movements (slowly raising, lowering or turning the head), " +
  "breathing, blinking, hair and cloth motion, a slight shift of weight — keep these movements SMALL and calm. " +
  "CONTINUE any action already depicted in the still image (someone drawn mid-walk keeps walking, someone running keeps running, at the same pace); " +
  "but do not START new actions or gestures that are not already happening in the still. " +
  "Keep each character's facial EXPRESSION exactly as drawn in the still image — do not change the emotion. " +
  "NEVER add characters, people or objects that are not in the still image. " +
  "Keep the art style and colors; no text; do not distort faces.";
// 프리셋이 비어 있을 때의 기본 카메라(공통 지침은 '실행 지침'이라 자체 동작 지시가 없음).
const DEFAULT_MOTION = "Camera direction: slow, confident cinematic push-in toward the subject.";
// 대사 있는 인물 컷: '말하는 것처럼' 입/얼굴 움직임(진짜 립싱크 아님 — Grok I2V 한계).
const SPEAKING_GUIDANCE =
  "The character is talking: natural, subtle lip and mouth movement as if speaking, with a slight, " +
  "lively facial expression. Keep the same identity and pose; do not add text or captions.";
// 이 컷에 '인물이 하는 대사'가 있나 — 인물/액션 컷 + ★화자가 캐릭터(charId)로 지정된★ 대사.
// 내레이션(speakerId=null)·미지정(undefined) 은 입이 안 움직인다 = 대사와 내레이션의 유일한 차이.
function hasSpokenDialogue(cut) {
  if (!cut || (cut.type !== "person" && cut.type !== "action")) return false;
  const bubs = cut.bubbles ?? [];
  if (bubs.length)
    return bubs.some((b) => !!b.speakerId && b.speakerId !== "__sfx__" && (b.text || "").trim() !== "");
  return (cut.dialogue || "").trim() !== "";
}
function buildVideoPrompt(cut) {
  const motion = String(cut?.motion || "").trim() || DEFAULT_MOTION;
  // 동작(이어가기)이 있으면 카메라 지시 뒤에 짧게 덧붙인다. AI 연출이 '그림에 이미 있는 동작의
  // 이어가기'만 담도록 제약했으므로 MOTION_GUIDANCE(새 동작 금지)와 충돌하지 않는다.
  const action = String(cut?.action || "").trim();
  const cam = action ? `${motion}. Subject action (continue only what is already happening): ${action}` : motion;
  const base = `${cam}. ${MOTION_GUIDANCE}`;
  return hasSpokenDialogue(cut) ? `${base} ${SPEAKING_GUIDANCE}` : base;
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
          const raw = await download(videoUrl);
          const buf = (await stripAudio(raw)) ?? raw; // 그록 자동 오디오 제거(실패 시 원본)
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

// ── dub(M6): 대사·내레이션을 TTS로 음성화 → bubble.audioUrl / cut.narrationAudioUrl ──
//    화자=캐릭터면 그 캐릭터 목소리, 화자 없음(내레이션)이면 프로젝트 나레이터 목소리.
//    payload.sceneIds 있으면 그 컷만. scene 단계로 진행 표시.
// ── postfx: Grok 원본 클립에 줌 커브(크래시인/아웃·램프·펀치)를 ffmpeg 로 실제 픽셀에 굽기 ──
//    결과는 scene.fxUrl — 미리보기·합성이 그대로 재사용(미리보기 = 최종 픽셀). 원본 videoUrl 은
//    보존이라 강도 바꿔 재적용·해제(none) 가능. 저장은 fresh 재읽기 후 해당 필드만 머지(저장 규약).
export async function runPostfx(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[postfx]", m);
    await logProgress(projectId, m);
  };
  const effect = String(payload?.effect ?? "");
  const strength = Math.max(1, Math.min(3, Math.round(Number(payload?.strength) || 2)));
  const ids = new Set(Array.isArray(payload?.sceneIds) ? payload.sceneIds : []);
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const targets = (p.scenes ?? []).filter((s) => ids.has(s.id) && s.videoUrl);
  if (!targets.length) throw new Error("후처리할 영상이 없어요(먼저 동영상 생성)");

  // effect=none → 렌더 없이 해제.
  if (effect === "none") {
    const p2 = await getProject(projectId);
    for (const s of p2.scenes ?? []) {
      if (ids.has(s.id)) {
        delete s.fxUrl;
        delete s.fx;
      }
    }
    await saveProject(p2);
    await log(`후처리 해제 ${targets.length}컷 — 원본 사용`);
    return targets.length;
  }

  const ff = await ffmpegPath();
  const fp = await (async () => {
    try {
      return process.env.FFPROBE_PATH || (await import("ffprobe-static")).default?.path || "ffprobe";
    } catch {
      return "ffprobe";
    }
  })();
  const probe = (file, entry) =>
    new Promise((res) => {
      const pr = spawn(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", entry, "-of", "default=nw=1:nk=1", file]);
      let out = "";
      pr.stdout.on("data", (d) => (out += d));
      pr.on("close", () => res(out.trim().split(/\s+/).map(Number)));
      pr.on("error", () => res([]));
    });
  // 강도별 최대 줌(2.0 초과는 픽셀 뭉개짐 — 상한 고정).
  const ZM = { 1: 1.35, 2: 1.65, 3: 2.0 }[strength];

  let done = 0;
  for (const s of targets) {
    let dir;
    try {
      dir = await mkdtemp(join(tmpdir(), "refx-"));
      const inp = join(dir, "in.mp4");
      const outp = join(dir, "out.mp4");
      const buf = await download(s.videoUrl);
      await writeFile(inp, buf);
      const [W, H] = await probe(inp, "stream=width,height");
      const [T] = await probe(inp, "format=duration");
      if (!W || !H || !T) throw new Error("클립 정보를 읽지 못함");
      // 줌 커브 Z(t) — 프리셋 문법과 동일한 2단 속도 철학. crop 은 짝수 강제(코덱 요구).
      const T1 = Math.max(0.3, T - 0.4).toFixed(3); // 크래시인: 마지막 0.4s 에 스냅
      const Z = {
        "crash-in": `if(lt(t,${T1}), 1+0.06*t/${T1}, 1.06+(${ZM}-1.06)*pow(min(1,(t-${T1})/0.4),2))`,
        "crash-out": `if(lt(t,0.35), ${ZM}, max(1, ${ZM}-(${ZM}-1)*pow(min(1,(t-0.35)/0.4),2)))`,
        "ramp-in": `1+(${ZM}-1)*pow(t/${T.toFixed(3)},2.5)`,
        punch: `if(lt(t,0.1), 1+(${ZM}-1)*t/0.1, if(lt(t,0.55), ${ZM}-(${ZM}-1.12)*(t-0.1)/0.45, 1.12))`,
      }[effect];
      if (!Z) throw new Error(`알 수 없는 효과: ${effect}`);
      // 펀치는 감쇠 흔들림 추가(수평 0.5s).
      const shake = effect === "punch" ? `+${(0.015 * strength).toFixed(4)}*iw*sin(55*t)*exp(-6*t)` : "";
      const vf =
        `crop=w='floor(iw/(${Z})/2)*2':h='floor(ih/(${Z})/2)*2':` +
        `x='(iw-ow)/2${shake}':y='(ih-oh)/2',scale=${W}:${H},setsar=1`;
      await new Promise((res, rej) => {
        const pr = spawn(ff, ["-hide_banner", "-nostats", "-loglevel", "warning", "-y", "-i", inp, "-vf", vf, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", "-threads", "2", "-movflags", "+faststart", outp]);
        let err = "";
        pr.stderr.on("data", (d) => {
          err += d;
          if (err.length > 8000) err = err.slice(-8000);
        });
        pr.on("error", rej);
        pr.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}: ${err.slice(-300)}`))));
      });
      const { url } = await put(`project/${projectId}/fx-${s.order}-${Date.now()}.mp4`, await readFile(outp), {
        access: "public",
        contentType: "video/mp4",
        addRandomSuffix: false,
      });
      // fresh 재읽기 후 해당 씬 필드만 머지(다른 갱신 클로버 방지 — 저장 규약).
      const p2 = await getProject(projectId);
      const t2 = (p2?.scenes ?? []).find((x) => x.id === s.id);
      if (p2 && t2) {
        t2.fxUrl = url;
        t2.fx = { effect, strength };
        await saveProject(p2);
      }
      done++;
      await log(`후처리 ${done}/${targets.length} — 컷 ${s.order + 1} (${effect}·강도${strength})`);
    } catch (e) {
      await log(`컷 ${s.order + 1} 후처리 실패: ${String(e?.message ?? e).slice(0, 120)}`);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  await log(`후처리 완료 ${done}/${targets.length}`);
  return done;
}

export async function runDub(projectId, payload) {
  // ★비디오 잡과 '병렬'로 돌 수 있으므로 공유 진행로그(resetProgress/logProgress)·단계 상태를
  //   건드리지 않는다(그러면 동영상 진행 표시가 깨짐). 진행은 잡 상태로 앱이 추적, 상세는 콘솔.
  const log = async (m) => console.error("[dub]", m);
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const cast = p.cast ?? [];
  const narrator = p.narratorVoice || null;
  const speed = Math.max(0.5, Math.min(2, Number(p.dubSpeed) || 1)); // 말 속도 배수
  const only =
    Array.isArray(payload?.sceneIds) && payload.sceneIds.length ? new Set(payload.sceneIds) : null;
  const scenes = (p.scenes ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .filter((s) => !only || only.has(s.id));

  // 화자 id → 목소리. charId면 그 캐릭터(voice+provider), null/미지정이면 나레이터.
  const resolve = (speakerId) => {
    if (speakerId) {
      const c = cast.find((x) => x.id === speakerId);
      if (c?.voice) return { provider: c.voiceProvider || "eleven", id: c.voice, name: c.voiceName || c.label };
      return null; // 화자 지정됐지만 목소리 미배정 → 스킵
    }
    return narrator ? { provider: narrator.provider, id: narrator.id, name: narrator.name } : null;
  };

  // 합성 유닛 수집: 말풍선 + 내레이션.
  const units = [];
  for (const s of scenes) {
    const cut = s.cut;
    if (!cut) continue;
    let bubs = cut.bubbles ?? [];
    // ★말풍선이 없고 dialogue(한 줄 대사)만 있으면 그걸 단일 말풍선으로 승격 — 예전엔 dialogue 를
    //   무시해서 "대사 없음"으로 실패했음. 승격해두면 더빙·미리보기가 말풍선으로 일관된다.
    if (!bubs.length && (cut.dialogue || "").trim()) {
      bubs = [{ text: cut.dialogue.trim(), speakerId: cut.speakerId ?? null }];
      cut.bubbles = bubs;
      cut.dialogue = "";
    }
    for (let i = 0; i < bubs.length; i++) {
      const text = (bubs[i].text || "").trim();
      if (!text) continue;
      if (bubs[i].speakerId === "__sfx__") {
        units.push({ s, kind: "sfx", idx: i, text, voice: "__sfx__" }); // 효과음 줄 → 소리 생성
      } else {
        units.push({ s, kind: "bubble", idx: i, text, voice: resolve(bubs[i].speakerId), emotion: bubs[i].emotion });
      }
    }
    const nar = (cut.narration || "").trim();
    if (nar) units.push({ s, kind: "nar", idx: -1, text: nar, voice: resolve(cut.narrationSpeakerId ?? null) });
  }
  if (!units.length) throw new Error("더빙할 대사·내레이션이 없어요");

  await log(`더빙 대상 ${units.length}개 — 목소리 생성 시작`);
  const C = Number(process.env.DUB_CONCURRENCY || 2);
  let done = 0;
  let ok = 0;
  let skipped = 0;
  for (let i = 0; i < units.length; i += C) {
    const chunk = units.slice(i, i + C);
    await Promise.all(
      chunk.map(async (u) => {
        try {
          let audio;
          if (u.kind === "sfx") {
            // 효과음 줄 — 한글 의성어를 영어 사운드 묘사로 바꿔 ElevenLabs Sound Effects.
            const desc = await sfxToEnglish(u.text, process.env.OPENAI_API_KEY);
            audio = await synthSfx(desc);
          } else if (!u.voice) {
            skipped++;
            return; // 목소리 미배정 → 스킵
          } else {
            audio = await synthesize(u.voice.provider, u.voice.id, u.text, speed, u.emotion);
          }
          const { buf, ext, contentType } = audio;
          const { url } = await put(
            `project/${projectId}/dub/${u.s.id}-${u.kind}${u.idx}-${Date.now()}.${ext}`,
            buf,
            { access: "public", contentType, addRandomSuffix: false }
          );
          if (u.kind === "nar") {
            u.s.cut.narrationAudioUrl = url;
          } else if (u.s.cut?.bubbles?.[u.idx]) {
            u.s.cut.bubbles[u.idx].audioUrl = url; // 대사·효과음 줄 모두 말풍선 audioUrl 에
          }
          ok++;
        } catch (e) {
          await log(`더빙 실패(컷 ${u.s.order + 1}): ${String(e?.message ?? e).slice(0, 120)}`);
        }
      })
    );
    done = Math.min(i + C, units.length);
    await log(`더빙 ${done}/${units.length} (${Math.round((done / units.length) * 100)}%)`);
  }

  // ★효과음은 자동 생성하지 않는다(사용자 지시). sfx 텍스트는 남겨두되 소리는 안 만든다.

  // 하나도 못 만들고 전부 목소리 미배정으로 스킵됐으면 → 조용히 넘기지 말고 명확히 알린다.
  if (ok === 0 && skipped > 0) {
    throw new Error(`목소리 미배정 — 캐스팅에서 캐릭터 목소리/나레이터를 먼저 지정하세요 (${skipped}줄 스킵)`);
  }

  // 저장 — 이번에 만진 씬의 '컷'만 교체(오디오·승격 반영). videoUrl 등 씬의 다른 필드는 최신 것을
  // 유지 → 병렬 비디오 결과를 안 지움. (비디오는 scene.videoUrl 을, 더빙은 scene.cut 을 쓴다.)
  const p2 = (await getProject(projectId)) ?? p;
  const touched = new Map(scenes.map((s) => [s.id, s.cut]));
  p2.scenes = (p2.scenes ?? []).map((fresh) =>
    touched.has(fresh.id) ? { ...fresh, cut: touched.get(fresh.id) } : fresh
  );
  await saveProject(p2);
  try {
    await recordCost({ projectId, vendor: "tts", model: "dub", costUsd: 0, meta: { kind: "dub", ok, skipped } });
  } catch {}
  await log(`더빙 완료: 생성 ${ok}개${skipped ? `, 목소리 미배정 스킵 ${skipped}개` : ""}`);
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
