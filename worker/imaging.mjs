// ============================================================================
// 이미지 연산 (sharp) — 프로파일 계산 + 컷 추출. sharp 의존은 전부 이 파일에.
// ----------------------------------------------------------------------------
// 스펙 §5.2: 파일을 한 번에 하나씩만 열어 행별 흰-비율(1차원 배열) → 메모리 안전.
// 추출은 걸친 파일들만 crop 후 세로 concat.
// ============================================================================

import sharp from "sharp";

// 한 파일 → refWidth 정규화 후 그레이스케일 → 행별 "표준편차(평탄도)" 프로파일.
// std 가 낮으면 그 행은 거의 단색 → 흰/검/단색 배경 무관하게 거터 후보.
// (흰-비율 방식은 검은 거터를 못 잡아 오분할됨 — 색무관 평탄도로 대체.)
// 반환: { profile: Float32Array(정규화높이), normHeight }.
export async function computeRowProfile(buf, refWidth) {
  const { data, info } = await sharp(buf)
    .resize({ width: refWidth }) // 폭 정규화(높이 비례). 기준폭 일치가 좌표계 통일의 핵심.
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width;
  const H = info.height;
  const profile = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let sum = 0;
    let sum2 = 0;
    for (let x = 0; x < W; x++) {
      const v = data[row + x];
      sum += v;
      sum2 += v * v;
    }
    const mean = sum / W;
    profile[y] = Math.sqrt(Math.max(0, sum2 / W - mean * mean));
  }
  return { profile, normHeight: H };
}

// 각 열의 표준편차 → 좌우 균일 여백(검은/흰 옆 띠) 트림 범위 {xStart,xEnd}.
// 세로 컷과 같은 원리(균일=여백)를 열에 적용. 패널만 남긴다.
export async function computeSideCrop(regionPng, flatStd = 10) {
  const { data, info } = await sharp(regionPng)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const colStd = (x) => {
    let sum = 0;
    let sum2 = 0;
    for (let y = 0; y < H; y++) {
      const v = data[y * W + x];
      sum += v;
      sum2 += v * v;
    }
    const m = sum / H;
    return Math.sqrt(Math.max(0, sum2 / H - m * m));
  };
  let xStart = 0;
  while (xStart < W && colStd(xStart) < flatStd) xStart++;
  let xEnd = W;
  while (xEnd > xStart && colStd(xEnd - 1) < flatStd) xEnd--;
  if (xEnd - xStart < 20) return { xStart: 0, xEnd: W }; // 거의 다 균일 → 크롭 안 함
  return { xStart, xEnd };
}

// 박스 PNG의 4변에서 "내용 없는 여백"을 트림 → 그려진 내용에 딱 맞게.
// 판정: '그려진 경계'(인접 픽셀 밝기 급변)의 개수. 단색·그라데이션 배경은 급변이
// 없어(부드러움) 트림되고, 그림 선(급변 많음)은 내용으로 남는다. std 방식과 달리
// 세로/가로 그라데이션 여백도 잡는다. 반환: 박스 내부 오프셋 { top, bottom, left, right }.
export async function trimBox(png) {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const STRONG = 12; // 인접 픽셀 밝기 차 ≥ 이 값이면 '그려진 경계'(부드러운 배경은 미달)
  const MINR = Math.max(4, Math.round(H * 0.02)); // 열이 내용이려면 이만큼 행에서 경계 필요
  const MINC = Math.max(4, Math.round(W * 0.02)); // 행이 내용이려면 이만큼 열에서 경계 필요
  const colContent = (x) => {
    let c = 0;
    for (let y = 1; y < H; y++) {
      if (Math.abs(data[y * W + x] - data[(y - 1) * W + x]) > STRONG && ++c >= MINR) return true;
    }
    return false;
  };
  const rowContent = (y) => {
    let c = 0;
    const o = y * W;
    for (let x = 1; x < W; x++) {
      if (Math.abs(data[o + x] - data[o + x - 1]) > STRONG && ++c >= MINC) return true;
    }
    return false;
  };
  let top = 0;
  while (top < H && !rowContent(top)) top++;
  let bottom = H;
  while (bottom > top && !rowContent(bottom - 1)) bottom--;
  let left = 0;
  while (left < W && !colContent(left)) left++;
  let right = W;
  while (right > left && !colContent(right - 1)) right--;
  if (bottom - top < 30 || right - left < 30) return { top: 0, bottom: H, left: 0, right: W };
  return { top, bottom, left, right };
}

// 소스들을 refWidth 로 정규화한 '가상 캔버스'의 RGB 원시 픽셀로 1회만 펼쳐 캐시.
// 컷 추출은 이 버퍼에서 잘라내는 memcpy — 컷마다 원본을 재디코드/인코드하지 않는다
// (수십~수백 컷에서 sharp 재처리가 병목이었음). fileBuffers 배열이 GC 되면 캐시도 해제.
const _rawCanvas = new WeakMap();
async function rawCanvasFor(canvas, fileBuffers) {
  const cached = _rawCanvas.get(fileBuffers);
  if (cached && cached.refWidth === canvas.refWidth) return cached;
  const { refWidth, totalHeight, offsets } = canvas;
  const data = Buffer.alloc(refWidth * totalHeight * 3, 255); // 빈 곳(파일 사이 등)은 흰색
  const rowBytes = refWidth * 3;
  for (let i = 0; i < fileBuffers.length; i++) {
    const { data: raw, info } = await sharp(fileBuffers[i])
      .resize({ width: refWidth })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const startRow = Math.round(offsets[i]);
    const maxRows = Math.min(info.height, totalHeight - startRow);
    for (let r = 0; r < maxRows; r++) {
      raw.copy(data, (startRow + r) * rowBytes, r * rowBytes, r * rowBytes + rowBytes);
    }
  }
  const rc = { data, refWidth, totalHeight };
  _rawCanvas.set(fileBuffers, rc);
  return rc;
}

// 전역 정규화 [yStart, yEnd) × [xStart, xEnd) 를 잘라 PNG 버퍼로. 원시 캔버스에서 memcpy.
export async function extractRegion(canvas, fileBuffers, yStart, yEnd, xStart, xEnd) {
  const { refWidth, totalHeight } = canvas;
  const y0 = Math.max(0, Math.min(totalHeight, Math.round(yStart)));
  const y1 = Math.max(y0 + 1, Math.min(totalHeight, Math.round(yEnd)));
  const h = y1 - y0;
  const hasX =
    xStart != null && xEnd != null && (xStart > 0 || xEnd < refWidth) && xEnd - xStart >= 1;
  const x0 = hasX ? Math.max(0, Math.round(xStart)) : 0;
  const x1 = hasX ? Math.min(refWidth, Math.round(xEnd)) : refWidth;
  const w = Math.max(1, x1 - x0);

  const rc = await rawCanvasFor(canvas, fileBuffers);
  const srcRow = refWidth * 3;
  const outRow = w * 3;
  const out = Buffer.alloc(outRow * h);
  for (let r = 0; r < h; r++) {
    const srcOff = (y0 + r) * srcRow + x0 * 3;
    rc.data.copy(out, r * outRow, srcOff, srcOff + outRow);
  }
  return sharp(out, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
}
