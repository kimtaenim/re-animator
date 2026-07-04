// ============================================================================
// 이미지 연산 (sharp) — 프로파일 계산 + 컷 추출. sharp 의존은 전부 이 파일에.
// ----------------------------------------------------------------------------
// 스펙 §5.2: 파일을 한 번에 하나씩만 열어 행별 흰-비율(1차원 배열) → 메모리 안전.
// 추출은 걸친 파일들만 crop 후 세로 concat.
// ============================================================================

import sharp from "sharp";

// 한 파일 → refWidth 로 정규화 후 그레이스케일 raw 픽셀 → 행별 흰-비율 프로파일.
// 반환: { profile: Float32Array(정규화높이), normHeight }.
export async function computeWhiteProfile(buf, refWidth, cfg) {
  const { data, info } = await sharp(buf)
    .resize({ width: refWidth }) // 폭 정규화(높이 비례). 기준폭 일치가 좌표계 통일의 핵심.
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width;
  const H = info.height;
  const thr = cfg.whiteThreshold;
  const profile = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let count = 0;
    for (let x = 0; x < W; x++) if (data[row + x] >= thr) count++;
    profile[y] = count / W;
  }
  return { profile, normHeight: H };
}

// 전역 정규화 [yStart, yEnd) 를 걸친 파일들에서 잘라 세로로 합쳐 PNG 버퍼로.
// canvas: { refWidth, offsets, normHeights }. fileBuffers: 파일 순서대로.
export async function extractRegion(canvas, fileBuffers, yStart, yEnd) {
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

  return sharp({
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
}
