// ============================================================================
// 자막 렌더 — 텍스트 → PNG(흰 글자 + 검은 외곽선 + 반투명 어두운 띠). aninews 스타일.
// ----------------------------------------------------------------------------
// @napi-rs/canvas(optional) + 한글 폰트. 폰트는 순서대로: SUBTITLE_FONT_PATH →
// 번들(worker/fonts/*.otf|ttf) → 런타임 다운로드(SUBTITLE_FONT_URL). 다 실패하면
// null 반환 → 합성은 자막 없이 정상 진행(robust). node 런타임엔 시스템 폰트가 없다.
// ============================================================================

import { writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { splitRuns } from "./emphasis.mjs";

// 강조([[..]]) 어절은 이 색으로 1.3배 크게. env 로 조정.
const EM_COLOR = process.env.SUBTITLE_EM_COLOR || "#ffd23f";

const DEFAULT_FONT_URL =
  process.env.SUBTITLE_FONT_URL ||
  "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf";
const FAMILY = "SubtitleKR";
// 디폴트: 글씨 작게 + 검은 바탕(거의 불투명) + 하얀 글씨. env 로 미세조정.
const FONT_FRAC = Number(process.env.SUBTITLE_FONT_FRAC || 0.2); // 띠 대비 글자 크기(작게)
const BG_ALPHA = Number(process.env.SUBTITLE_BG_ALPHA || 0.6); // 검은 바탕 불투명도(반투명)

let _canvas = null; // { createCanvas, GlobalFonts } | false(불가)
let _fontReady = false;
let _fontOk = false;

async function loadCanvas() {
  if (_canvas !== null) return _canvas;
  try {
    _canvas = await import("@napi-rs/canvas");
  } catch {
    _canvas = false; // 미설치 → 자막 skip
  }
  return _canvas;
}

// ★캔버스 재사용(aninews 방식) — 캡션마다 새 캔버스(≈수 MB)를 만들면 메모리 churn 으로
//   워커가 OOM 난다. 워커는 한 번에 하나씩 렌더하므로 하나를 지워가며 재사용해도 안전.
let _reuse = null;
function getReuseCanvas(createCanvas, W, H) {
  if (!_reuse || _reuse.width !== W || _reuse.height !== H) _reuse = createCanvas(W, H);
  const ctx = _reuse.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  return { canvas: _reuse, ctx };
}

async function ensureFont(GlobalFonts) {
  if (_fontReady) return _fontOk;
  _fontReady = true;
  // 1) 명시 경로
  const envPath = process.env.SUBTITLE_FONT_PATH;
  if (envPath && existsSync(envPath)) {
    try {
      GlobalFonts.registerFromPath(envPath, FAMILY);
      _fontOk = true;
      return true;
    } catch {}
  }
  // 2) 번들 worker/fonts/*
  try {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "fonts");
    if (existsSync(dir)) {
      const f = (await readdir(dir)).find((n) => /\.(otf|ttf|ttc)$/i.test(n));
      if (f) {
        GlobalFonts.registerFromPath(join(dir, f), FAMILY);
        _fontOk = true;
        return true;
      }
    }
  } catch {}
  // 3) 런타임 다운로드(캐시)
  try {
    const cache = join(tmpdir(), "reanimator-fonts");
    await mkdir(cache, { recursive: true });
    const dest = join(cache, "subtitle.ttf");
    if (!existsSync(dest)) {
      const r = await fetch(DEFAULT_FONT_URL, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`font ${r.status}`);
      await writeFile(dest, Buffer.from(await r.arrayBuffer()));
    }
    GlobalFonts.registerFromPath(dest, FAMILY);
    _fontOk = true;
    return true;
  } catch {
    _fontOk = false;
    return false;
  }
}

// 직접 넣은 줄바꿈(\n)은 하드 브레이크로 존중하고, 각 줄은 폭에 맞춰 다시 감싼다.
// maxLines 초과 시 마지막 줄에 …. (자막=대사+내레이션, 사용자가 칸에서 Enter 로 줄 나눔)
function wrap(ctx, text, maxW, maxLines = 4) {
  const hard = String(text || "").replace(/\r/g, "").split("\n");
  const out = [];
  let truncated = false;
  for (const seg of hard) {
    if (out.length >= maxLines) {
      truncated = true;
      break;
    }
    const words = seg.replace(/[ \t]+/g, " ").trim().split(" ").filter(Boolean);
    if (!words.length) {
      out.push(""); // 빈 줄 유지
      continue;
    }
    let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (ctx.measureText(t).width <= maxW || !cur) cur = t;
      else {
        out.push(cur);
        cur = w;
        if (out.length >= maxLines) {
          truncated = true;
          break;
        }
      }
    }
    if (out.length >= maxLines) {
      if (cur) truncated = true;
      break;
    }
    if (cur) out.push(cur);
  }
  while (out.length && out[out.length - 1] === "") out.pop(); // 끝 빈 줄 정리
  if (truncated && out.length) {
    let last = out[out.length - 1];
    while (last && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
    out[out.length - 1] = last.trimEnd() + "…";
  }
  return out.length ? out : [""];
}

// 강조 런([{t,em}])을 반영한 그리디 줄바꿈. 각 줄 = { segs:[{t,em,w}], width, size }.
// 문자마다 자기 폰트(base/em)로 측정하고, 넘치면 공백에서 끊는다(공백 없으면 글자 단위).
function wrapRuns(ctx, runs, maxW, baseF, emF, size, emSize, maxLines) {
  const chars = [];
  for (const r of runs) {
    const norm = (r.t ?? "").replace(/\s+/g, " ");
    for (const c of norm) chars.push({ c, em: !!r.em });
  }
  while (chars.length && chars[0].c === " ") chars.shift();
  while (chars.length && chars[chars.length - 1].c === " ") chars.pop();
  if (!chars.length) return [];
  const widthOf = (arr) => {
    let w = 0;
    let i = 0;
    while (i < arr.length) {
      const em = arr[i].em;
      let s = "";
      while (i < arr.length && arr[i].em === em) { s += arr[i].c; i++; }
      ctx.font = em ? emF : baseF;
      w += ctx.measureText(s).width;
    }
    return w;
  };
  const rawLines = [];
  let cur = [];
  for (const ch of chars) {
    if (cur.length === 0 && ch.c === " ") continue;
    if (cur.length === 0 || widthOf(cur.concat(ch)) <= maxW) { cur.push(ch); continue; }
    if (ch.c === " ") { rawLines.push(cur); cur = []; continue; }
    let sp = -1;
    for (let k = cur.length - 1; k >= 0; k--) if (cur[k].c === " ") { sp = k; break; }
    if (sp > 0) { rawLines.push(cur.slice(0, sp)); cur = cur.slice(sp + 1); cur.push(ch); }
    else { rawLines.push(cur); cur = [ch]; }
  }
  if (cur.length) rawLines.push(cur);
  return rawLines.slice(0, maxLines).map((arr) => {
    while (arr.length && arr[arr.length - 1].c === " ") arr.pop();
    const segs = [];
    let i = 0;
    let anyEm = false;
    while (i < arr.length) {
      const em = arr[i].em;
      let s = "";
      while (i < arr.length && arr[i].em === em) { s += arr[i].c; i++; }
      ctx.font = em ? emF : baseF;
      segs.push({ t: s, em, w: ctx.measureText(s).width });
      if (em) anyEm = true;
    }
    const width = segs.reduce((a, b) => a + b.w, 0);
    return { segs, width, size: anyEm ? Math.max(size, emSize) : size };
  });
}

// 수동 줄바꿈(\n)을 하드 브레이크로 존중하며 각 줄을 강조-런 줄바꿈.
function layoutLines(ctx, raw, maxW, baseF, emF, size, emSize, maxLines) {
  const hard = String(raw).replace(/\r/g, "").split("\n");
  let out = [];
  for (const seg of hard) {
    if (out.length >= maxLines) break;
    const runs = splitRuns(seg);
    if (!runs.length) continue;
    out = out.concat(wrapRuns(ctx, runs, maxW, baseF, emF, size, emSize, maxLines - out.length));
  }
  return out.slice(0, maxLines);
}

// 한 유닛(자막 조각)을 [top, top+boxH] 영역에 검은 박스 + 흰 글자(+[[강조]]는 크게·강조색)로.
function drawBox(ctx, text, { frameW, top, boxH }) {
  const raw = (text || "").trim();
  if (!raw) return;
  const pad = Math.round(boxH * 0.14);
  const maxW = frameW - pad * 2 - Math.round(frameW * 0.06);
  const cx = frameW / 2;

  // 폰트 크기 낮춰가며 boxH 안에 맞춤(강조어는 1.3배라 줄 높이 반영).
  let fontPx = Math.max(12, Math.round(boxH * FONT_FRAC));
  let lines = [];
  let lineHs = [];
  let totalH = 0;
  for (; fontPx >= 12; fontPx -= 2) {
    const emSize = Math.round(fontPx * 1.3);
    const baseF = `700 ${fontPx}px ${FAMILY}, sans-serif`;
    const emF = `800 ${emSize}px ${FAMILY}, sans-serif`;
    lines = layoutLines(ctx, raw, maxW, baseF, emF, fontPx, emSize, 3);
    lineHs = lines.map((l) => Math.round(l.size * 1.3));
    totalH = lineHs.reduce((a, b) => a + b, 0);
    if (totalH <= boxH - pad) break;
  }
  if (!lines.length) return;
  const emSize = Math.round(fontPx * 1.3);
  const baseF = `700 ${fontPx}px ${FAMILY}, sans-serif`;
  const emF = `800 ${emSize}px ${FAMILY}, sans-serif`;

  // 검은 박스(글자 폭에 맞춤).
  const textW = Math.max(...lines.map((l) => l.width), 0);
  const boxW = Math.min(frameW - pad, Math.round(textW + pad * 2));
  const midY = top + boxH / 2;
  const bx = cx - boxW / 2;
  const by = midY - totalH / 2 - pad * 0.4;
  const bh = totalH + pad * 0.8;
  const r = Math.min(boxH * 0.18, 18);
  ctx.fillStyle = `rgba(0,0,0,${BG_ALPHA})`;
  ctx.beginPath();
  ctx.moveTo(bx + r, by);
  ctx.arcTo(bx + boxW, by, bx + boxW, by + bh, r);
  ctx.arcTo(bx + boxW, by + bh, bx, by + bh, r);
  ctx.arcTo(bx, by + bh, bx, by, r);
  ctx.arcTo(bx, by, bx + boxW, by, r);
  ctx.closePath();
  ctx.fill();

  // 글자 — 세그먼트별 폰트/색(강조는 크게·강조색). left 정렬로 이어 그린다.
  ctx.lineJoin = "round";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  let yTop = midY - totalH / 2;
  lines.forEach((l, i) => {
    const baseline = yTop + Math.round(l.size * 0.8);
    let tx = cx - l.width / 2;
    for (const seg of l.segs) {
      const sz = seg.em ? emSize : fontPx;
      ctx.font = seg.em ? emF : baseF;
      ctx.lineWidth = Math.max(1, Math.round(sz * 0.1));
      ctx.strokeStyle = "rgba(0,0,0,0.95)";
      ctx.strokeText(seg.t, tx, baseline);
      ctx.fillStyle = seg.em ? EM_COLOR : "#ffffff";
      ctx.fillText(seg.t, tx, baseline);
      tx += seg.w;
    }
    yTop += lineHs[i];
  });
}

// input = 자막 문자열 또는 ★유닛 배열★(각 유닛 = 별개 박스). 여러 유닛은 세로로 겹치지 않게 쌓는다.
// → 별개 대사/내레이션이 별개 박스로 나가고, 서로 지워지지 않는다. 실패 시 null.
export async function renderSubtitle(input, { frameW, bandH }) {
  const units = (Array.isArray(input) ? input : [input]).map((s) => (s || "").trim()).filter(Boolean);
  if (!units.length) return null;
  const mod = await loadCanvas();
  if (!mod) return null;
  const { createCanvas, GlobalFonts } = mod;
  if (!(await ensureFont(GlobalFonts))) return null;
  try {
    const canvas = createCanvas(frameW, bandH);
    const ctx = canvas.getContext("2d");
    const GAP = units.length > 1 ? Math.round(bandH * 0.06) : 0;
    const boxH = Math.floor((bandH - GAP * (units.length - 1)) / units.length);
    let top = 0;
    for (const u of units) {
      drawBox(ctx, u, { frameW, top, boxH });
      top += boxH + GAP;
    }
    return canvas.toBuffer("image/png");
  } catch {
    return null;
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ★한 자막 유닛을 '박스 크기' PNG 로 + 프레임 내 좌표(x,y) 반환 — 합성이 overlay=x:y 로 얹는다.
//   전체 프레임(720×1280≈3.7MB/프레임) 대신 박스(≈0.4MB)만 오버레이 체인에 흐르게 해서
//   ffmpeg 피크 메모리를 실측 ~100MB 절감(596→494MB). 디자인·레이아웃은 기존과 동일.
export async function renderCaptionBox(text, { W, H, cy, cx }) {
  const raw = (text || "").trim();
  if (!raw) return null;
  const mod = await loadCanvas();
  if (!mod) return null;
  const { createCanvas, GlobalFonts } = mod;
  if (!(await ensureFont(GlobalFonts))) return null;
  try {
    // 측정용 미니 캔버스(글자 폭 재기) → 박스 크기 확정 → 박스 크기 캔버스에 그림.
    const mctx = createCanvas(8, 8).getContext("2d");
    const maxW = Math.round(W * 0.9);
    const fontPx = Math.max(20, Math.round(H * 0.04)); // 프레임 높이 비례(기존과 동일)
    const emSize = Math.round(fontPx * 1.3);
    const baseF = `700 ${fontPx}px ${FAMILY}, sans-serif`;
    const emF = `800 ${emSize}px ${FAMILY}, sans-serif`;
    const padX = Math.round(fontPx * 0.5);
    const padY = Math.round(fontPx * 0.35);
    const lines = layoutLines(mctx, raw, maxW - padX * 2, baseF, emF, fontPx, emSize, 3);
    if (!lines.length) return null;
    const lineHs = lines.map((l) => Math.round(l.size * 1.3));
    const totalH = lineHs.reduce((a, b) => a + b, 0);
    const textW = Math.max(...lines.map((l) => l.width), 0);
    const boxW = Math.min(maxW, Math.round(textW + padX * 2));
    const boxH = Math.round(totalH + padY * 2);

    const cv = createCanvas(boxW, boxH);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = `rgba(0,0,0,${BG_ALPHA})`;
    roundRectPath(ctx, 0, 0, boxW, boxH, Math.min(fontPx * 0.4, 20));
    ctx.fill();
    ctx.lineJoin = "round";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    let yTop = padY;
    lines.forEach((l, i) => {
      const baseline = yTop + Math.round(l.size * 0.8);
      let tx = boxW / 2 - l.width / 2;
      for (const seg of l.segs) {
        const sz = seg.em ? emSize : fontPx;
        ctx.font = seg.em ? emF : baseF;
        ctx.lineWidth = Math.max(2, Math.round(sz * 0.12));
        ctx.strokeStyle = "rgba(0,0,0,0.9)";
        ctx.strokeText(seg.t, tx, baseline);
        ctx.fillStyle = seg.em ? EM_COLOR : "#ffffff";
        ctx.fillText(seg.t, tx, baseline);
        tx += seg.w;
      }
      yTop += lineHs[i];
    });

    // 프레임 내 좌표 — 가로/세로 중심(cx,cy) 기준, 가장자리 밖으로 안 나가게 clamp.
    const wantCx = typeof cx === "number" && isFinite(cx) ? cx : W / 2;
    const marginX = Math.round(W * 0.03);
    const marginY = Math.round(H * 0.02);
    const x = Math.max(marginX, Math.min(Math.round(wantCx - boxW / 2), W - marginX - boxW));
    const y = Math.max(marginY, Math.min(Math.round(cy - boxH / 2), H - marginY - boxH));
    return { buf: cv.toBuffer("image/png"), x, y };
  } catch {
    return null;
  }
}

// (레거시) 한 자막 유닛을 '전체 프레임(W×H) 투명 PNG'로 — overlay=0:0 용. 실패 시 null.
export async function renderCaptionPng(text, { W, H, cy, cx }) {
  const raw = (text || "").trim();
  if (!raw) return null;
  const mod = await loadCanvas();
  if (!mod) return null;
  const { createCanvas, GlobalFonts } = mod;
  if (!(await ensureFont(GlobalFonts))) return null;
  try {
    const { canvas, ctx } = getReuseCanvas(createCanvas, W, H);
    const maxW = Math.round(W * 0.9);
    const fontPx = Math.max(20, Math.round(H * 0.04)); // 프레임 높이 비례
    const emSize = Math.round(fontPx * 1.3);
    const baseF = `700 ${fontPx}px ${FAMILY}, sans-serif`;
    const emF = `800 ${emSize}px ${FAMILY}, sans-serif`;
    const padX = Math.round(fontPx * 0.5);
    const padY = Math.round(fontPx * 0.35);
    const lines = layoutLines(ctx, raw, maxW - padX * 2, baseF, emF, fontPx, emSize, 3);
    if (!lines.length) return null;
    const lineHs = lines.map((l) => Math.round(l.size * 1.3));
    const totalH = lineHs.reduce((a, b) => a + b, 0);
    const textW = Math.max(...lines.map((l) => l.width), 0);
    const boxW = Math.min(maxW, Math.round(textW + padX * 2));
    const boxH = Math.round(totalH + padY * 2);
    // 가로 중심 cx(px) — 좌/우 지정 시 프레임 밖으로 안 나가게 여백 안으로 clamp.
    const wantCx = typeof cx === "number" && isFinite(cx) ? cx : W / 2;
    const marginX = Math.round(W * 0.03);
    const bx = Math.max(marginX, Math.min(Math.round(wantCx - boxW / 2), W - marginX - boxW));
    const usedCx = bx + boxW / 2;
    const by = Math.round(cy - boxH / 2);
    // 반투명 검은 박스.
    ctx.fillStyle = `rgba(0,0,0,${BG_ALPHA})`;
    roundRectPath(ctx, bx, by, boxW, boxH, Math.min(fontPx * 0.4, 20));
    ctx.fill();
    // 글자(세그먼트별 폰트/색 — 강조는 크게·강조색).
    ctx.lineJoin = "round";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    let yTop = by + padY;
    lines.forEach((l, i) => {
      const baseline = yTop + Math.round(l.size * 0.8);
      let tx = usedCx - l.width / 2;
      for (const seg of l.segs) {
        const sz = seg.em ? emSize : fontPx;
        ctx.font = seg.em ? emF : baseF;
        ctx.lineWidth = Math.max(2, Math.round(sz * 0.12));
        ctx.strokeStyle = "rgba(0,0,0,0.9)";
        ctx.strokeText(seg.t, tx, baseline);
        ctx.fillStyle = seg.em ? EM_COLOR : "#ffffff";
        ctx.fillText(seg.t, tx, baseline);
        tx += seg.w;
      }
      yTop += lineHs[i];
    });
    return canvas.toBuffer("image/png");
  } catch {
    return null;
  }
}
