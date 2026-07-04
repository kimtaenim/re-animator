// ============================================================================
// 가상 캔버스 구성 — 순수 (offsets 테이블). 워커에서 프로파일 계산 후 조립.
// ============================================================================

// 기준폭 결정. mode: 'first' | 'max' | number.
export function pickRefWidth(widths, mode) {
  if (typeof mode === "number" && mode > 0) return Math.round(mode);
  if (mode === "max") return Math.max(...widths);
  return widths[0]; // 'first'
}

// 정규화 높이 배열 → offsets(누적 시작 y) + totalHeight.
export function buildCanvas(refWidth, normHeights) {
  const offsets = [];
  let acc = 0;
  for (const h of normHeights) {
    offsets.push(acc);
    acc += h;
  }
  return { refWidth, totalHeight: acc, offsets, normHeights };
}
