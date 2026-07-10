// ============================================================================
// 자막 강조 마크업 — 대사/내레이션 안에서 [[강조할 말]] 로 감싸면 그 조각만 크게·강조색.
// aninews 에서 이식. worker/emphasis.mjs 와 동일 로직(둘을 항상 같이 수정).
// 자막 소스는 TTS·길이계산 소스이기도 해서, 그 경로에선 stripMarks 로 마커를 떼고,
// 렌더(자막)에서만 splitRuns 로 해석한다.
// ============================================================================

export const EMPH_OPEN = "[[";
export const EMPH_CLOSE = "]]";

// 마커 제거(음성·길이계산용). 짝이 안 맞아도 남은 마커까지 모두 제거한다.
export function stripMarks(s: string): string {
  return (s ?? "").split(EMPH_OPEN).join("").split(EMPH_CLOSE).join("");
}

export function hasMarks(s: string): boolean {
  return typeof s === "string" && (s.includes(EMPH_OPEN) || s.includes(EMPH_CLOSE));
}

export interface Run {
  t: string;
  em: boolean;
}

// 한 문자열 → 런(run) 배열. [[..]] 안은 em:true. 마커 한쪽만 남아도 관대하게 처리.
export function splitRuns(s: string): Run[] {
  let text = s ?? "";
  if (!text) return [];
  const fo = text.indexOf(EMPH_OPEN);
  const fc = text.indexOf(EMPH_CLOSE);
  if (fc >= 0 && (fo < 0 || fc < fo)) text = EMPH_OPEN + text;

  const runs: Run[] = [];
  let buf = "";
  let em = false;
  let i = 0;
  const flush = () => {
    if (buf) runs.push({ t: buf, em });
    buf = "";
  };
  while (i < text.length) {
    if (!em && text.startsWith(EMPH_OPEN, i)) {
      flush();
      em = true;
      i += 2;
      continue;
    }
    if (em && text.startsWith(EMPH_CLOSE, i)) {
      flush();
      em = false;
      i += 2;
      continue;
    }
    if (!em && text.startsWith(EMPH_CLOSE, i)) {
      i += 2;
      continue;
    }
    if (em && text.startsWith(EMPH_OPEN, i)) {
      i += 2;
      continue;
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return runs;
}

// ── 단어 클릭식 강조 UI 지원 ──────────────────────────────────────────────────
// 문자열 ↔ 단어 토큰. 클릭으로 강조를 토글하면 그 자리에 [[ ]] 를 넣거나 뺀다.
// 공백(줄바꿈 포함)은 그대로 보존한다.
export interface WordToken {
  text: string;
  em: boolean;
  space: boolean; // 공백 토큰(버튼 아님)
}

export function wordTokens(s: string): WordToken[] {
  const runs = splitRuns(s ?? "");
  const toks: WordToken[] = [];
  for (const r of runs) {
    for (const p of r.t.split(/(\s+)/)) {
      if (p === "") continue;
      toks.push({ text: p, em: r.em, space: /^\s+$/.test(p) });
    }
  }
  return toks;
}

function serializeTokens(toks: WordToken[]): string {
  let res = "";
  let open = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.space) {
      if (open) {
        let j = i + 1;
        while (j < toks.length && toks[j].space) j++;
        const nextEm = j < toks.length && toks[j].em;
        if (!nextEm) {
          res += "]]";
          open = false;
        }
      }
      res += t.text;
    } else {
      if (t.em && !open) {
        res += "[[";
        open = true;
      }
      if (!t.em && open) {
        res += "]]";
        open = false;
      }
      res += t.text;
    }
  }
  if (open) res += "]]";
  return res;
}

// 한 단어 토큰의 강조를 토글해 새 문자열을 돌려준다.
export function toggleWordEmphasis(s: string, tokenIndex: number): string {
  const toks = wordTokens(s);
  if (tokenIndex < 0 || tokenIndex >= toks.length || toks[tokenIndex].space) return s;
  toks[tokenIndex] = { ...toks[tokenIndex], em: !toks[tokenIndex].em };
  return serializeTokens(toks);
}
