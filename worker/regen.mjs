// ============================================================================
// M3 재생성 헬퍼 — 한 컷을 gpt-image-1(i2i)로 다시 그린다. 청크 병렬은 jobs.runRegen.
// ----------------------------------------------------------------------------
// 원본 컷 이미지 + 프롬프트(화풍 + 묘사 + 네거티브)로 images/edits 호출 → 새 이미지 b64.
// 캐릭터 레퍼런스(얼굴 일관성)는 다음 단계에서 추가.
// ============================================================================

// gpt-image-1 대략 단가(품질별, 장당 USD 근사). 예측 가능하게 flat.
const IMAGE_COST = { low: 0.016, medium: 0.042, high: 0.167 };
export const REGEN_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "medium";
export const REGEN_CONCURRENCY = Number(process.env.REGEN_CONCURRENCY || 4);
export const imageCostUsd = () => IMAGE_COST[REGEN_QUALITY] ?? 0.042;

// 컷 비율 → gpt-image-1 지원 크기(구도 유지).
function pickSize(region) {
  const w = (region?.xEnd ?? 0) - (region?.xStart ?? 0);
  const h = (region?.yEnd ?? 0) - (region?.yStart ?? 0);
  const ar = w > 0 && h > 0 ? w / h : 1;
  if (ar < 0.8) return "1024x1536";
  if (ar > 1.25) return "1536x1024";
  return "1024x1024";
}

// ★ 목적: 원화에 최대한 가깝게. 묘사 기반 재해석이 아니라 '충실 재현 + 글씨 제거 +
// 크기 맞춤'. 화풍 지정(stylePrompt)이 있을 때만 덧붙인다.
export function buildRegenPrompt(scene, project) {
  let p =
    "Reproduce this comic panel image faithfully. Keep the exact same artwork, characters, faces, poses, composition, colors and line style as the input — do not redraw, restyle, or reinterpret. " +
    "Remove ALL text: speech bubbles, letters, captions, numbers, sound-effect lettering, watermarks — and cleanly fill the area behind them to match the surrounding art. " +
    "Do not add anything new. Output only the clean illustration, adapted to fit the given canvas size.";
  const style = String(project.stylePrompt || "").trim();
  if (style) p += ` Style note: ${style}.`;
  return p.slice(0, 1000);
}

// 원본 컷 이미지 버퍼 + 씬 → 재생성 이미지 b64 (+비용). 실패 시 throw.
export async function regenScene(scene, imgBuf, project, key, model) {
  const form = new FormData();
  form.append("model", model);
  form.append("image", new Blob([imgBuf], { type: "image/png" }), "cut.png");
  form.append("prompt", buildRegenPrompt(scene, project));
  form.append("size", pickSize(scene.sourceRegion));
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
