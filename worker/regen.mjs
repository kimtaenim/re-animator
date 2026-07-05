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
