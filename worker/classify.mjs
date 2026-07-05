// ============================================================================
// 컷 온톨로지 분류 — 검출된 각 컷을 타입(중심)으로 분류하고 내용을 뽑는다.
// ----------------------------------------------------------------------------
// 대조표(번호 붙은 썸네일 그리드) 한 장을 VLM 에 주고 컷별 {type, textKind,
// characters, setting, objects, dialogue, sfx} 를 한 번에 받는다(저렴). 타입 목록은
// config/ontology.json 에서 주입(하드코딩 금지). 키 없거나 실패 시 전부 '미분류'.
// 결과는 Scene.cut 에 채워져 이후 image-2(재생성)에 레퍼런스+프롬프트로 넘어간다.
// ============================================================================

import { buildContactSheet } from "./group.mjs";
import { recordCost } from "./store.mjs";
import { loadPrompts, loadOntology } from "./config.mjs";

const PRICING = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
};
function costUsd(model, usage) {
  const p = PRICING[model] || PRICING["gpt-4o"];
  return ((usage?.prompt_tokens ?? 0) * p.input + (usage?.completion_tokens ?? 0) * p.output) / 1e6;
}

// 미분류 기본 컷(키 없음·실패·응답 누락 시). 사람이 G1 에서 채운다.
function blankCut() {
  return {
    type: null,
    textKind: null,
    characters: [],
    setting: "",
    objects: [],
    dialogue: "",
    sfx: "",
    promptDraft: "",
    motion: "",
    confirmed: false,
  };
}

// VLM 이 id 대신 한글 라벨·영문 동의어로 답해도 우리 타입으로 관대하게 매핑.
// (엄격 매칭이면 "중심인물"·"character" 같은 정답을 버려 전부 미분류가 됨.)
const TYPE_SYN = {
  character: "lead", protagonist: "lead", 주인공: "lead", 중심: "lead", 중심인물: "lead",
  reaction: "reaction", 반응: "reaction", 반응인물: "reaction",
  characters: "characters", group: "characters", 인물들: "characters", 대화: "characters",
  crowd: "crowd_space", crowd_space: "crowd_space", setting: "crowd_space",
  background: "crowd_space", establishing: "crowd_space", scenery: "crowd_space",
  군중: "crowd_space", 배경: "crowd_space", 공간: "crowd_space", "군중 및 공간": "crowd_space",
  object: "object", prop: "object", item: "object", 사물: "object", 소품: "object",
  action: "action", 액션: "action", 동작: "action",
  text: "text", speech: "text", dialogue: "text", narration: "text", sfx: "text",
  title: "text", 텍스트: "text", 말풍선: "text", 나레이션: "text", 효과음: "text", 타이틀: "text",
};
const TEXTKIND_SYN = {
  dialogue: "dialogue", speech: "dialogue", 말풍선: "dialogue", 대사: "dialogue", 나레이션: "dialogue",
  sfx: "sfx", 효과음: "sfx", 의성어: "sfx", onomatopoeia: "sfx",
  title: "title", 타이틀: "title", 제목: "title", credits: "title",
};

function resolve(raw, idSet, koToId, syn) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (idSet.has(s)) return s;
  if (koToId.has(s)) return koToId.get(s);
  const low = s.toLowerCase();
  if (idSet.has(low)) return low;
  return syn[low] ?? syn[s] ?? null;
}

function normalizeCut(raw, R) {
  const c = blankCut();
  if (!raw || typeof raw !== "object") return c;
  c.type = resolve(raw.type, R.typeIdSet, R.koToId, TYPE_SYN);
  if (c.type === "text") {
    c.textKind = resolve(raw.textKind, R.textKindIdSet, R.tkKoToId, TEXTKIND_SYN) || "dialogue";
  }
  if (Array.isArray(raw.characters)) c.characters = raw.characters.map(String).slice(0, 6);
  if (typeof raw.setting === "string") c.setting = raw.setting.slice(0, 200);
  if (Array.isArray(raw.objects)) c.objects = raw.objects.map(String).slice(0, 8);
  if (typeof raw.dialogue === "string") c.dialogue = raw.dialogue.slice(0, 300);
  if (typeof raw.sfx === "string") c.sfx = raw.sfx.slice(0, 120);
  return c;
}

export async function classifyScenes(canvas, fileBuffers, regions, key, model, log, projectId) {
  const n = regions.length;
  if (!key || n === 0) return regions.map(blankCut);

  const ont = loadOntology();
  const R = {
    typeIdSet: new Set(ont.cutTypes.map((t) => t.id)),
    koToId: new Map(ont.cutTypes.map((t) => [t.ko, t.id])),
    textKindIdSet: new Set(ont.textKinds.map((t) => t.id)),
    tkKoToId: new Map(ont.textKinds.map((t) => [t.ko, t.id])),
  };
  const typeLines = ont.cutTypes.map((t) => `- ${t.id} (${t.ko}): ${t.desc}`).join("\n");
  const prompt = loadPrompts()
    .classify_task.replace(/\{n\}/g, String(n))
    .replace(/\{types\}/g, typeLines);

  let sheet;
  try {
    await log?.("컷 분류용 대조표 생성…");
    sheet = await buildContactSheet(canvas, fileBuffers, regions, log);
  } catch (e) {
    await log?.(`대조표 생성 실패(미분류로 진행): ${e?.message ?? e}`);
    return regions.map(blankCut);
  }

  try {
    await log?.(`AI가 컷 ${n}개 타입 분류 중…`);
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
              { type: "image_url", image_url: { url: `data:image/png;base64,${sheet.toString("base64")}` } },
            ],
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
    const d = await r.json();
    const txt = d.choices?.[0]?.message?.content ?? "{}";
    await log?.(`분류 응답: ${txt.slice(0, 220)}`);
    const parsed = JSON.parse(txt);
    const byN = new Map();
    for (const raw of parsed.cuts || []) {
      const idx = Number(raw?.n) - 1; // 1-base → 0-base
      if (idx >= 0 && idx < n) byN.set(idx, normalizeCut(raw, R));
    }
    const typed = [...byN.values()].filter((c) => c.type).length;
    await log?.(`분류 매핑: 응답 ${parsed.cuts?.length ?? 0}개 · 타입 인식 ${typed}/${n}`);
    const cost = costUsd(model, d.usage);
    try {
      await recordCost({
        projectId,
        vendor: "openai",
        model,
        costUsd: cost,
        meta: { kind: "cut-classify", cuts: n, classified: byN.size },
      });
    } catch {}
    await log?.(`컷 분류 완료: ${byN.size}/${n} (~$${cost.toFixed(4)})`);
    return regions.map((_, i) => byN.get(i) ?? blankCut());
  } catch (e) {
    await log?.(`컷 분류 실패(미분류로 진행): ${e?.message ?? e}`);
    return regions.map(blankCut);
  }
}
