// ============================================================================
// VLM 장면 그룹핑 — 알고리즘 후보 컷을 "의미 단위 장면"으로 묶는다.
// ----------------------------------------------------------------------------
// 평탄도 검출은 시각적 빈 곳(거터)만 찾아 한 장면을 여러 조각으로 과분할한다.
// 여기서 후보들의 대조표(썸네일 그리드)를 멀티모달에 주고, 각 후보의 "장면 번호"를
// 받아 연속 같은 번호끼리 병합 → 의미 있는 컷 + 픽셀 정확한 경계(후보에서 옴).
// OPENAI_API_KEY 없거나 실패 시 후보 그대로(알고리즘 단독 폴백).
// ============================================================================

import sharp from "sharp";
import { extractRegion } from "./imaging.mjs";

const MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o-mini";
const CELL = 160;
const THUMB = 150;
const COLS = 6;

// 후보 썸네일 대조표(번호 라벨 포함) 한 장 생성. (로컬 검증용으로도 export)
export async function buildContactSheet(canvas, fileBuffers, candidates) {
  const cells = [];
  for (let i = 0; i < candidates.length; i++) {
    const png = await extractRegion(
      canvas,
      fileBuffers,
      candidates[i].yStart,
      candidates[i].yEnd
    );
    const thumb = await sharp(png)
      .resize(THUMB, THUMB, { fit: "contain", background: { r: 34, g: 34, b: 34 } })
      .png()
      .toBuffer();
    cells.push(thumb);
  }
  const rows = Math.ceil(cells.length / COLS);
  const W = COLS * CELL;
  const H = rows * CELL;
  const comps = [];
  for (let i = 0; i < cells.length; i++) {
    const cx = (i % COLS) * CELL;
    const cy = Math.floor(i / COLS) * CELL;
    comps.push({ input: cells[i], left: cx + 5, top: cy + 5 });
    const label = Buffer.from(
      `<svg width="46" height="26" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="46" height="26" fill="#000"/>` +
        `<text x="5" y="20" fill="#3cff8e" font-size="20" font-family="sans-serif" font-weight="bold">${i + 1}</text>` +
        `</svg>`
    );
    comps.push({ input: label, left: cx, top: cy });
  }
  return sharp({
    create: { width: W, height: H, channels: 3, background: { r: 17, g: 17, b: 17 } },
  })
    .composite(comps)
    .png()
    .toBuffer();
}

// 라벨 배열 → 연속 같은 라벨끼리 병합.
function mergeByLabels(candidates, labels) {
  const n = candidates.length;
  if (!Array.isArray(labels) || labels.length !== n) return candidates;
  const merged = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || labels[i] !== labels[i - 1]) {
      merged.push({ yStart: candidates[start].yStart, yEnd: candidates[i - 1].yEnd });
      start = i;
    }
  }
  return merged.length ? merged : candidates;
}

export async function groupScenes(canvas, fileBuffers, candidates, log) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || candidates.length <= 1) return candidates; // 키 없거나 1개 → 폴백

  let sheet;
  try {
    sheet = await buildContactSheet(canvas, fileBuffers, candidates);
  } catch (e) {
    await log?.(`대조표 생성 실패(알고리즘 컷 유지): ${e?.message ?? e}`);
    return candidates;
  }

  const prompt =
    `이 이미지는 위→아래로 흐르는 웹툰에서 잘라낸 후보 컷 ${candidates.length}개를 ` +
    `좌→우, 위→아래 순서로 1번부터 번호 매긴 대조표다(초록 숫자). 이 후보들은 시각적 여백으로 ` +
    `기계 분할된 것이라 한 장면이 여러 조각으로 쪼개져 있을 수 있다.\n` +
    `각 컷이 "의미상 같은 장면/컷"인지 판단해서, 순서대로 장면 번호를 매겨라. ` +
    `연속된 컷이 같은 장면이면 같은 번호, 새 장면이 시작되면 번호를 올려라(1,1,1,2,3,3,...).\n` +
    `오직 JSON만 출력: {"labels":[정수 ${candidates.length}개]}`;

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${sheet.toString("base64")}` },
              },
            ],
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
    const d = await r.json();
    const txt = d.choices?.[0]?.message?.content ?? "{}";
    const labels = JSON.parse(txt).labels;
    const merged = mergeByLabels(candidates, labels);
    await log?.(`VLM 그룹핑: 후보 ${candidates.length} → 장면 ${merged.length}`);
    return merged;
  } catch (e) {
    await log?.(`VLM 그룹핑 실패(알고리즘 컷 유지): ${e?.message ?? e}`);
    return candidates;
  }
}
