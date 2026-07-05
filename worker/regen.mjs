// ============================================================================
// M3 재생성 헬퍼 — 한 컷을 gpt-image-1(i2i)로 다시 그린다. 청크 병렬은 jobs.runRegen.
// ----------------------------------------------------------------------------
// 원본 컷 이미지 + 프롬프트(화풍 + 묘사 + 네거티브)로 images/edits 호출 → 새 이미지 b64.
// 캐릭터 레퍼런스(얼굴 일관성)는 다음 단계에서 추가.
// ============================================================================

import sharp from "sharp";

// gpt-image-1 대략 단가(품질별, 장당 USD 근사). 예측 가능하게 flat.
const IMAGE_COST = { low: 0.016, medium: 0.042, high: 0.167 };
const SIZE_WH = { "1024x1024": [1024, 1024], "1536x1024": [1536, 1024], "1024x1536": [1024, 1536] };
export const REGEN_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "medium";
export const REGEN_CONCURRENCY = Number(process.env.REGEN_CONCURRENCY || 4);
export const imageCostUsd = () => IMAGE_COST[REGEN_QUALITY] ?? 0.042;

// ★ 출력 크기는 컷 모양이 아니라 '프로젝트 목표 비율'로 고정 — 모든 컷이 같은 크기.
// 세로 긴 컷이 들어와도 가로(16:9)로 나온다. gpt-image-1 지원 크기 중 가장 가까운 것.
function pickSize(project) {
  const ar = project?.aspectRatio;
  if (ar === "9:16") return "1024x1536";
  if (ar === "1:1") return "1024x1024";
  return "1536x1024"; // 16:9(기본) = 가로 프레임
}
function frameDesc(project) {
  const ar = project?.aspectRatio;
  if (ar === "9:16") return "a tall vertical (portrait 9:16) frame";
  if (ar === "1:1") return "a square (1:1) frame";
  return "a wide horizontal (landscape, 16:9) frame";
}

// ★ 목적: 원화에 최대한 가깝게. 묘사 기반 재해석이 아니라 '충실 재현 + 글씨 제거 +
// 크기 맞춤'. 화풍 지정(stylePrompt)이 있을 때만 덧붙인다.
export function buildRegenPrompt(scene, project) {
  const cut = scene.cut ?? {};
  let p =
    "Reproduce this comic panel image faithfully. Keep the exact same artwork, characters, faces, poses, composition, colors and line style as the input — do not redraw, restyle, or reinterpret. " +
    "Remove ALL text: speech bubbles, letters, captions, numbers, sound-effect lettering, watermarks — and cleanly fill the area behind them to match the surrounding art. " +
    "Do not add anything new. Output only the clean illustration, adapted to fit the given canvas size.";
  // 아까 읽어낸 내용(사람이 편집 가능)을 참고로 다시 넣는다 — 그림에 충실한 선에서.
  const content = String(cut.description || cut.promptDraft || "").trim();
  if (content) p += ` Scene content (reference; stay faithful to the drawing): ${content}`;
  // ★ 목표 프레임을 꽉 채워라 — 컷 모양이 달라도 배경을 자연스럽게 확장해 채우되
  // 주요 인물·피사체는 왜곡 없이 충실히. 모든 출력이 같은 프레임 크기.
  p += ` Compose the result to completely fill ${frameDesc(project)}. If the source panel has a different shape (e.g. a tall vertical webtoon panel), naturally extend the background and setting to fill the whole frame — do NOT stretch, squash, or distort the subject; keep characters and drawing faithful, placed sensibly within the frame. Every output must share this exact same frame size.`;
  const style = String(project.stylePrompt || "").trim();
  if (style) p += ` Style note: ${style}.`;
  return p.slice(0, 1400);
}

// 원본 컷 이미지 버퍼 + 씬 → 재생성 이미지 b64 (+비용). 실패 시 throw.
export async function regenScene(scene, imgBuf, project, key, model) {
  const form = new FormData();
  form.append("model", model);
  form.append("image", new Blob([imgBuf], { type: "image/png" }), "cut.png");
  form.append("prompt", buildRegenPrompt(scene, project));
  form.append("size", pickSize(project));
  form.append("n", "1");
  form.append("quality", REGEN_QUALITY);
  const r = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const d = await r.json();
  const b64 = d.data?.[0]?.b64_json;
  if (!b64) throw new Error("빈 이미지 응답");
  return { b64, cost: imageCostUsd() };
}

// 마스크 재생성 — 원본 픽셀 보존 + [빈 공간 + 글씨 박스]만 채운다(원화 최대 충실).
// 목표 비율 캔버스에 컷을 contain 배치, 마스크 alpha 0=채움/255=보존. gpt-image-1 edits.
export async function regenSceneMasked(scene, imgBuf, project, key, model) {
  const size = pickSize(project);
  const [TW, TH] = SIZE_WH[size] || [1536, 1024];
  const meta = await sharp(imgBuf).metadata();
  const cw = meta.width || 1;
  const ch = meta.height || 1;
  const scale = Math.min(TW / cw, TH / ch);
  const pw = Math.max(1, Math.round(cw * scale));
  const ph = Math.max(1, Math.round(ch * scale));
  const px = Math.floor((TW - pw) / 2);
  const py = Math.floor((TH - ph) / 2);

  // 배치 이미지: 흰 캔버스에 컷 contain 합성.
  const cutResized = await sharp(imgBuf).resize(pw, ph, { fit: "fill" }).png().toBuffer();
  const composed = await sharp({
    create: { width: TW, height: TH, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: cutResized, left: px, top: py }])
    .png()
    .toBuffer();

  // 마스크(RGBA): alpha 0=채움, 255=보존. 기본 채움 → 컷영역 보존 → 글씨박스만 다시 채움.
  const mask = Buffer.alloc(TW * TH * 4, 0);
  const setAlpha = (x0, y0, x1, y1, a) => {
    const xa = Math.max(0, Math.floor(x0));
    const ya = Math.max(0, Math.floor(y0));
    const xb = Math.min(TW, Math.ceil(x1));
    const yb = Math.min(TH, Math.ceil(y1));
    for (let y = ya; y < yb; y++) {
      const row = y * TW;
      for (let x = xa; x < xb; x++) mask[(row + x) * 4 + 3] = a;
    }
  };
  setAlpha(px, py, px + pw, py + ph, 255); // 컷 영역 보존
  for (const b of scene.cut?.textBoxes ?? []) {
    setAlpha(px + b.left * pw, py + b.top * ph, px + b.right * pw, py + b.bottom * ph, 0); // 글씨 지움
  }
  const maskPng = await sharp(mask, { raw: { width: TW, height: TH, channels: 4 } }).png().toBuffer();

  const prompt =
    `Fill only the transparent (empty) areas of this image so the whole ${frameDesc(project)} is completely filled — naturally extend the background and setting to seamlessly match the surrounding artwork (no blank or black area). ` +
    "Where speech bubbles or lettering were, remove the text and fill with plausible background continuation. Keep all visible (opaque) artwork exactly as-is, faithful and unchanged. No text, letters, or watermark in the output.";

  const form = new FormData();
  form.append("model", model);
  form.append("image", new Blob([composed], { type: "image/png" }), "cut.png");
  form.append("mask", new Blob([maskPng], { type: "image/png" }), "mask.png");
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("n", "1");
  form.append("quality", REGEN_QUALITY);
  const r = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const d = await r.json();
  const b64 = d.data?.[0]?.b64_json;
  if (!b64) throw new Error("빈 이미지 응답");
  return { b64, cost: imageCostUsd() };
}
