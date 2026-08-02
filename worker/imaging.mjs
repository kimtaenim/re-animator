// ============================================================================
// 이미지 연산 (sharp) — 프로파일 계산 + 컷 추출. sharp 의존은 전부 이 파일에.
// ----------------------------------------------------------------------------
// 스펙 §5.2: 파일을 한 번에 하나씩만 열어 행별 흰-비율(1차원 배열) → 메모리 안전.
// 추출은 걸친 파일들만 crop 후 세로 concat.
// ============================================================================

import sharp from "sharp";

// ★libvips 연산 캐시 끔 — 우리 워크로드는 매번 다른 버퍼를 디코드하므로 캐시 적중이 거의
//   없는데, 캐시가 직전 디코드 결과(대형 raw)를 붙들어 피크만 올린다. 실측(measure-split-memory)
//   383→368MB. compose/join 은 이 모듈을 로드하지 않으므로 영향 없음.
sharp.cache(false);

// 한 파일 → refWidth 정규화 후 그레이스케일 → 행별 "표준편차(평탄도)" 프로파일.
// std 가 낮으면 그 행은 거의 단색 → 흰/검/단색 배경 무관하게 거터 후보.
// (흰-비율 방식은 검은 거터를 못 잡아 오분할됨 — 색무관 평탄도로 대체.)
// 반환: { profile: Float32Array(정규화높이), normHeight }.
export async function computeRowProfile(buf, refWidth) {
  // sequentialRead: 행 스트리밍 디코드 — 원본 raw 전체를 출력과 동시에 들지 않는다(피크 절감).
  const { data, info } = await sharp(buf, { sequentialRead: true })
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
// ★기본 2 — 파일당 raw(refWidth×height×3)는 수십 MB 라 3장이면 상주 메모리가 크다(OOM 기여).
//   1 로 내리면 파일 경계를 걸친 컷마다 두 파일을 번갈아 evict/재디코드해 thrash 가 나므로,
//   '경계를 걸친 컷 하나를 thrash 없이 처리하는 최소값'인 2 가 하한이다.
const RAW_CACHE_MAX = Number(process.env.RAW_FILE_CACHE || 2);
// ★★개수 캡만으로는 메모리를 상한하지 못한다(OCR 병렬에서 이미 배운 교훈과 동일) —
//   파일 높이는 작품마다 10배씩 달라서, '2개'가 작은 파일이면 수십 MB 지만 통짜 원고
//   (한 회분이 파일 1~2개, 파일당 수만 px)면 파일 하나가 raw 100MB+ 라 2개 = 수백 MB 상주.
//   → 바이트 예산(RAW_CACHE_MB, 기본 160MB)을 함께 건다. 예산을 넘으면 오래된 것부터
//   방출하되, 지금 쓰는 1개는 반드시 남긴다(파일 하나가 예산보다 커도 동작은 해야 하므로).
//   비용: 통짜 원고에서 파일 경계를 걸친 컷(회분에 많아야 파일수-1개)만 재디코드.
const RAW_CACHE_BYTES = Number(process.env.RAW_CACHE_MB || 160) * 1024 * 1024;
let _rawStats = { files: 0, bytes: 0, decodes: 0 }; // 관측용(잡 진행 로그에 찍는다)
export function rawCacheStats() {
  return { ..._rawStats, mb: Math.round(_rawStats.bytes / 1048576) };
}
// ★캐시 즉시 비우기 — 실측(2026-08-02 분할 로그): 대사 읽기 준비가 다 끝난 뒤에도 raw
//   151MB 가 상주한 채 rss 501/512MB 로 벼랑 끝 통과. 더 쓸 일 없는 시점에 호출해 피크를
//   깎는다. 캐시일 뿐이라 이후 다시 필요하면 재디코드될 뿐, 정확성엔 영향 없음.
export function clearRawCache(fileBuffers) {
  const cache = _fileRawCache.get(fileBuffers);
  if (cache) cache.clear();
  _rawStats = { files: 0, bytes: 0, decodes: _rawStats.decodes };
}

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
  // ★방출은 디코드 '전에' — 실측(scripts/measure-split-memory.mjs)에서 피크는 상주 캐시와
  //   '통째 디코드 순간의 임시 버퍼(원본해상도+정규화 raw)'가 겹치는 순간이었다. 디코드 후에
  //   비우면 그 겹침이 이미 일어난 뒤라 예산이 피크를 못 깎는다(410→404MB 로 사실상 무효였음).
  //   메타데이터(헤더만 읽음, 싸다)로 새 raw 크기를 추정해, 자리를 먼저 비우고 디코드한다.
  const totalBytes = () => [...cache.values()].reduce((n, r) => n + r.data.length, 0);
  try {
    const meta = await sharp(fileBuffers[idx]).metadata();
    const estH = Math.round((meta.height ?? 0) * (canvas.refWidth / (meta.width || canvas.refWidth)));
    const estBytes = canvas.refWidth * Math.max(1, estH) * 3;
    while (cache.size > 0 && (cache.size >= RAW_CACHE_MAX || totalBytes() + estBytes > RAW_CACHE_BYTES)) {
      cache.delete(cache.keys().next().value); // 오래된 것 먼저 방출
    }
  } catch {}
  // sequentialRead: 입력 PNG 를 행 단위로 흘려 디코드 — 입력 전체 raw(원본폭×높이)를
  //   출력과 '동시에' 들고 있지 않게 한다(통짜 대형 파일에서 디코드 순간 피크의 절반).
  const { data, info } = await sharp(fileBuffers[idx], { sequentialRead: true })
    .resize({ width: canvas.refWidth })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rec = { data, width: info.width, height: info.height };
  cache.set(idx, rec);
  _rawStats.decodes++;
  // 안전망 — 추정이 빗나가도 예산 초과 상주는 남기지 않는다(지금 넣은 1개는 유지).
  while (cache.size > 1 && (cache.size > RAW_CACHE_MAX || totalBytes() > RAW_CACHE_BYTES)) {
    cache.delete(cache.keys().next().value);
  }
  _rawStats = { files: cache.size, bytes: totalBytes(), decodes: _rawStats.decodes };
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
