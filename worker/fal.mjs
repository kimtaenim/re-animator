// ============================================================================
// fal.ai (Flux) 이미지 재생성 프로바이더 — gpt-image-1 대비 빠르고(수초) 충실도↑.
// ----------------------------------------------------------------------------
// 모델 id 는 env 로 조정 가능(fal 모델명이 바뀔 수 있음). 원본 컷은 Blob 공개 URL 이라
// 그대로 image_url 로 넘긴다. 출력은 fitBuffer 로 목표 비율 크롭 → 다른 모델과 크기 일관.
// 필요: FAL_KEY (Render 워커 환경변수).
// ============================================================================

import { buildRegenPrompt, fitBuffer } from "./regen.mjs";

const FAL_EDIT = process.env.FAL_MODEL_EDIT || "fal-ai/flux-pro/kontext";
const FAL_COST = Number(process.env.FAL_IMAGE_COST || 0.05);

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

// 원본 컷(Blob URL) + 프롬프트로 Flux Kontext 편집 → 목표 크기 buf.
export async function regenSceneFal(scene, project, key) {
  if (!key) throw new Error("FAL_KEY 없음");
  const url = await callFal(
    FAL_EDIT,
    { prompt: buildRegenPrompt(scene, project), image_url: scene.originalImage },
    key
  );
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`fal 결과 다운로드 실패 ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf: await fitBuffer(buf, project), cost: FAL_COST };
}
