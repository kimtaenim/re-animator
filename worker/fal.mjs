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
// ★★캐릭터 레퍼런스용 다중 이미지 모델(문서 확인: image_urls 배열을 받는다).
//   kontext 는 입력 이미지가 1장뿐이라 캐스팅 정본(얼굴)을 넣을 자리가 없었다 →
//   Flux 로 재생성하면 모델이 얼굴을 지어냈다(사용자: 캐릭터 지정했는데 없는 얼굴을 만든다).
//   레퍼런스가 있을 때만 이 모델로 바꿔 보낸다(없으면 기존 kontext 그대로 = 회귀 0).
const FAL_EDIT_MULTI = process.env.FAL_MODEL_EDIT_MULTI || "fal-ai/flux-pro/kontext/max/multi";
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

// ★제거 전용(Erase) — 마스크(흰) 영역의 물체를 '지우고' 주변 배경으로 메운다. 프롬프트 없음.
//   Fill(생성형)은 큰 영역을 통째로 새로 그려 배경이 원본과 달라졌다(사용자: "배경을 엉망으로
//   만든다"). 물체 제거는 전용 모델이 맞다 — 마스크 밖은 픽셀 그대로 보존된다.
const FAL_ERASE = process.env.FAL_MODEL_ERASE || "fal-ai/flux-pro/v1/erase";
export async function falEraseRaw(imageBuf, maskBuf, key) {
  if (!key) throw new Error("FAL_KEY 없음");
  const url = await callFal(
    FAL_ERASE,
    {
      image_url: `data:image/png;base64,${imageBuf.toString("base64")}`,
      mask_url: `data:image/png;base64,${maskBuf.toString("base64")}`,
    },
    key
  );
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`fal 결과 다운로드 실패 ${r.status}`);
  return { buf: Buffer.from(await r.arrayBuffer()), cost: FAL_COST };
}

// 범용 마스크 인페인팅(Fill) — 이미지의 마스크(흰) 영역을 프롬프트대로 다시 그린 PNG 버퍼.
// ★프로젝트 크기 맞춤(fitBuffer) 없이 원본 크기 그대로 돌려준다 — 클린 플레이트(계층 B 배경판)
//   등 '이미지와 같은 좌표계'가 필요한 용도. 비용은 FAL_COST 1회.
export async function falFillRaw(imageBuf, maskBuf, prompt, key) {
  if (!key) throw new Error("FAL_KEY 없음");
  const url = await callFal(
    FAL_FILL,
    {
      prompt,
      image_url: `data:image/png;base64,${imageBuf.toString("base64")}`,
      mask_url: `data:image/png;base64,${maskBuf.toString("base64")}`,
    },
    key
  );
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`fal 결과 다운로드 실패 ${r.status}`);
  return { buf: Buffer.from(await r.arrayBuffer()), cost: FAL_COST };
}

async function downloadFit(url, project) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`fal 결과 다운로드 실패 ${r.status}`);
  return fitBuffer(Buffer.from(await r.arrayBuffer()), project);
}

// 전체(새로 그리기) — 원본 컷(Blob URL) + 프롬프트로 Flux Kontext 편집.
export async function regenSceneFal(scene, project, key, refUrls = []) {
  if (!key) throw new Error("FAL_KEY 없음");
  // 캐스팅 정본(얼굴) URL 들 — 있으면 다중 이미지 모델로, 첫 장이 이 컷·뒤가 레퍼런스.
  const refs = (refUrls || []).filter((u) => typeof u === "string" && u).slice(0, 2);
  const input = refs.length
    ? {
        prompt: buildRegenPrompt(scene, project, refs.length),
        image_urls: [scene.originalImage, ...refs],
        aspect_ratio: falAspect(project),
      }
    : {
        prompt: buildRegenPrompt(scene, project),
        image_url: scene.originalImage,
        aspect_ratio: falAspect(project),
      };
  const url = await callFal(refs.length ? FAL_EDIT_MULTI : FAL_EDIT, input, key);
  return { buf: await downloadFit(url, project), cost: FAL_COST };
}

// 마스크(원본 유지) — 컷은 그대로(옆은 블러 배경), 글씨 자리만 Flux Fill 인페인트.
export async function regenSceneMaskedFal(scene, imgBuf, project, key) {
  if (!key) throw new Error("FAL_KEY 없음");
  const { composed, falMask, prompt, hasFill } = await buildMaskInputs(scene, imgBuf, project, "fal");
  // 지울 글씨가 없으면 Fill 호출 불필요 — 합성본(컷+블러밴드) 그대로.
  if (!hasFill) return { buf: await fitBuffer(composed, project), cost: 0 };
  const url = await callFal(
    FAL_FILL,
    {
      prompt,
      image_url: `data:image/png;base64,${composed.toString("base64")}`,
      mask_url: `data:image/png;base64,${falMask.toString("base64")}`,
    },
    key
  );
  return { buf: await downloadFit(url, project), cost: FAL_COST };
}
