// ============================================================================
// VLM 장면-영역 직접 검출 — 알고리즘 후보 대신 VLM 이 실제 장면 박스를 판정.
// ----------------------------------------------------------------------------
// 웹툰을 읽을 청크(~1800px)로 쪼개고 y 눈금선을 그려 VLM 에 준다. VLM 은 눈금 보고
// 각 "실제 장면" 박스(top/bottom px, left/right 비율)를 반환 — 빈 채움·그라데이션·
// 흩날리는 오버레이·나레이션은 제외, 옆 나란한 장면은 x 로 분리. 청크 겹침은 병합.
// OPENAI_API_KEY 없으면 호출부가 알고리즘(detectRegions)으로 폴백.
// ============================================================================

import sharp from "sharp";
import { extractRegion } from "./imaging.mjs";
import { recordCost } from "./store.mjs";
import { loadPrompts } from "./config.mjs";

const CHUNK = 1800;
const OVERLAP = 300;
const GRID = 100;

const PRICING = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
};
function costUsd(model, usage) {
  const p = PRICING[model] || PRICING["gpt-4o"];
  return ((usage?.prompt_tokens ?? 0) * p.input + (usage?.completion_tokens ?? 0) * p.output) / 1e6;
}

// 청크 이미지에 y 눈금(가로선 + px 라벨) 오버레이. (로컬 검증용 export)
export async function drawGrid(png, W, H) {
  const parts = [];
  for (let y = 0; y <= H; y += GRID) {
    parts.push(
      `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#00e5ff" stroke-width="1" opacity="0.55"/>`,
      `<rect x="0" y="${Math.max(0, y - 1)}" width="54" height="17" fill="#000" opacity="0.72"/>`,
      `<text x="4" y="${Math.max(13, y + 13)}" fill="#00e5ff" font-size="14" font-family="sans-serif" font-weight="bold">${y}</text>`
    );
  }
  const svg = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`
  );
  return sharp(png).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
}

async function callVLM(imgPng, prompt, key, model) {
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
            { type: "image_url", image_url: { url: `data:image/png;base64,${imgPng.toString("base64")}` } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1500,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  const d = await r.json();
  const scenes = JSON.parse(d.choices?.[0]?.message?.content ?? "{}").scenes || [];
  return { scenes, cost: costUsd(model, d.usage) };
}

const oy = (a, b) => Math.max(0, Math.min(a.yEnd, b.yEnd) - Math.max(a.yStart, b.yStart));
const ox = (a, b) => Math.max(0, Math.min(a.xEnd, b.xEnd) - Math.max(a.xStart, b.xStart));

// 청크 겹침으로 생긴 중복/조각을 병합(y·x 겹침 큰 것끼리 union).
function dedupe(scenes) {
  scenes.sort((a, b) => a.yStart - b.yStart || a.xStart - b.xStart);
  const out = [];
  for (const s of scenes) {
    if (s.yEnd - s.yStart < 40) continue;
    const dup = out.find(
      (o) =>
        oy(o, s) > 0.5 * Math.min(o.yEnd - o.yStart, s.yEnd - s.yStart) &&
        ox(o, s) > 0.4 * Math.min(o.xEnd - o.xStart, s.xEnd - s.xStart)
    );
    if (dup) {
      dup.yStart = Math.min(dup.yStart, s.yStart);
      dup.yEnd = Math.max(dup.yEnd, s.yEnd);
      dup.xStart = Math.min(dup.xStart, s.xStart);
      dup.xEnd = Math.max(dup.xEnd, s.xEnd);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

export async function detectScenesVLM(canvas, fileBuffers, key, model, log, projectId) {
  const prompts = loadPrompts();
  const total = canvas.totalHeight;
  const W = canvas.refWidth;
  const step = CHUNK - OVERLAP;
  const nChunks = Math.max(1, Math.ceil((total - OVERLAP) / step));
  const raw = [];
  let cost = 0;
  let ci = 0;

  for (let y0 = 0; y0 < total; y0 += step) {
    ci++;
    const y1 = Math.min(total, y0 + CHUNK);
    const H = y1 - y0;
    await log?.(`장면 판정 ${ci}/${nChunks} (y ${y0}~${y1})…`);
    const chunkPng = await extractRegion(canvas, fileBuffers, y0, y1);
    const gridded = await drawGrid(chunkPng, W, H);
    const prompt = `${prompts.cut_definition}\n\n${prompts.region_task
      .replace(/\{H\}/g, String(H))
      .replace(/\{W\}/g, String(W))}`;
    try {
      const res = await callVLM(gridded, prompt, key, model);
      cost += res.cost;
      for (const s of res.scenes) {
        const top = Math.max(0, Math.min(H, Number(s.top)));
        const bottom = Math.max(0, Math.min(H, Number(s.bottom)));
        if (!(bottom - top >= 30)) continue;
        raw.push({
          yStart: y0 + Math.round(top),
          yEnd: y0 + Math.round(bottom),
          xStart: Math.round(Math.max(0, Math.min(1, Number(s.left ?? 0))) * W),
          xEnd: Math.round(Math.max(0, Math.min(1, Number(s.right ?? 1))) * W),
        });
      }
    } catch (e) {
      await log?.(`청크 ${ci} 장면 판정 실패: ${e?.message ?? e}`);
    }
    if (y1 >= total) break;
  }

  const scenes = dedupe(raw);
  try {
    await recordCost({
      projectId,
      vendor: "openai",
      model,
      costUsd: cost,
      meta: { kind: "scene-region", chunks: nChunks, scenes: scenes.length },
    });
  } catch {}
  await log?.(`VLM 장면 영역 ${scenes.length}개 (~$${cost.toFixed(4)})`);
  return scenes;
}
