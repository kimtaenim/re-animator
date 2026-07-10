// 자막 강조 마크업 — 대사/내레이션 안 [[강조할 말]] 을 렌더에서 크게·강조색으로.
// aninews 에서 이식. lib/emphasis.ts 와 동일 로직(둘을 항상 같이 수정).
// TTS·길이계산 경로는 stripMarks 로 마커를 떼고, 자막 렌더에서만 splitRuns 로 해석한다.

export const EMPH_OPEN = "[[";
export const EMPH_CLOSE = "]]";

export function stripMarks(s) {
  return (s ?? "").split(EMPH_OPEN).join("").split(EMPH_CLOSE).join("");
}

export function hasMarks(s) {
  return typeof s === "string" && (s.includes(EMPH_OPEN) || s.includes(EMPH_CLOSE));
}

// 문자열 → [{t, em}] 런 배열. 짝이 안 맞아도 관대하게(한쪽만 남은 경우 처리).
export function splitRuns(s) {
  let text = s ?? "";
  if (!text) return [];
  const fo = text.indexOf(EMPH_OPEN);
  const fc = text.indexOf(EMPH_CLOSE);
  if (fc >= 0 && (fo < 0 || fc < fo)) text = EMPH_OPEN + text;

  const runs = [];
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
