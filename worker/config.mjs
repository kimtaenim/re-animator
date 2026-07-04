// ============================================================================
// 분할 설정 로더 (워커측) — 앱과 같은 config/split.json 을 fs 로 읽는다.
// 앱(lib/splitConfig.ts)과 값이 갈리지 않도록 단일 파일을 공유한다.
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function loadSplitConfig() {
  const path = fileURLToPath(new URL("../config/split.json", import.meta.url));
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    refWidthMode: raw.refWidthMode ?? "first",
    flatStdThreshold: raw.flatStdThreshold ?? 10,
    minGapPx: raw.minGapPx ?? 40,
    minSceneHeightPx: raw.minSceneHeightPx ?? 60,
  };
}
