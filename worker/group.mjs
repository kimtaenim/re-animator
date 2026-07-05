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
import { loadPrompts } from "./config.mjs";

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
// 컷 PNG → 행별 "경계다움"(색 전환 mean 급변 + flat 단색 띠). VLM 위치 스냅용. (export: 로컬 검증)
export async function computeBoundaryness(png) {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const means = new Float32Array(H);
  const bness = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    let s2 = 0;
    const off = y * W;
    for (let x = 0; x < W; x++) {
      const v = data[off + x];
      s += v;
      s2 += v * v;
    }
    const m = s / W;
    means[y] = m;
    const std = Math.sqrt(Math.max(0, s2 / W - m * m));
    bness[y] = std < 12 ? (12 - std) * 2 : 0; // flat 단색 띠
  }
  const w = 6;
  for (let y = w; y < H; y++) {
    const edge = Math.abs(means[y] - means[y - w]); // 색 전환
    if (edge > bness[y]) bness[y] = edge;
  }
  return bness;
}

// VLM 위치를 근처(±win)의 가장 뚜렷한 경계로 스냅. 경계 약하면 원위치 유지.
export function snapTo(bness, yPos, win) {
  let best = yPos;
  let bs = -1;
  const lo = Math.max(1, yPos - win);
  const hi = Math.min(bness.length - 1, yPos + win);
  for (let y = lo; y <= hi; y++) {
    if (bness[y] > bs) {
      bs = bness[y];
      best = y;
    }
  }
  return bs >= 22 ? best : yPos;
}

// 엄격 스냅: ±win 안에 '진짜' 경계(거터/색전환)가 있을 때만 그 y 를, 없으면 null.
// → VLM 이 위치를 제안해도 실제 경계가 없으면 자르지 않는다(연속 그림·인물 몸 관통 금지).
export function snapStrict(bness, yPos, win, minB = 26) {
  let best = yPos;
  let bs = -1;
  const lo = Math.max(1, yPos - win);
  const hi = Math.min(bness.length - 1, yPos + win);
  for (let y = lo; y <= hi; y++) {
    if (bness[y] > bs) {
      bs = bness[y];
      best = y;
    }
  }
  return bs >= minB ? best : null;
}

async function vlmSplitCut(canvas, fileBuffers, region, key, model, log, splitPrompt) {
  const png = await extractRegion(canvas, fileBuffers, region.yStart, region.yEnd);
  const img = await sharp(png).resize({ width: 340 }).png().toBuffer();
  const H = region.yEnd - region.yStart;
  const prompt = splitPrompt;
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
    // VLM 비율 위치를 실제 패널 경계로 스냅(픽셀 정확도). ±6% 창에서 '진짜' 경계로만.
    // 경계가 없으면(연속 그림·인물 몸) 그 컷은 자르지 않는다 → 몸 관통 물리적 차단.
    const bness = await computeBoundaryness(png);
    const win = Math.max(20, Math.round(H * 0.06));
    const positions = fr
      .map((f) => snapStrict(bness, Math.round(f * H), win))
      .filter((v) => v != null)
      .sort((a, b) => a - b);
    if (!positions.length) return { subs: [region], cost };
    const ys = [0, ...positions, H];
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

// VLM 판정 적용: absorb(조각 흡수) → 병합. 그다음 "키 큰 컷"은 per-cut 고해상도로
// VLM 에 나눌지·어디서 물어봄(대조표 flag 보다 신뢰↑). VLM 이 위치 주면 실제 경계로 스냅.
async function applyDecision(candidates, absorbSet, ctx) {
  const { canvas, fileBuffers, key, model, log, splitPrompt } = ctx;

  // 1) absorb 적용 → 병합.
  const merged = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (absorbSet.has(i + 1) && merged.length > 0) {
      merged[merged.length - 1].yEnd = c.yEnd;
    } else {
      merged.push({ yStart: c.yStart, yEnd: c.yEnd });
    }
  }

  // 2) 키 큰 컷은 분할 검사(중앙값 1.5배 또는 900px 초과). 서사 순간이 여럿이면 나뉜다.
  const hs = merged.map((r) => r.yEnd - r.yStart).sort((a, b) => a - b);
  const median = hs[Math.floor(hs.length / 2)] || 500;
  const threshold = Math.max(900, Math.round(median * 1.5));
  const tallCount = merged.filter((r) => r.yEnd - r.yStart > threshold).length;

  const out = [];
  let splitCost = 0;
  let done = 0;
  for (const r of merged) {
    if (r.yEnd - r.yStart > threshold) {
      done++;
      await log?.(`컷 분할 검사 ${done}/${tallCount}…`);
      const { subs, cost } = await vlmSplitCut(
        canvas,
        fileBuffers,
        r,
        key,
        model,
        log,
        splitPrompt
      );
      splitCost += cost;
      for (const s of subs) out.push(s);
    } else {
      out.push(r);
    }
  }
  return { regions: out.length ? out : candidates, splitCost };
}

// 거터-우선 파이프라인용: 병합(absorb) 없이, '키 큰' 거터-없는 구간만 VLM 이
// 여러 장면인지 판정 → 실제 경계로 엄격 스냅해 분할. 경계 없으면 그대로 둔다.
// 알고리즘 거터 컷의 픽셀 정확도를 유지하면서, 붙은 스택 패널만 추가로 나눈다.
export async function splitTallRegions(canvas, fileBuffers, candidates, key, model, log, projectId) {
  if (!key || !candidates.length) return candidates;
  const P = loadPrompts();
  const splitPrompt = `${P.cut_definition}\n\n${P.split_task}`;
  const hs = candidates.map((r) => r.yEnd - r.yStart).sort((a, b) => a - b);
  const median = hs[Math.floor(hs.length / 2)] || 500;
  const threshold = Math.max(900, Math.round(median * 1.5));
  const tallCount = candidates.filter((r) => r.yEnd - r.yStart > threshold).length;
  const out = [];
  let cost = 0;
  let done = 0;
  for (const r of candidates) {
    if (r.yEnd - r.yStart > threshold) {
      done++;
      await log?.(`긴 구간 분할 검사 ${done}/${tallCount}…`);
      const { subs, cost: c } = await vlmSplitCut(canvas, fileBuffers, r, key, model, log, splitPrompt);
      cost += c;
      for (const s of subs) out.push(s);
    } else {
      out.push(r);
    }
  }
  try {
    await recordCost({
      projectId,
      vendor: "openai",
      model,
      costUsd: cost,
      meta: { kind: "tall-split", tall: tallCount, before: candidates.length, after: out.length },
    });
  } catch {}
  await log?.(`분할 검사: 긴 구간 ${tallCount}개 → 컷 ${out.length}개 (~$${cost.toFixed(4)})`);
  return out;
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

  // 프롬프트는 config/prompts.json 에서(하드코딩 금지). cut_definition 을 공유.
  const P = loadPrompts();
  const cutDef = P.cut_definition;
  const splitPrompt = `${cutDef}\n\n${P.split_task}`;
  const prompt = `${cutDef}\n\n${P.group_task.replace(/\{n\}/g, String(candidates.length))}`;

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
    const { regions: merged, splitCost } = await applyDecision(candidates, absorbSet, {
      canvas,
      fileBuffers,
      key,
      model: MODEL,
      log,
      splitPrompt,
    });
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
        `(흡수 ${absorbSet.size}, ~$${costUsd.toFixed(4)})`
    );
    return merged;
  } catch (e) {
    await log?.(`VLM 그룹핑 실패(알고리즘 컷 유지): ${e?.message ?? e}`);
    return candidates;
  }
}
