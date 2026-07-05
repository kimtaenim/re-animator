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

// VLM 컷 검출 프롬프트(config/prompts.json). 하드코딩 금지 — 여기서만 튜닝.
export function loadPrompts() {
  const path = fileURLToPath(new URL("../config/prompts.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

// 만화 컷 온톨로지(config/ontology.json). 타입·textKind·스키마. 앱/워커 공통.
export function loadOntology() {
  const path = fileURLToPath(new URL("../config/ontology.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}
