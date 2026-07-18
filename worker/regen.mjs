// ============================================================================
// M3 재생성 헬퍼 — 한 컷을 이미지 모델(gpt-image-2 기본, i2i)로 다시 그린다. 청크 병렬은 jobs.runRegen.
// ----------------------------------------------------------------------------
// 원본 컷 이미지 + 프롬프트(화풍 + 묘사 + 네거티브)로 images/edits 호출 → 새 이미지 b64.
// 캐릭터 레퍼런스(얼굴 일관성)는 다음 단계에서 추가.
// ============================================================================

import sharp from "sharp";

// gpt-image 대략 단가(품질별, 장당 USD 근사). 예측 가능하게 flat.
const IMAGE_COST = { low: 0.016, medium: 0.042, high: 0.167 };
export const REGEN_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "medium";
// ★기본 6 → 2: 메모리 빡빡한 Render 워커에서 동시 재생성 이미지 버퍼가 겹쳐 OOM 먹통(3에서도
//   재발, 실측). 마스크·새로그리기 공용. 피크 메모리 = 이 수 × 컷당 버퍼. env 로 상향 가능.
export const REGEN_CONCURRENCY = Number(process.env.REGEN_CONCURRENCY || 2);
export const imageCostUsd = () => IMAGE_COST[REGEN_QUALITY] ?? 0.042;

// ★ 요청 크기(px) — 모델 인식형. gpt-image-2 는 임의 해상도(가로·세로 16 배수)를 받으므로
// '진짜' 목표 비율(exactSize) 그대로 요청 → 크롭 없이 정확한 비율. gpt-image-1 은 3종(1024/
// 1536)만 지원하므로 가장 가까운 걸 요청하고, 출력은 fitBuffer 로 정확한 비율로 크롭한다.
// 어느 쪽이든 최종 출력(normalizeSize/fitBuffer)은 exactSize 로 통일 → 모든 컷 같은 크기.
export function reqSize(project, model) {
  if (typeof model === "string" && model.startsWith("gpt-image-1")) {
    const ar = project?.aspectRatio;
    if (ar === "9:16") return [1024, 1536];
    if (ar === "1:1") return [1024, 1024];
    return [1536, 1024]; // 16:9
  }
  return exactSize(project); // gpt-image-2(기본) · fal: 진짜 비율(16 배수)
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
  p += ` Compose the result to completely fill ${frameDesc(project)}, edge to edge. If the source panel has a different shape (e.g. a tall vertical webtoon panel), naturally extend the background and setting to fill the whole frame — do NOT stretch, squash, or distort the subject; keep characters and drawing faithful, placed sensibly within the frame. There must be NO black bars, white space, empty margins, borders, vignette, or gradient fade at any edge — the entire frame is finished illustration. Every output must share this exact same frame size.`;
  const style = String(project.stylePrompt || "").trim();
  if (style) p += ` Style note: ${style}.`;
  return p.slice(0, 1400);
}

// 프로젝트 비율의 '정확한' 최종 크기(gpt-image-1 3종 크기와 별개 — 진짜 16:9 등).
export function exactSize(project) {
  const ar = project?.aspectRatio;
  if (ar === "9:16") return [864, 1536];
  if (ar === "1:1") return [1024, 1024];
  return [1536, 864]; // 16:9
}
// 아무 이미지 버퍼든 목표 비율·크기로 크롭(fit cover) → 모든 컷/모든 모델 출력 일관.
export async function fitBuffer(buf, project) {
  const [TW, TH] = exactSize(project);
  return sharp(buf).resize(TW, TH, { fit: "cover" }).png().toBuffer();
}
async function normalizeSize(b64, project) {
  return fitBuffer(Buffer.from(b64, "base64"), project);
}

// ★API 입력 축소 — 새로그리기/실사화는 원본 컷을 그대로 모델에 올린다. 세로로 큰 웹툰 컷이면
//   그 큰 버퍼가 동시 재생성 개수만큼 겹쳐 워커 OOM 먹통(마스크 모드는 리사이즈해서 무해했음).
//   모델은 출력 크기(W×H)로 새로 생성하므로 입력 해상도는 긴변 1536 이하로 줄여도 무관.
async function downscaleForApi(buf, maxSide = 1536) {
  try {
    const m = await sharp(buf).metadata();
    if (Math.max(m.width || 0, m.height || 0) <= maxSide) return buf;
    return await sharp(buf).resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  } catch {
    return buf;
  }
}

// 원본 컷 이미지 버퍼 + 씬 → 재생성 이미지 buf (+비용). 실패 시 throw.
export async function regenScene(scene, imgBuf, project, key, model) {
  const [W, H] = reqSize(project, model);
  const img = await downscaleForApi(imgBuf); // ★큰 원본을 그대로 올리면 동시 여러 개서 OOM — 입력만 축소
  const form = new FormData();
  form.append("model", model);
  form.append("image", new Blob([img], { type: "image/png" }), "cut.png");
  form.append("prompt", buildRegenPrompt(scene, project));
  form.append("size", `${W}x${H}`);
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
  return { buf: await normalizeSize(b64, project), cost: imageCostUsd() };
}

// ── 실사화(photorealistic) — 만화 컷을 실사 영화 스틸로. 얼굴 고정을 위해 캐릭터 실사 초상
// (refBufs)을 추가 레퍼런스로 함께 넣는다. gpt-image-2 edits(멀티 이미지). ──────────────
export function buildPhotoPrompt(scene, project, nRefs) {
  const cut = scene.cut ?? {};
  let p =
    "Turn this comic/webtoon panel into a PHOTOREALISTIC live-action film still — real human skin and hair, real fabrics, natural cinematic lighting and depth of field, as if shot on a camera. Not a drawing or 3D render. " +
    "Keep the SAME composition, camera angle, poses, gestures, expressions, clothing, setting and mood as the input panel. Do not add or remove people. Remove ALL text (speech bubbles, captions, lettering) and fill behind naturally.";
  if (nRefs > 0) {
    p +=
      " The extra reference image(s) show the REAL-LIFE face/appearance of the main character(s) in this scene — render the matching person(s) to look like those references (same face, hair, age, identity), consistently.";
  }
  const content = String(cut.description || "").trim();
  if (content) p += ` Scene: ${content}`;
  p += ` Compose to completely fill ${frameDesc(project)}, edge to edge — no black bars, margins, or borders.`;
  const style = String(project.stylePrompt || "").trim();
  if (style) p += ` Extra note: ${style}.`;
  return p.slice(0, 1400);
}

export async function regenScenePhoto(scene, imgBuf, project, key, refBufs = []) {
  const [W, H] = reqSize(project, "gpt-image-2");
  const img = await downscaleForApi(imgBuf); // ★입력 축소 — OOM 방지(위 regenScene 과 동일 이유)
  const form = new FormData();
  form.append("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-2");
  // 멀티 이미지: 첫째=컷, 이후=캐릭터 실사 레퍼런스(얼굴 고정). 필드명 image[] 반복.
  form.append("image[]", new Blob([img], { type: "image/png" }), "cut.png");
  for (let i = 0; i < refBufs.length; i++) {
    const rb = await downscaleForApi(refBufs[i], 1024); // 레퍼런스도 축소(얼굴엔 1024면 충분)
    form.append("image[]", new Blob([rb], { type: "image/png" }), `ref${i}.png`);
  }
  form.append("prompt", buildPhotoPrompt(scene, project, refBufs.length));
  form.append("size", `${W}x${H}`);
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
  return { buf: await normalizeSize(b64, project), cost: imageCostUsd() };
}

// 캐릭터 대표 컷 → 실사 인물 초상(정사각). 캐스팅에서 '실사화 디자인'용.
export async function makePortrait(refBuf, key, extraPrompt) {
  const form = new FormData();
  form.append("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-2");
  form.append("image", new Blob([refBuf], { type: "image/png" }), "ref.png");
  let p =
    "From this drawn comic character, generate a PHOTOREALISTIC portrait of the SAME character as if it were a real photograph — head and shoulders, facing camera, neutral soft background, natural lighting. Keep their hair style/color, face shape, age, clothing and distinctive features faithful to the drawing. Photorealistic, not illustration. No text, no border.";
  if (extraPrompt && extraPrompt.trim()) p += ` ${extraPrompt.trim()}`;
  form.append("prompt", p);
  form.append("size", "1024x1024");
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
  if (!b64) throw new Error("빈 초상 응답");
  return { buf: Buffer.from(b64, "base64"), cost: imageCostUsd() };
}

// 마스크 입력(합성 이미지 + 마스크 2종 + 프롬프트) 생성 — OpenAI edits · fal Fill 공용.
// 목표 비율 캔버스에 컷을 contain 배치. 마스크는 두 관례가 반대라 각각 만든다:
//   OpenAI(RGBA alpha): 0=채움, 255=보존.   fal Fill(그레이): 흰(255)=채움, 검정(0)=보존.
// 채움 영역 = [컷 밖 여백] + [글씨 박스].  보존 영역 = 컷 그림(글씨 제외).
export async function buildMaskInputs(scene, imgBuf, project, model) {
  const [TW, TH] = reqSize(project, model);
  const meta = await sharp(imgBuf).metadata();
  const cw = meta.width || 1;
  const ch = meta.height || 1;
  const scale = Math.min(TW / cw, TH / ch);
  const pw = Math.max(1, Math.round(cw * scale));
  const ph = Math.max(1, Math.round(ch * scale));
  const px = Math.floor((TW - pw) / 2);
  const py = Math.floor((TH - ph) / 2);

  // 배경(여백)을 흰색 대신 '원본을 꽉 채운(cover) 블러본'으로 깐다 → 모델이 여백을 덜 채워도
  // 흰/검/그라데이션 대신 같은 그림의 자연스러운 연속처럼 보인다. 그 위에 원본 컷을 contain 합성.
  const cutResized = await sharp(imgBuf).resize(pw, ph, { fit: "fill" }).png().toBuffer();
  const bg = await sharp(imgBuf).resize(TW, TH, { fit: "cover" }).blur(24).png().toBuffer();
  const composed = await sharp(bg)
    .composite([{ input: cutResized, left: px, top: py }])
    .png()
    .toBuffer();

  // ★ 여백(옆·위아래 밴드)은 '채움'(아웃페인팅) — 예전엔 블러본을 깔고 '보존'으로 잠갔는데
  //   결과가 "배경을 블러로 때운" 화면이라 사용자 거부(2026-07-17). 이제 밴드를 마스크로 열고
  //   프롬프트로 '같은 화풍으로 배경을 이어 그려라'를 명시한다(블러본은 색 힌트 밑그림으로만).
  //   패널 경계 4px 를 겹쳐 열어 이음새를 자연스럽게 섞는다.
  // OpenAI: alpha 255=보존/0=채움.  fal: 검정(0)=보존/흰(255)=채움. 기본을 '보존'으로.
  const rgba = Buffer.alloc(TW * TH * 4); // RGB 0, alpha 는 아래서 255(보존)로 채움
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const gray = Buffer.alloc(TW * TH * 3, 0); // 검정 = 보존
  let filled = false;
  const setFill = (x0, y0, x1, y1) => {
    const xa = Math.max(0, Math.floor(x0));
    const ya = Math.max(0, Math.floor(y0));
    const xb = Math.min(TW, Math.ceil(x1));
    const yb = Math.min(TH, Math.ceil(y1));
    if (xb > xa && yb > ya) filled = true;
    for (let y = ya; y < yb; y++) {
      const row = y * TW;
      for (let x = xa; x < xb; x++) {
        rgba[(row + x) * 4 + 3] = 0; // 채움
        gray[(row + x) * 3] = 255;
        gray[(row + x) * 3 + 1] = 255;
        gray[(row + x) * 3 + 2] = 255;
      }
    }
  };
  // 여백 밴드 = 채움(아웃페인팅). 패널 안쪽으로 4px 겹쳐 이음새를 섞는다.
  const OV = 4;
  if (px > 0) {
    setFill(0, 0, px + OV, TH); // 왼쪽 밴드
    setFill(px + pw - OV, 0, TW, TH); // 오른쪽 밴드
  }
  if (py > 0) {
    setFill(0, 0, TW, py + OV); // 위 밴드
    setFill(0, py + ph - OV, TW, TH); // 아래 밴드
  }
  for (const b of scene.cut?.textBoxes ?? []) {
    setFill(px + b.left * pw, py + b.top * ph, px + b.right * pw, py + b.bottom * ph); // 글씨 자리
  }
  const openaiMask = await sharp(rgba, { raw: { width: TW, height: TH, channels: 4 } }).png().toBuffer();
  const falMask = await sharp(gray, { raw: { width: TW, height: TH, channels: 3 } }).png().toBuffer();

  const prompt =
    "Edit ONLY where the mask marks, two kinds of edits: " +
    "(1) OUTER MARGINS: extend the panel's artwork outward to completely fill them — seamlessly continue the background, sky, ground, lighting and effect lines from the panel edges, in the exact same drawing style and color palette. The margins must become finished drawn illustration. NEVER fill them with blur, gradients, stretched or mirrored pixels, solid bars, letterboxing, or vignette. Do not add new characters or objects there. " +
    "(2) TEXT SPOTS inside the panel: remove the text (speech bubbles, lettering, captions, sound effects) and fill that exact spot with plausible background continuation matching the immediately surrounding art. " +
    "Everything unmasked must stay exactly as-is: do NOT redraw, restyle, move, or stretch the original panel. No text, letters, or watermark in the output.";

  return { composed, openaiMask, falMask, prompt, TW, TH, hasFill: filled };
}

// 마스크 재생성(OpenAI images/edits) — 원본 컷 보존 + 여백은 아웃페인팅 + 글씨 자리 지움.
export async function regenSceneMasked(scene, imgBuf, project, key, model) {
  const { composed, openaiMask, prompt, TW, TH, hasFill } = await buildMaskInputs(scene, imgBuf, project, model);
  // 채울 곳(여백·글씨)이 하나도 없으면(비율 일치+글자 없음) 모델 호출 불필요.
  if (!hasFill) return { buf: await fitBuffer(composed, project), cost: 0 };
  const form = new FormData();
  form.append("model", model);
  form.append("image", new Blob([composed], { type: "image/png" }), "cut.png");
  form.append("mask", new Blob([openaiMask], { type: "image/png" }), "mask.png");
  form.append("prompt", prompt);
  form.append("size", `${TW}x${TH}`);
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
  return { buf: await normalizeSize(b64, project), cost: imageCostUsd() };
}
