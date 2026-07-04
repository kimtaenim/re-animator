// ============================================================================
// 컷 경계 검출 — 순수 알고리즘 (의존성 0: sharp·Redis·Blob 없음)
// ----------------------------------------------------------------------------
// ★ M1 최대 리스크. 튜닝은 config/split.json 값 + 이 파일 내부에서만. 시그니처
//   (detectRegions(profile, cfg) → [{yStart,yEnd}]) 는 고정 → 오케스트레이터/추출/
//   UI 어느 것도 이 파일을 고친다고 깨지지 않는다. 샘플 확보 후 cli.mjs 로 검증.
//
// 입력  profile: 전역 정규화 프로파일. profile[y] = y행의 표준편차(평탄도).
//        std 가 낮으면 그 행은 거의 단색 = 거터(흰/검/단색 배경 무관).
// 출력  regions: 컷별 { yStart(포함), yEnd(제외) }, 전역 정규화 y 좌표.
// ============================================================================

/**
 * @param {Float32Array|number[]} profile  전역 행-표준편차 프로파일 (길이 = totalHeight)
 * @param {{flatStdThreshold:number, minGapPx:number, minSceneHeightPx:number}} cfg
 * @returns {{yStart:number, yEnd:number}[]}
 */
export function detectRegions(profile, cfg) {
  const total = profile.length;
  const { flatStdThreshold, minGapPx, minSceneHeightPx } = cfg;
  // 거터 = 행이 거의 단색(표준편차 낮음). 색과 무관(흰/검/단색 배경).
  const isGutter = (y) => profile[y] < flatStdThreshold;

  // 1) 거터 런(연속 평탄 행, minGapPx 이상) 수집.
  const gutters = [];
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

  // 2) 거터 "사이"가 콘텐츠 구간 = 컷. 거터(위·아래 띠)는 컷에 포함하지 않는다
  //    → 각 컷은 패널 내용만 깔끔하게. 상·하단 바깥 여백도 자연히 제외됨.
  //    minSceneHeightPx 미만인 콘텐츠 조각(거터 노이즈)은 버린다.
  const regions = [];
  let cursor = 0;
  for (const [gs, ge] of gutters) {
    if (gs - cursor >= minSceneHeightPx) regions.push({ yStart: cursor, yEnd: gs });
    cursor = ge;
  }
  if (total - cursor >= minSceneHeightPx) regions.push({ yStart: cursor, yEnd: total });

  return regions;
}
