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
import { detectRegions } from "./detect.mjs";
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

// VLM 판정 적용(1-based 번호 집합):
//  - absorb: 앞 컷에 흡수(조각).
//  - split: 그 컷 y구간을 더 잘게 재검출(fineCfg) → 서브 컷으로 대체. (자르기는 공짜)
//  - 나머지: 그대로.
function applyDecision(candidates, absorbSet, splitSet, globalProfile, fineCfg) {
  const out = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const n = i + 1;
    if (absorbSet.has(n) && out.length > 0) {
      out[out.length - 1].yEnd = c.yEnd;
    } else if (splitSet.has(n) && globalProfile) {
      const slice = globalProfile.subarray(c.yStart, c.yEnd);
      const sub = detectRegions(slice, fineCfg); // slice 기준 0-base
      if (sub.length > 1) {
        for (const s of sub) {
          out.push({ yStart: c.yStart + s.yStart, yEnd: c.yStart + s.yEnd });
        }
      } else {
        out.push({ yStart: c.yStart, yEnd: c.yEnd }); // 못 쪼개면 그대로
      }
    } else {
      out.push({ yStart: c.yStart, yEnd: c.yEnd });
    }
  }
  return out.length ? out : candidates;
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
    // split 지목 컷은 더 잘게 재검출(민감하게: flatStd↑, minGap↓).
    const fineCfg = {
      flatStdThreshold: (cfg?.flatStdThreshold ?? 10) + 6,
      minGapPx: 12,
      minSceneHeightPx: 40,
    };
    const merged = applyDecision(candidates, absorbSet, splitSet, globalProfile, fineCfg);
    const costUsd = vlmCostUsd(MODEL, d.usage);
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
