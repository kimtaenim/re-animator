// ============================================================================
// 컷 경계 검출 (순수) — 앱(로컬 분할 API)용. worker/detect.mjs 와 동일 알고리즘.
// profile[y] = y행 표준편차(평탄도). 낮으면 거터. 거터 '사이'가 컷.
// ============================================================================

export interface SplitCfg {
  flatStdThreshold: number;
  minGapPx: number;
  minSceneHeightPx: number;
}

export function detectRegions(
  profile: Float32Array | number[],
  cfg: SplitCfg
): { yStart: number; yEnd: number }[] {
  const total = profile.length;
  const { flatStdThreshold, minGapPx, minSceneHeightPx } = cfg;
  const isGutter = (y: number) => profile[y] < flatStdThreshold;

  const gutters: [number, number][] = [];
  let s = -1;
  for (let y = 0; y <= total; y++) {
    const g = y < total && isGutter(y);
    if (g) {
      if (s === -1) s = y;
    } else if (s !== -1) {
      if (y - s >= minGapPx) gutters.push([s, y]);
      s = -1;
    }
  }

  const regions: { yStart: number; yEnd: number }[] = [];
  let cursor = 0;
  for (const [gs, ge] of gutters) {
    if (gs - cursor >= minSceneHeightPx) regions.push({ yStart: cursor, yEnd: gs });
    cursor = ge;
  }
  if (total - cursor >= minSceneHeightPx) regions.push({ yStart: cursor, yEnd: total });
  return regions;
}
