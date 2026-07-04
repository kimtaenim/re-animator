// ============================================================================
// 가상 캔버스 — 읽기측 좌표 변환 (앱 UI 전용, 순수 함수)
// ----------------------------------------------------------------------------
// 캔버스 "구성"(offsets 계산)은 워커가 이미지를 열어서 한다(worker/canvas.mjs).
// 여기(앱)는 워커가 저장한 VirtualCanvas 를 읽어 G1 오버레이 좌표를 계산만 한다.
// 이미지·sharp 의존 0 → 순수/테스트 가능. 알고리즘(워커)과 완전히 분리된 경계.
// ============================================================================

import type { VirtualCanvas } from "./types";

// 전역 정규화 y → (파일 인덱스, 파일 내 로컬 y). offsets 이진 탐색.
export function globalToLocal(
  canvas: VirtualCanvas,
  globalY: number
): { fileIndex: number; localY: number } {
  const { offsets, normHeights } = canvas;
  const y = clamp(globalY, 0, canvas.totalHeight);
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  const localY = Math.min(y - offsets[lo], normHeights[lo]);
  return { fileIndex: lo, localY };
}

// 전역 정규화 y → G1 축소 렌더에서의 화면 y (스케일 팩터 적용).
export function globalToScreen(globalY: number, scale: number): number {
  return globalY * scale;
}

export function screenToGlobal(screenY: number, scale: number): number {
  return screenY / scale;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
