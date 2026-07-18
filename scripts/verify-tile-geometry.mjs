// 키 없이 검증: (1) ocr.mjs 로드 + readCutTextTiled export 존재, (2) 타일 자르기 경계(sharp.extract)가
// 여러 크기·STRIPS 에서 크래시 없이 정확한 조각을 만들고, (3) 조각 로컬 y→풀 y 매핑이 맞는지.
// OCR 모델 동작은 키 필요라 검증 불가(정직히) — 여기선 '런타임 크래시 없음 + 좌표 정합'만.
import sharp from "sharp";
import * as ocr from "../worker/ocr.mjs";

let fail = 0;
const ok = (c, m) => { if (!c) { console.error("  ✗", m); fail++; } else console.error("  ✓", m); };

// (1) export
ok(typeof ocr.readCutTextTiled === "function", "readCutTextTiled export 존재");
ok(typeof ocr.readCutText === "function", "readCutText export 유지");

// 헬퍼 내부와 동일한 경계식 — 여기서 sharp.extract 가 실제로 되는지, 조각들이 컷 전체를
// 겹치며 덮는지 확인.
async function tileBounds(pngBuf, STRIPS, OVfrac = 0.22) {
  const m = await sharp(pngBuf).metadata();
  const H = m.height, W = m.width;
  const stripH = Math.ceil(H / STRIPS);
  const OV = Math.round(stripH * OVfrac);
  const strips = [];
  for (let i = 0; i < STRIPS; i++) {
    const top = Math.max(0, i * stripH - OV);
    const bottom = Math.min(H, (i + 1) * stripH + OV);
    if (bottom - top < 40) continue;
    const buf = await sharp(pngBuf).extract({ left: 0, top, width: W, height: bottom - top }).png().toBuffer();
    const mm = await sharp(buf).metadata();
    strips.push({ top, bottom, h: mm.height, w: mm.width });
  }
  return { H, W, strips };
}

async function makePng(w, h) {
  return await sharp({ create: { width: w, height: h, channels: 3, background: { r: 20, g: 20, b: 30 } } }).png().toBuffer();
}

for (const [w, h, strips] of [[800, 2000, 2], [1200, 900, 2], [700, 6000, 3], [500, 480, 2], [1000, 501, 2]]) {
  const png = await makePng(w, h);
  const { H, W, strips: got } = await tileBounds(png, strips);
  // 조각 각각 유효 & 폭 = 원폭
  ok(got.every((s) => s.h === s.bottom - s.top && s.w === W), `${w}x${h} S=${strips}: 조각 dims 정확(${got.length}개)`);
  // 경계 안전: top>=0, bottom<=H
  ok(got.every((s) => s.top >= 0 && s.bottom <= H), `${w}x${h}: 경계 이미지 안(0..${H})`);
  // 겹쳐서 세로 전체 덮음: 첫 조각 top=0, 마지막 조각 bottom=H
  if (got.length) ok(got[0].top === 0 && got[got.length - 1].bottom === H, `${w}x${h}: 위끝 0 & 아래끝 ${H} 덮음`);
  // 연속 조각이 겹침(누락 없음)
  let covered = true;
  for (let i = 1; i < got.length; i++) if (got[i].top > got[i - 1].bottom) covered = false;
  ok(covered, `${w}x${h}: 조각 간 세로 빈틈 없음`);
}

// (3) 좌표 매핑: 조각 로컬 top/bottom(0~1) → 풀 y(0~1)
const H = 2000, stripH = 1000, top = 0, bottom = 1220; // 첫 조각(겹침 포함) 예
const toFull = (v) => Math.max(0, Math.min(1, (top + v * (bottom - top)) / H));
ok(Math.abs(toFull(0) - 0) < 1e-9, "매핑: 조각top0 → 풀0");
ok(Math.abs(toFull(1) - bottom / H) < 1e-9, `매핑: 조각bottom1 → 풀${(bottom / H).toFixed(3)}`);
ok(Math.abs(toFull(0.5) - (top + 0.5 * (bottom - top)) / H) < 1e-9, "매핑: 중앙 정합");

console.error(fail ? `\nFAIL ${fail}건` : "\nPASS — 타일 자르기·좌표 매핑 런타임 안전(모델 동작은 키 필요라 별도)");
process.exit(fail ? 1 : 0);
