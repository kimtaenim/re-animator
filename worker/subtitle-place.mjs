// ============================================================================
// 자막 배치 — "화면의 빈 곳"에 자막을 얹기 위한 위치 계산(렌더/폰트와 분리, 순수 로직).
//   A) pickSubtitleBand: 생성 이미지에서 가장 한산한(디테일 낮은) 가로 띠를 찾는다.
//   B) bubbleBoxPx: 말풍선 박스(0~1)를 frame px 로 — 대사를 원래 자리 근처에 얹을 때.
// compose 자막 굽기에서 이 위치에 반투명 띠 + 글자를 얹으면 그림을 덜 가린다.
// ============================================================================

import sharp from "sharp";

// A) 자막 넣기 좋은 가로 띠 { x, y, w, h }(frame px).
//   원칙(사용자 지정): ① 인물 얼굴을 가리지 말 것(최우선) ② 가능하면 손도 ③ 바닥·상단에
//   붙이지 말 것(가운데 영역에 띄움). 그 다음, 남는 후보 중 가장 한산한(디테일 낮은) 띠.
//   faces/hands = 0~1 정규화 박스 배열(worker/vision-boxes 로 감지). 없으면 디테일만으로.
const FACE_W = 9; // 얼굴 겹침 벌점(사실상 하드 회피)
const HAND_W = 2.5; // 손 겹침 벌점(소프트)
export async function pickSubtitleBand(
  imgBuf,
  { frameW, frameH, heightFrac = 0.16, faces = [], hands = [], edgeMarginFrac = 0.1 } = {}
) {
  const bandH = Math.max(1, Math.round(frameH * heightFrac));
  const SAMPLE_H = 120; // 세로 샘플 해상도(행별 대표값)
  const W = 16; // 가로는 좁게 — 행의 복잡도만 본다
  // 폴백: 바닥/상단이 아닌 하단 1/3쯤(가장자리 여백 안).
  const fallbackY = Math.max(0, Math.min(Math.round(frameH * 0.6), frameH - bandH));
  let g;
  try {
    g = await sharp(imgBuf).resize(W, SAMPLE_H, { fit: "fill" }).greyscale().raw().toBuffer();
  } catch {
    return { x: 0, y: fallbackY, w: frameW, h: bandH };
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
  // 벌점을 디테일과 같은 스케일로 맞춰(얼굴 벌점이 디테일보다 확실히 크게) 곱한다.
  const unit = avgBusy * winH + 1;

  // 자막은 가운데 정렬 → 화면 중앙에 걸친 얼굴/손일수록 실제로 가린다. 중앙성 가중.
  const boxPenalty = (y0, y1, boxes, weight) => {
    let pen = 0;
    for (const b of boxes) {
      const bt = b.top * SAMPLE_H;
      const bb = b.bottom * SAMPLE_H;
      const ov = Math.max(0, Math.min(y1, bb) - Math.max(y0, bt)); // 세로 겹침(샘플 행)
      if (ov <= 0) continue;
      const cx = (b.left + b.right) / 2;
      const central = Math.max(0, 1 - Math.abs(cx - 0.5) * 2); // 중앙=1, 가장자리=0
      pen += (ov / winH) * (0.5 + 0.5 * central) * weight;
    }
    return pen;
  };

  // 가장자리 여백: 이 범위 밖(상단/하단 붙는 위치)은 후보에서 뺀다.
  const margin = Math.round(SAMPLE_H * edgeMarginFrac);
  let loY = Math.min(margin, SAMPLE_H - winH);
  let hiY = Math.max(loY, SAMPLE_H - winH - margin);
  if (hiY < loY) {
    loY = 0;
    hiY = SAMPLE_H - winH;
  }

  let bestY = fallbackY / frameH * SAMPLE_H;
  let bestCost = Infinity;
  for (let y = loY; y <= hiY; y++) {
    let cost = pre[y + winH] - pre[y]; // 디테일(작을수록 빈 곳)
    cost += boxPenalty(y, y + winH, faces, FACE_W) * unit; // 얼굴 회피(하드)
    cost += boxPenalty(y, y + winH, hands, HAND_W) * unit; // 손 회피(소프트)
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
