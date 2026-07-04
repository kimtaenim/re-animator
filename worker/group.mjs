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

// split 지목 컷을 VLM 에 "크게" 보여주고 패널 경계 위치(높이 대비 비율)를 받아 자른다.
// 자를 위치를 알고리즘이 아니라 VLM 이 정함 → 붙은 패널은 정확히 자르고, 연속 그림
// (흐르는 이펙트·한 동작)은 VLM 이 빈 배열을 줘서 안 잘린다. (panels vs 연속 구분)
async function vlmSplitCut(canvas, fileBuffers, region, key, model, log) {
  const png = await extractRegion(canvas, fileBuffers, region.yStart, region.yEnd);
  const img = await sharp(png).resize({ width: 340 }).png().toBuffer();
  const H = region.yEnd - region.yStart;
  const prompt =
    `이 이미지는 세로 웹툰에서 잘라낸 컷 하나다. 그 안에 서로 다른 패널(다른 인물·순간·구도)이 ` +
    `세로로 여러 개 쌓여 있으면, 패널이 나뉘는 경계의 세로 위치를 이미지 높이 대비 비율(0~1)로 ` +
    `모두 나열해라. 하나의 연속된 그림/장면이면(예: 흐르는 이펙트, 한 인물의 한 동작) 빈 배열. ` +
    `오직 JSON: {"cuts":[비율들]}`;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${img.toString("base64")}` },
              },
            ],
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const d = await r.json();
    const fr = (JSON.parse(d.choices?.[0]?.message?.content ?? "{}").cuts || [])
      .map(Number)
      .filter((f) => f > 0.03 && f < 0.97)
      .sort((a, b) => a - b);
    const cost = vlmCostUsd(model, d.usage);
    if (!fr.length) return { subs: [region], cost };
    const ys = [0, ...fr.map((f) => Math.round(f * H)), H];
    const subs = [];
    for (let i = 0; i < ys.length - 1; i++) {
      if (ys[i + 1] - ys[i] >= 40) {
        subs.push({ yStart: region.yStart + ys[i], yEnd: region.yStart + ys[i + 1] });
      }
    }
    return { subs: subs.length ? subs : [region], cost };
  } catch (e) {
    await log?.(`컷 분할 VLM 실패(그대로): ${e?.message ?? e}`);
    return { subs: [region], cost: 0 };
  }
}

// VLM 판정 적용: absorb(앞 컷 흡수) / split(VLM 위치-분할) / 나머지 그대로.
async function applyDecision(candidates, absorbSet, splitSet, ctx) {
  const { canvas, fileBuffers, key, model, log } = ctx;
  const splitTotal = [...splitSet].filter((n) => n >= 1 && n <= candidates.length).length;
  const out = [];
  let splitCost = 0;
  let done = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const n = i + 1;
    if (absorbSet.has(n) && out.length > 0) {
      out[out.length - 1].yEnd = c.yEnd;
    } else if (splitSet.has(n)) {
      done++;
      await log?.(`컷 분할 판정 ${done}/${splitTotal}…`);
      const { subs, cost } = await vlmSplitCut(canvas, fileBuffers, c, key, model, log);
      splitCost += cost;
      for (const s of subs) out.push({ yStart: s.yStart, yEnd: s.yEnd });
    } else {
      out.push({ yStart: c.yStart, yEnd: c.yEnd });
    }
  }
  return { regions: out.length ? out : candidates, splitCost };
}

export async function groupScenes(
  canvas,
  fileBuffers,
  candidates,
  log,
  projectId,
  globalProfile,
  cfg
) {
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
    `기계는 시각적 여백만 보고 잘라서, 어떤 컷은 조각으로 과분할됐고 어떤 컷은 여러 패널이 ` +
    `한 덩어리로 뭉쳤다(과소분할). 두 가지를 판정해라.\n` +
    `[absorb] — "독립 컷이 아닌 조각"의 번호. 오직: (1)배경/바닥만, (2)글자만, ` +
    `(3)텅 빈 배경에 작은 요소 1~2개(예: 검은 배경 지폐 한두 장)만 있는 컷. 앞 컷에 흡수된다. ` +
    `인물·장면이 있으면(지폐가 함께 보여도) 절대 넣지 마라.\n` +
    `[split] — "한 컷 안에 서로 다른 패널/순간이 2개 이상 세로로 쌓여 있어 나눠야 하는" 컷의 번호. ` +
    `예: 인물의 선언 + 여러 인물의 반응 + 군중이 한 컷에 뭉친 경우. 이런 컷은 더 잘게 나눈다.\n` +
    `확실하지 않으면 어느 쪽에도 넣지 마라. 오직 JSON만: {"absorb":[번호들], "split":[번호들]}`;

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
    const absorbSet = new Set((parsed.absorb || []).map((x) => Number(x)));
    const splitSet = new Set((parsed.split || []).map((x) => Number(x)));
    const { regions: merged, splitCost } = await applyDecision(
      candidates,
      absorbSet,
      splitSet,
      { canvas, fileBuffers, key, model: MODEL, log }
    );
    const costUsd = vlmCostUsd(MODEL, d.usage) + splitCost;
    await recordCost({
      projectId,
      vendor: "openai",
      model: MODEL,
      costUsd,
      meta: { kind: "scene-group", usage: d.usage, candidates: candidates.length },
    });
    await log?.(
      `VLM 판정: 후보 ${candidates.length} → 최종 ${merged.length} ` +
        `(흡수 ${absorbSet.size}, 분할지목 ${splitSet.size}, ~$${costUsd.toFixed(4)})`
    );
    return merged;
  } catch (e) {
    await log?.(`VLM 그룹핑 실패(알고리즘 컷 유지): ${e?.message ?? e}`);
    return candidates;
  }
}
