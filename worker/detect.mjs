// ============================================================================
// 컷 경계 검출 — 순수 알고리즘 (의존성 0: sharp·Redis·Blob 없음)
// ----------------------------------------------------------------------------
// ★ M1 최대 리스크. 튜닝은 config/split.json 값 + 이 파일 내부에서만. 시그니처
//   (detectRegions(profile, cfg) → [{yStart,yEnd}]) 는 고정 → 오케스트레이터/추출/
//   UI 어느 것도 이 파일을 고친다고 깨지지 않는다. 샘플 확보 후 cli.mjs 로 검증.
//
// 입력  profile: 전역 정규화 프로파일. profile[y] = y행의 near-white 픽셀 비율(0~1).
// 출력  regions: 컷별 { yStart(포함), yEnd(제외) }, 전역 정규화 y 좌표.
// ============================================================================

/**
 * @param {Float32Array|number[]} profile  전역 흰-비율 프로파일 (길이 = totalHeight)
 * @param {{whiteRatioThreshold:number, minGapPx:number, minSceneHeightPx:number}} cfg
 * @returns {{yStart:number, yEnd:number}[]}
 */
export function detectRegions(profile, cfg) {
  const total = profile.length;
  const { whiteRatioThreshold, minGapPx, minSceneHeightPx } = cfg;

  // 1) 콘텐츠 범위 — 상하단 바깥 여백(전역 margin)은 컷 대상이 아니다.
  const contentStart = firstNonWhite(profile, whiteRatioThreshold);
  if (contentStart === -1) return []; // 전부 여백 = 콘텐츠 없음
  const contentEnd = lastNonWhite(profile, whiteRatioThreshold) + 1; // 제외 경계

  // 2) 콘텐츠 내부의 여백 런(연속 흰 행) 중 minGapPx 이상 → 컷 사이 거터로 판정.
  const boundaries = [];
  let runStart = -1;
  for (let y = contentStart; y <= contentEnd; y++) {
    const white = y < contentEnd && profile[y] >= whiteRatioThreshold;
    if (white) {
      if (runStart === -1) runStart = y;
    } else if (runStart !== -1) {
      const runLen = y - runStart;
      // 콘텐츠 내부(양끝이 콘텐츠에 닿는) 런만 거터. 길이 충족 시 중앙을 경계로.
      if (runLen >= minGapPx && runStart > contentStart && y < contentEnd) {
        boundaries.push(Math.floor((runStart + y) / 2));
      }
      runStart = -1;
    }
  }

  // 3) 경계로 [contentStart, contentEnd] 를 조각낸다.
  const cuts = [contentStart, ...boundaries, contentEnd];
  let regions = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    regions.push({ yStart: cuts[i], yEnd: cuts[i + 1] });
  }

  // 4) 너무 짧은 조각은 인접 컷에 흡수(자잘한 오분할 방지).
  regions = absorbTiny(regions, minSceneHeightPx);
  return regions;
}

function firstNonWhite(profile, thr) {
  for (let y = 0; y < profile.length; y++) if (profile[y] < thr) return y;
  return -1;
}

function lastNonWhite(profile, thr) {
  for (let y = profile.length - 1; y >= 0; y--) if (profile[y] < thr) return y;
  return -1;
}

// minHeight 미만 조각을 이전(없으면 다음) 조각에 병합.
function absorbTiny(regions, minHeight) {
  if (regions.length <= 1) return regions;
  const out = [];
  for (const r of regions) {
    const h = r.yEnd - r.yStart;
    if (h < minHeight && out.length > 0) {
      out[out.length - 1].yEnd = r.yEnd; // 이전에 흡수
    } else {
      out.push({ ...r });
    }
  }
  // 첫 조각이 짧아 흡수 못 했으면 다음과 병합.
  if (out.length >= 2 && out[0].yEnd - out[0].yStart < minHeight) {
    out[1].yStart = out[0].yStart;
    out.shift();
  }
  return out;
}
