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

// 박스 PNG의 4변에서 "평탄한 여백"(검은/흰/단색/그라데이션)을 트림 → 그려진 내용에 딱 맞게.
// 반환: 박스 내부 오프셋 { top, bottom, left, right }.
export async function trimBox(png, flatStd = 11) {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const rowStd = (y) => {
    let s = 0;
    let s2 = 0;
    const o = y * W;
    for (let x = 0; x < W; x++) {
      const v = data[o + x];
      s += v;
      s2 += v * v;
    }
    const m = s / W;
    return Math.sqrt(Math.max(0, s2 / W - m * m));
  };
  const colStd = (x) => {
    let s = 0;
    let s2 = 0;
    for (let y = 0; y < H; y++) {
      const v = data[y * W + x];
      s += v;
      s2 += v * v;
    }
    const m = s / H;
    return Math.sqrt(Math.max(0, s2 / H - m * m));
  };
  let top = 0;
  while (top < H && rowStd(top) < flatStd) top++;
  let bottom = H;
  while (bottom > top && rowStd(bottom - 1) < flatStd) bottom--;
  let left = 0;
  while (left < W && colStd(left) < flatStd) left++;
  let right = W;
  while (right > left && colStd(right - 1) < flatStd) right--;
  if (bottom - top < 30 || right - left < 30) return { top: 0, bottom: H, left: 0, right: W };
  return { top, bottom, left, right };
}

// 전역 정규화 [yStart, yEnd) 를 걸친 파일들에서 잘라 세로로 합쳐 PNG 버퍼로.
// xStart/xEnd 주면 좌우도 크롭. canvas: { refWidth, offsets, normHeights }.
export async function extractRegion(canvas, fileBuffers, yStart, yEnd, xStart, xEnd) {
  const { refWidth, offsets, normHeights } = canvas;
  const height = Math.max(1, Math.round(yEnd - yStart));
  const pieces = [];

  for (let i = 0; i < fileBuffers.length; i++) {
    const top = offsets[i];
    const bottom = offsets[i] + normHeights[i];
    const s = Math.max(yStart, top);
    const e = Math.min(yEnd, bottom);
    if (e <= s) continue; // 이 파일은 구간에 안 걸침

    // refWidth 로 정규화한 실제 버퍼(높이 반올림 오차 흡수를 위해 info 로 클램프).
    const { data, info } = await sharp(fileBuffers[i])
      .resize({ width: refWidth })
      .png()
      .toBuffer({ resolveWithObject: true });

    const localTop = Math.min(Math.round(s - top), Math.max(0, info.height - 1));
    const sliceH = Math.min(Math.round(e - s), info.height - localTop);
    if (sliceH <= 0) continue;

    const slice = await sharp(data)
      .extract({ left: 0, top: localTop, width: info.width, height: sliceH })
      .png()
      .toBuffer();

    pieces.push({ input: slice, left: 0, top: Math.round(s - yStart) });
  }

  const full = await sharp({
    create: {
      width: refWidth,
      height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(pieces)
    .png()
    .toBuffer();

  // 좌우 크롭 적용(주어졌고 유효할 때만).
  if (
    xStart != null &&
    xEnd != null &&
    (xStart > 0 || xEnd < refWidth) &&
    xEnd - xStart >= 1
  ) {
    const left = Math.max(0, Math.round(xStart));
    const w = Math.min(refWidth - left, Math.max(1, Math.round(xEnd - xStart)));
    return sharp(full).extract({ left, top: 0, width: w, height }).png().toBuffer();
  }
  return full;
}
