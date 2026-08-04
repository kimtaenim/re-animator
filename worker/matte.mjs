// ============================================================================
// 인물 매트(알파) 생성 — 계층 B(버티고 달리줌·패럴랙스)를 실제로 굽기 위한 전제.
// ----------------------------------------------------------------------------
// 계층 B 는 인물과 배경을 서로 다른 궤적으로 움직인다. 그러려면 "어디까지가 인물인가"를
// 알아야 하고, 그게 매트(흰=인물, 검정=배경인 회색조 PNG)다.
//
// ★자체 학습·정교한 세그멘테이션을 만들지 않는다(사용자 지침: 얼굴 크롭 때와 같은 실용주의).
//   이미 쓰고 있는 fal 에 배경 제거 모델이 있으므로 그걸로 컷 이미지의 알파를 얻고,
//   알파 채널만 뽑아 회색조 매트로 저장한다. 실패하면 그 컷만 매트 없이 스킵된다(전체 중단 없음).
//
// 모델은 env 로 교체 가능(FAL_MODEL_MATTE). 기본은 배경 제거 결과가 RGBA 로 오는 모델.
//   input  { image_url }
//   output { image: { url } }  또는 { images: [{ url }] }
// ============================================================================

import sharp from "sharp";

const FAL_MATTE = process.env.FAL_MODEL_MATTE || "fal-ai/birefnet/v2";
export const MATTE_COST = Number(process.env.FAL_MATTE_COST || 0.01);

/**
 * 컷 이미지에서 인물 매트(회색조 PNG)를 만든다.
 * @param {string} imageUrl 공개 URL(컷 이미지)
 * @param {string} key FAL_KEY
 * @param {(m:string)=>void} [onLog]
 * @returns {Promise<{ buf: Buffer, cost: number }>} buf = 흰(인물)/검정(배경) PNG
 */
export async function generateMatte(imageUrl, key, onLog) {
  if (!key) throw new Error("FAL_KEY 없음 — 매트(인물 분리)를 만들 수 없습니다");
  if (!imageUrl) throw new Error("매트를 만들 이미지가 없습니다");

  const r = await fetch(`https://fal.run/${FAL_MATTE}`, {
    method: "POST",
    headers: { authorization: `Key ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl }),
    signal: AbortSignal.timeout(120_000), // 워커는 한 번에 한 잡 — 외부 호출엔 항상 타임아웃
  });
  if (!r.ok) throw new Error(`fal 매트 ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const d = await r.json();
  const url = d.image?.url || d.images?.[0]?.url || d.output?.image?.url;
  if (!url) throw new Error(`fal 매트 빈 응답: ${JSON.stringify(d).slice(0, 160)}`);

  const ir = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!ir.ok) throw new Error(`매트 다운로드 실패 ${ir.status}`);
  const cut = Buffer.from(await ir.arrayBuffer());

  // 배경이 지워진 RGBA → 알파 채널만 뽑아 회색조 매트로. 알파가 없으면(모델이 이미 마스크를
  // 돌려준 경우) 그대로 회색조 변환해서 쓴다.
  const meta = await sharp(cut).metadata();
  const buf = meta.hasAlpha
    ? await sharp(cut).ensureAlpha().extractChannel("alpha").toColourspace("b-w").png().toBuffer()
    : await sharp(cut).toColourspace("b-w").png().toBuffer();

  onLog?.(`인물 매트 생성(${meta.width}x${meta.height}, ${meta.hasAlpha ? "알파" : "회색조"} 기준)`);
  return { buf, cost: MATTE_COST };
}

// ── 클린 플레이트(인물을 지운 배경판) — 계층 B 의 배경 레이어용(사용자 결정 2026-08-03) ──
// 예전 계층 B 는 배경 레이어로 '인물이 든 원본 프레임'을 그대로 써서, 배경이 움직이면
// 그 안의 인물 복사본이 같이 움직여 화면이 이중으로 겹쳐 보였다(사용자: "배경이 겹쳐 나온다").
// 인물 자리를 인페인팅으로 지운 배경판을 컷당 1회 만들어 배경 레이어로 쓰면 겹침이 원천 차단된다.
//
// 마스크 = 인물 매트를 '넓힌' 것(blur→threshold ≒ 팽창) — 머리카락·외곽 잔상까지 확실히 지운다.
// 프롬프트는 배경 재구성만 지시(동작·사물 예시를 넣지 않는다 — 모델이 그대로 그리는 사고 방지).
const PLATE_PROMPT =
  "Remove every person and character completely. Reconstruct only the background scenery behind them, " +
  "seamlessly continuing the surrounding artwork in the exact same style, colors and lighting. " +
  "No people, no characters, no figures, no text.";
export const PLATE_COST = Number(process.env.FAL_IMAGE_COST || 0.05);

import { falFillRaw } from "./fal.mjs";

/**
 * 인물 매트 → 인페인팅용 '사각 박스' 마스크(흰=지울 영역).
 * ★실루엣 모양 마스크를 쓰면 인페인팅 모델이 마스크 윤곽에서 사람 형태를 읽어 실루엣을
 *   다시 그린다(사용자 실측: "인물 분리했는데 실루엣이 그대로 남아 있다"). 인물의 바운딩
 *   박스를 여유 있게 잡은 '사각형' 마스크는 모양 힌트가 없어 배경 재구성이 깨끗하다.
 * @param {Buffer} matteBuf 인물 매트(흰=인물) PNG
 * @returns {Promise<{ maskBuf: Buffer, box: {left:number,top:number,width:number,height:number} }>}
 */
export async function matteToBoxMask(matteBuf) {
  const meta = await sharp(matteBuf).metadata();
  const W = meta.width, H = meta.height;
  if (!W || !H) throw new Error("매트 크기를 읽지 못했습니다");
  // 저해상 스캔(가로 200px)으로 흰 픽셀 바운딩 박스를 찾는다 — 픽셀 연산 비용 고정(OOM 무관).
  const SCAN_W = 200;
  const scanH = Math.max(1, Math.round((H / W) * SCAN_W));
  const { data, info } = await sharp(matteBuf).toColourspace("b-w").resize(SCAN_W, scanH, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("매트에 인물 영역이 없습니다(빈 매트)");
  const sx = W / info.width, sy = H / info.height;
  // 원본 좌표 + 여유(각 변 10%, 최소 16px) — 머리카락·그림자 잔상까지 확실히 포함.
  const mw = Math.max(16, Math.round((maxX - minX + 1) * sx * 0.1));
  const mh = Math.max(16, Math.round((maxY - minY + 1) * sy * 0.1));
  const left = Math.max(0, Math.round(minX * sx) - mw);
  const top = Math.max(0, Math.round(minY * sy) - mh);
  const right = Math.min(W, Math.round((maxX + 1) * sx) + mw);
  const bottom = Math.min(H, Math.round((maxY + 1) * sy) + mh);
  const bw = Math.max(1, right - left), bh = Math.max(1, bottom - top);
  const rect = await sharp({ create: { width: bw, height: bh, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const maskBuf = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: rect, left, top }])
    .png()
    .toBuffer();
  return { maskBuf, box: { left, top, width: bw, height: bh } };
}

/**
 * 컷 이미지 + 인물 매트 → 인물을 지운 배경판(PNG).
 * @param {string} imageUrl 공개 URL(컷 이미지 — 매트를 만든 그 이미지여야 좌표가 맞는다)
 * @param {Buffer} matteBuf 인물 매트(흰=인물) PNG
 * @param {string} key FAL_KEY
 * @param {(m:string)=>void} [onLog]
 * @returns {Promise<{ buf: Buffer, cost: number }>}
 */
export async function generateCleanPlate(imageUrl, matteBuf, key, onLog) {
  if (!key) throw new Error("FAL_KEY 없음 — 클린 플레이트(배경판)를 만들 수 없습니다");
  if (!imageUrl) throw new Error("배경판을 만들 이미지가 없습니다");
  const ir = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
  if (!ir.ok) throw new Error(`컷 이미지 다운로드 실패 ${ir.status}`);
  const imageBuf = Buffer.from(await ir.arrayBuffer());

  // ★실루엣 모양 마스크 금지 — 바운딩 박스 마스크로(위 matteToBoxMask 주석 참조).
  const { maskBuf, box } = await matteToBoxMask(matteBuf);
  const { buf, cost } = await falFillRaw(imageBuf, maskBuf, PLATE_PROMPT, key);
  onLog?.(`클린 플레이트 생성(박스 ${box.width}x${box.height} 인페인팅)`);
  return { buf, cost };
}
