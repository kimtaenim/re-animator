// ============================================================================
// 자막 배치 — "화면의 빈 곳"에 자막을 얹기 위한 위치 계산(렌더/폰트와 분리, 순수 로직).
//   A) pickSubtitleBand: 생성 이미지에서 가장 한산한(디테일 낮은) 가로 띠를 찾는다.
//   B) bubbleBoxPx: 말풍선 박스(0~1)를 frame px 로 — 대사를 원래 자리 근처에 얹을 때.
// compose 자막 굽기에서 이 위치에 반투명 띠 + 글자를 얹으면 그림을 덜 가린다.
// ============================================================================

import sharp from "sharp";

// A) 자막 넣기 좋은 가로 띠 { x, y, w, h }(frame px). 이미지를 작게 축소해 '행별 밝기 분산'
// (디테일)을 재고, 자막 높이만큼의 창을 슬라이드해 분산합이 최소인(가장 빈) 위치를 고른다.
// preferBottom: 하단을 선호(자막이 매 컷 튀지 않게) — 하단이 확실히 바쁠 때만 위로 이동.
export async function pickSubtitleBand(
  imgBuf,
  { frameW, frameH, heightFrac = 0.16, preferBottom = true } = {}
) {
  const bandH = Math.max(1, Math.round(frameH * heightFrac));
  const SAMPLE_H = 120; // 세로 샘플 해상도(행별 대표값)
  const W = 16; // 가로는 좁게 — 행의 복잡도만 본다
  let g;
  try {
    g = await sharp(imgBuf).resize(W, SAMPLE_H, { fit: "fill" }).greyscale().raw().toBuffer();
  } catch {
    // 분석 실패 시 안전 폴백: 하단.
    return { x: 0, y: Math.max(0, frameH - bandH), w: frameW, h: bandH };
  }

  // 행별 분산(디테일). 복잡한 그림일수록 큼.
  const rowBusy = new Array(SAMPLE_H).fill(0);
  for (let y = 0; y < SAMPLE_H; y++) {
    let sum = 0;
    let sum2 = 0;
    for (let x = 0; x < W; x++) {
      const v = g[y * W + x];
      sum += v;
      sum2 += v * v;
    }
    const mean = sum / W;
    rowBusy[y] = sum2 / W - mean * mean;
  }

  const winH = Math.max(1, Math.round(SAMPLE_H * heightFrac));
  const pre = new Array(SAMPLE_H + 1).fill(0);
  for (let y = 0; y < SAMPLE_H; y++) pre[y + 1] = pre[y] + rowBusy[y];
  const avgBusy = pre[SAMPLE_H] / SAMPLE_H;

  let bestY = SAMPLE_H - winH;
  let bestCost = Infinity;
  for (let y = 0; y <= SAMPLE_H - winH; y++) {
    let cost = pre[y + winH] - pre[y]; // 이 띠의 디테일 총합(작을수록 빈 곳)
    if (preferBottom) {
      const distFromBottom = (SAMPLE_H - winH - y) / (SAMPLE_H - winH || 1); // 0=하단,1=상단
      cost += distFromBottom * avgBusy * winH * 0.6; // 하단 선호 바이어스
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestY = y;
    }
  }

  const y = Math.round((bestY / SAMPLE_H) * frameH);
  return { x: 0, y: Math.max(0, Math.min(y, frameH - bandH)), w: frameW, h: bandH };
}

// B) 말풍선 박스(0~1 정규화) → frame px 박스. bubbles[].box 를 그대로 자막 자리로.
export function bubbleBoxPx(box, frameW, frameH) {
  if (!box) return null;
  const cl = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  const left = cl(box.left) * frameW;
  const top = cl(box.top) * frameH;
  const right = cl(box.right) * frameW;
  const bottom = cl(box.bottom) * frameH;
  if (right <= left || bottom <= top) return null;
  return {
    x: Math.round(left),
    y: Math.round(top),
    w: Math.round(right - left),
    h: Math.round(bottom - top),
  };
}
