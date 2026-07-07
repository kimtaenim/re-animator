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

const DEFAULT_FONT_URL =
  process.env.SUBTITLE_FONT_URL ||
  "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf";
const FAMILY = "SubtitleKR";
// 디폴트: 글씨 작게 + 검은 바탕(거의 불투명) + 하얀 글씨. env 로 미세조정.
const FONT_FRAC = Number(process.env.SUBTITLE_FONT_FRAC || 0.2); // 띠 대비 글자 크기(작게)
const BG_ALPHA = Number(process.env.SUBTITLE_BG_ALPHA || 0.9); // 검은 바탕 불투명도

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

// 텍스트 폭에 맞춰 최대 2줄(넘치면 …)로 균형 줄바꿈.
function wrap(ctx, text, maxW, maxLines = 2) {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width <= maxW || !cur) cur = t;
    else {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (cur) lines.push(cur);
  // 마지막 줄이 넘치면 잘라서 …
  if (lines.length >= maxLines) {
    let last = lines[maxLines - 1] || "";
    while (last && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = (last || "").trimEnd() + "…";
    lines.length = maxLines;
  }
  return lines;
}

// text → 자막 PNG(frameW × bandH). 실패 시 null(자막 없이 진행).
export async function renderSubtitle(text, { frameW, bandH }) {
  const t = (text || "").trim();
  if (!t) return null;
  const mod = await loadCanvas();
  if (!mod) return null;
  const { createCanvas, GlobalFonts } = mod;
  if (!(await ensureFont(GlobalFonts))) return null;

  try {
    const canvas = createCanvas(frameW, bandH);
    const ctx = canvas.getContext("2d");
    const pad = Math.round(bandH * 0.14);
    const maxW = frameW - pad * 2 - Math.round(frameW * 0.06);
    let fontPx = Math.round(bandH * FONT_FRAC);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // 폰트 크기 낮춰가며 2줄 안에 맞춤.
    let lines;
    for (; fontPx >= 12; fontPx -= 2) {
      ctx.font = `700 ${fontPx}px ${FAMILY}, sans-serif`;
      lines = wrap(ctx, t, maxW, 2);
      const lineH = fontPx * 1.25;
      if (lines.length * lineH <= bandH - pad) break;
    }
    ctx.font = `700 ${fontPx}px ${FAMILY}, sans-serif`;
    const lineH = fontPx * 1.25;
    const totalH = lines.length * lineH;
    const cx = frameW / 2;
    let y = bandH / 2 - totalH / 2 + lineH / 2;

    // 반투명 어두운 띠(가독성) — 글자 폭에 맞춘 라운드 박스.
    const boxW = Math.min(
      frameW - pad,
      Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2
    );
    ctx.fillStyle = `rgba(0,0,0,${BG_ALPHA})`;
    const bx = cx - boxW / 2;
    const by = bandH / 2 - totalH / 2 - pad * 0.4;
    const bh = totalH + pad * 0.8;
    const r = Math.min(bandH * 0.18, 18);
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.arcTo(bx + boxW, by, bx + boxW, by + bh, r);
    ctx.arcTo(bx + boxW, by + bh, bx, by + bh, r);
    ctx.arcTo(bx, by + bh, bx, by, r);
    ctx.arcTo(bx, by, bx + boxW, by, r);
    ctx.closePath();
    ctx.fill();

    // 글자: 검은 외곽선 + 흰 채움.
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1, Math.round(fontPx * 0.1)); // 검은 바탕이라 외곽선 얇게
    ctx.strokeStyle = "rgba(0,0,0,0.95)";
    ctx.fillStyle = "#ffffff";
    for (const l of lines) {
      ctx.strokeText(l, cx, y);
      ctx.fillText(l, cx, y);
      y += lineH;
    }
    return canvas.toBuffer("image/png");
  } catch {
    return null;
  }
}
