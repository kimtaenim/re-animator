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

// ★ 메모리 안전: 소스 전체를 하나의 거대한 raw 캔버스로 펼치지 않는다(100장이면 수백 MB
// 단일 할당 → OOM). 대신 파일별 raw(refWidth 정규화)를 작은 LRU 캐시(기본 3장)에만 두고,
// 컷 추출은 그 컷이 걸치는 파일만 디코드해서 잘라낸다 → 파일 수와 무관하게 메모리 상한.
const _fileRawCache = new WeakMap(); // fileBuffers → Map<idx, {data,width,height}> (LRU)
const RAW_CACHE_MAX = Number(process.env.RAW_FILE_CACHE || 3);

async function fileRawAt(canvas, fileBuffers, idx) {
  let cache = _fileRawCache.get(fileBuffers);
  if (!cache) {
    cache = new Map();
    _fileRawCache.set(fileBuffers, cache);
  }
  const hit = cache.get(idx);
  if (hit) {
    cache.delete(idx); // LRU: 최근 사용을 맨 뒤로
    cache.set(idx, hit);
    return hit;
  }
  const { data, info } = await sharp(fileBuffers[idx])
    .resize({ width: canvas.refWidth })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rec = { data, width: info.width, height: info.height };
  cache.set(idx, rec);
  while (cache.size > RAW_CACHE_MAX) cache.delete(cache.keys().next().value); // 오래된 것 방출
  return rec;
}

// 전역 정규화 [yStart, yEnd) × [xStart, xEnd) 를 잘라 PNG 버퍼로. 걸친 소스 파일만 디코드.
// maxH(선택): 결과 세로 상한. 구간이 이보다 크면 세로로 정수 스텝 다운샘플해 버퍼·PNG·후속
//   픽셀분석 메모리를 상한(먹통 방지). 미지정이면 기존과 동일(전 해상도). 반환 png 실제 높이는
//   메타데이터로 확인 가능(호출측이 좌표 되돌릴 때 사용).
export async function extractRegion(canvas, fileBuffers, yStart, yEnd, xStart, xEnd, maxH) {
  const { refWidth, totalHeight, offsets } = canvas;
  const y0 = Math.max(0, Math.min(totalHeight, Math.round(yStart)));
  const y1 = Math.max(y0 + 1, Math.min(totalHeight, Math.round(yEnd)));
  const h = y1 - y0;
  const hasX =
    xStart != null && xEnd != null && (xStart > 0 || xEnd < refWidth) && xEnd - xStart >= 1;
  const x0 = hasX ? Math.max(0, Math.round(xStart)) : 0;
  const x1 = hasX ? Math.min(refWidth, Math.round(xEnd)) : refWidth;
  const w = Math.max(1, x1 - x0);

  const step = maxH && h > maxH ? Math.ceil(h / maxH) : 1; // 세로 다운샘플 스텝(1=그대로)
  const outH = Math.max(1, Math.ceil(h / step));
  const outRow = w * 3;
  const out = Buffer.alloc(outRow * outH, 255); // 파일 사이 빈 곳은 흰색
  for (let i = 0; i < fileBuffers.length; i++) {
    const fStart = Math.round(offsets[i]);
    const fEnd = i + 1 < offsets.length ? Math.round(offsets[i + 1]) : totalHeight;
    if (fEnd <= y0 || fStart >= y1) continue; // 이 컷과 안 겹치는 파일은 디코드도 안 함
    const rec = await fileRawAt(canvas, fileBuffers, i);
    const srcRow = rec.width * 3;
    const gTop = Math.max(y0, fStart);
    const gBot = Math.min(y1, fStart + rec.height);
    for (let gy = gTop; gy < gBot; gy++) {
      const rel = gy - y0;
      if (step > 1 && rel % step !== 0) continue; // 다운샘플: step 마다 한 줄만
      const outY = step > 1 ? rel / step : rel;
      if (outY >= outH) continue;
      const srcOff = (gy - fStart) * srcRow + x0 * 3;
      rec.data.copy(out, outY * outRow, srcOff, srcOff + outRow);
    }
  }
  return sharp(out, { raw: { width: w, height: outH, channels: 3 } })
    .png()
    .toBuffer();
}
