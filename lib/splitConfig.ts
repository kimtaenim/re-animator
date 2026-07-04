// ============================================================================
// 컷 분할 설정 로더 (앱측) — config/split.json 을 타입으로 노출
// ----------------------------------------------------------------------------
// 워커도 같은 파일을 fs 로 읽는다(worker/detect.mjs). 파라미터를 코드가 아닌
// config 한 곳에 두어, 튜닝이 여러 파일 수정으로 번지지 않게 한다.
// ============================================================================

import raw from "../config/split.json";

export interface SplitConfig {
  refWidthMode: "first" | "max" | number;
  whiteThreshold: number;
  whiteRatioThreshold: number;
  minGapPx: number;
  minSceneHeightPx: number;
}

export const SPLIT_CONFIG: SplitConfig = {
  refWidthMode: (raw.refWidthMode as SplitConfig["refWidthMode"]) ?? "first",
  whiteThreshold: raw.whiteThreshold ?? 250,
  whiteRatioThreshold: raw.whiteRatioThreshold ?? 0.98,
  minGapPx: raw.minGapPx ?? 40,
  minSceneHeightPx: raw.minSceneHeightPx ?? 60,
};
