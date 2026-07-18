// ============================================================================
// fal.ai (Flux) 이미지 재생성 프로바이더 — gpt-image 대비 빠르고(수초) 충실도↑.
// ----------------------------------------------------------------------------
// 검증된 엔드포인트(fal.ai 문서, 2026-07):
//   · 전체(Kontext 편집) : fal-ai/flux-pro/kontext
//       input  { prompt, image_url, aspect_ratio }   ← image_size 아님, aspect_ratio("16:9"…)
//       output { images: [{ url }] }
//   · 마스크(Fill 인페인트): fal-ai/flux-pro/v1/fill
//       input  { prompt, image_url, mask_url }        ← mask 흰=채움/검정=보존(OpenAI 반대)
//       output { images: [{ url }] }
// model id 는 env(FAL_MODEL_EDIT/FAL_MODEL_FILL)로 override 가능.
// 원본 컷은 Blob 공개 URL 이라 그대로 image_url. 마스크 합성본은 data URI 로 넘긴다.
// 출력은 fitBuffer 로 목표 비율 크롭 → 다른 모델과 크기 일관. 필요: FAL_KEY.
// ============================================================================

import { buildRegenPrompt, buildMaskInputs, fitBuffer } from "./regen.mjs";

const FAL_EDIT = process.env.FAL_MODEL_EDIT || "fal-ai/flux-pro/kontext";
const FAL_FILL = process.env.FAL_MODEL_FILL || "fal-ai/flux-pro/v1/fill";
const FAL_COST = Number(process.env.FAL_IMAGE_COST || 0.05);

// project.aspectRatio 는 이미 "16:9"/"9:16"/"1:1" — fal aspect_ratio 포맷과 동일.
function falAspect(project) {
  const ar = project?.aspectRatio;
  return ar === "9:16" || ar === "1:1" ? ar : "16:9";
}

async function callFal(model, input, key) {
  const r = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: { authorization: `Key ${key}`, "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) throw new Error(`fal ${r.status}: ${(await r.text().catch(() => "")).slice(0, 220)}`);
  const d = await r.json();
  const url = d.images?.[0]?.url || d.image?.url || d.output?.images?.[0]?.url;
  if (!url) throw new Error(`fal 빈 응답: ${JSON.stringify(d).slice(0, 160)}`);
  return url;
}

async function downloadFit(url, project, size) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`fal 결과 다운로드 실패 ${r.status}`);
  return fitBuffer(Buffer.from(await r.arrayBuffer()), project, size);
}

// 전체(새로 그리기) — 원본 컷(Blob URL) + 프롬프트로 Flux Kontext 편집.
export async function regenSceneFal(scene, project, key) {
  if (!key) throw new Error("FAL_KEY 없음");
  const url = await callFal(
    FAL_EDIT,
    {
      prompt: buildRegenPrompt(scene, project),
      image_url: scene.originalImage,
      aspect_ratio: falAspect(project),
    },
    key
  );
  return { buf: await downloadFit(url, project), cost: FAL_COST };
}

// 마스크(원본 유지) — 컷은 그대로(옆은 블러 배경), 글씨 자리만 Flux Fill 인페인트.
export async function regenSceneMaskedFal(scene, imgBuf, project, key) {
  if (!key) throw new Error("FAL_KEY 없음");
  const { composed, falMask, prompt, TW, TH, hasFill } = await buildMaskInputs(scene, imgBuf, project, "fal");
  // 지울 글씨가 없으면 Fill 호출 불필요 — 컷 원본(원본 비율) 그대로.
  if (!hasFill) return { buf: await fitBuffer(composed, project, [TW, TH]), cost: 0 };
  const url = await callFal(
    FAL_FILL,
    {
      prompt,
      image_url: `data:image/png;base64,${composed.toString("base64")}`,
      mask_url: `data:image/png;base64,${falMask.toString("base64")}`,
    },
    key
  );
  return { buf: await downloadFit(url, project, [TW, TH]), cost: FAL_COST }; // 컷 원본 비율 유지
}
