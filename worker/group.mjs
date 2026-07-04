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
import { recordCost } from "./store.mjs";

const MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o";

// USD per 1M tokens (2026 기준 근사, 변동 가능). 한 곳에서 관리.
const PRICING = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
};

function vlmCostUsd(model, usage) {
  const p = PRICING[model] || PRICING["gpt-4o-mini"];
  const it = usage?.prompt_tokens ?? 0;
  const ot = usage?.completion_tokens ?? 0;
  return (it * p.input + ot * p.output) / 1_000_000;
}
const CELL = 210;
const THUMB = 200;
const COLS = 4;

// 후보 썸네일 대조표(번호 라벨 포함) 한 장 생성. (로컬 검증용으로도 export)
export async function buildContactSheet(canvas, fileBuffers, candidates, log) {
  const cells = [];
  const total = candidates.length;
  for (let i = 0; i < total; i++) {
    if (log && (i % 3 === 0 || i === total - 1)) {
      const pct = Math.round(((i + 1) / total) * 100);
      await log(`장면 판정 준비 — 컷 ${i + 1}/${total} (${pct}%)`);
    }
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

// "앞 컷에 합쳐라" 번호 집합(1-based) → 병합. 범위 밖·형식오류에 강함.
function mergeByList(candidates, mergeSet) {
  const merged = [];
  for (let i = 0; i < candidates.length; i++) {
    if (i > 0 && mergeSet.has(i + 1) && merged.length > 0) {
      merged[merged.length - 1].yEnd = candidates[i].yEnd; // 앞 장면에 흡수
    } else {
      merged.push({ yStart: candidates[i].yStart, yEnd: candidates[i].yEnd });
    }
  }
  return merged.length ? merged : candidates;
}

export async function groupScenes(canvas, fileBuffers, candidates, log, projectId) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || candidates.length <= 1) return candidates; // 키 없거나 1개 → 폴백

  let sheet;
  try {
    sheet = await buildContactSheet(canvas, fileBuffers, candidates, log);
  } catch (e) {
    await log?.(`대조표 생성 실패(알고리즘 컷 유지): ${e?.message ?? e}`);
    return candidates;
  }
  await log?.(`AI가 ${candidates.length}개 컷 장면 판정 중…`);

  const prompt =
    `이 대조표는 위→아래 웹툰에서 기계로 잘라낸 후보 컷 ${candidates.length}개다` +
    `(초록 숫자 1~${candidates.length}, 좌→우·위→아래 순서).\n` +
    `너의 유일한 일: "독립된 컷이 아닌 조각"만 골라 앞 컷에 흡수시키는 것이다.\n` +
    `absorb 에 넣을 것 — 오직 아래에 해당하는 컷만:\n` +
    `  (1) 그림 없이 배경/바닥만 있는 컷\n` +
    `  (2) 그림 없이 나레이션·대사 글자만 있는 컷\n` +
    `  (3) 텅 빈 배경에 아주 작은 요소 1~2개만(예: 검은 배경에 지폐 한두 장) 떠 있고 ` +
    `그 외엔 인물도 장면도 없는 컷\n` +
    `절대 넣지 마라:\n` +
    `  - 인물·구도·상황이 있는 실제 컷은 절대 넣지 마라. 지폐·소품이 함께 보여도, ` +
    `인물이나 장면이 있으면 그건 독립 컷이다.\n` +
    `  - 서로 다른 컷을 "비슷한 요소가 보인다"는 이유로 묶지 마라.\n` +
    `확실하지 않으면 넣지 마라(빼는 게 안전하다). 대부분의 컷은 그대로 둔다.\n` +
    `오직 JSON만: {"absorb":[번호들]}`;

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0, // 결정적 — 재분할마다 결과 흔들리지 않게
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
    await log?.(`VLM 응답: ${txt.slice(0, 220)}`);
    const parsed = JSON.parse(txt);
    // "조각"으로 지목된 컷만 앞 컷에 흡수. 나머지 실제 컷은 그대로.
    const absorbSet = new Set((parsed.absorb || []).map((x) => Number(x)));
    const merged = mergeByList(candidates, absorbSet);
    const costUsd = vlmCostUsd(MODEL, d.usage);
    await recordCost({
      projectId,
      vendor: "openai",
      model: MODEL,
      costUsd,
      meta: { kind: "scene-group", usage: d.usage, candidates: candidates.length },
    });
    await log?.(
      `VLM 그룹핑: 후보 ${candidates.length} → 장면 ${merged.length} (병합 ${
        candidates.length - merged.length
      }개, ~$${costUsd.toFixed(4)})`
    );
    return merged;
  } catch (e) {
    await log?.(`VLM 그룹핑 실패(알고리즘 컷 유지): ${e?.message ?? e}`);
    return candidates;
  }
}
