// ============================================================================
// 컷 온톨로지 분류 — 검출된 각 컷을 타입(중심)으로 분류하고 내용을 뽑는다.
// ----------------------------------------------------------------------------
// 대조표(번호 붙은 썸네일 그리드) 한 장을 VLM 에 주고 컷별 구조화 JSON 을 한 번에
// 받는다(저렴). ★ Structured Outputs(json_schema strict) 로 스키마를 강제 → 모델이
// enum(타입/textKind)을 반드시 유효값으로만 뱉는다(파싱 뒷수습 불필요, 미분류 방지).
// 자유 서술(description·promptDraft)도 같은 객체에 담아 image-2(재생성)로 그대로 전달.
// 타입 어휘는 config/ontology.json 에서 주입(하드코딩 금지). 키 없거나 실패 시 '미분류'.
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
    speakerId: null,
    sfx: "",
    description: "",
    promptDraft: "",
    motion: "",
    confirmed: false,
  };
}

// 컷별 응답 스키마(Structured Outputs strict). enum 은 온톨로지에서 주입.
function buildSchema(typeEnum, textKindEnum) {
  return {
    name: "cut_classification",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cuts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              n: { type: "integer", description: "컷 번호(1-base)" },
              type: { type: "string", enum: typeEnum },
              textKind: { type: "string", enum: [...textKindEnum, "none"] },
              characters: { type: "array", items: { type: "string" } },
              setting: { type: "string" },
              objects: { type: "array", items: { type: "string" } },
              dialogue: { type: "string" },
              sfx: { type: "string" },
              description: { type: "string" },
              promptDraft: { type: "string" },
            },
            required: [
              "n", "type", "textKind", "characters", "setting",
              "objects", "dialogue", "sfx", "description", "promptDraft",
            ],
          },
        },
      },
      required: ["cuts"],
    },
  };
}

// VLM 이 id 대신 한글 라벨·영문 동의어로 답해도 우리 타입으로 관대하게 매핑.
// (엄격 매칭이면 "중심인물"·"character" 같은 정답을 버려 전부 미분류가 됨.)
const TYPE_SYN = {
  lead: "person", reaction: "person", characters: "person", character: "person",
  protagonist: "person", 인물: "person", 중심인물: "person", 반응인물: "person",
  인물들: "person", 사람: "person", 주인공: "person",
  action: "action", 액션: "action", 동작: "action", 움직임: "action",
  object: "object", prop: "object", item: "object", 사물: "object", 소품: "object",
  title: "object", 타이틀: "object", 로고: "object", logo: "object",
  diagram: "object", 다이어그램: "object", 도표: "object", chart: "object",
  infographic: "object", 인포그래픽: "object",
  crowd_space: "background_crowd", crowd: "background_crowd", 군중: "background_crowd",
  background: "background_crowd", 배경: "background_crowd", setting: "background_crowd",
  공간: "background_crowd", 장소: "background_crowd", scenery: "background_crowd", 풍경: "background_crowd",
  transition: "transition", 장면전환: "transition", "장면 전환": "transition",
  전환: "transition", 장면연결: "transition", "장면 연결": "transition",
  text: "text", speech: "text", dialogue: "text", 말풍선: "text", 자막: "text",
  caption: "text", narration: "text", 나레이션: "text", sfx: "text", 효과음: "text", 텍스트: "text",
};
const TEXTKIND_SYN = {
  dialogue: "dialogue", speech: "dialogue", 말풍선: "dialogue", 대사: "dialogue", 나레이션: "dialogue",
  caption: "caption", 자막: "caption", narration: "caption",
  sfx: "sfx", 효과음: "sfx", 의성어: "sfx", onomatopoeia: "sfx",
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
  // strict 스키마면 이미 유효 enum. resolve 는 비-strict 모델용 안전망.
  c.type = resolve(raw.type, R.typeIdSet, R.koToId, TYPE_SYN);
  if (c.type === "text") {
    c.textKind = resolve(raw.textKind, R.textKindIdSet, R.tkKoToId, TEXTKIND_SYN) || "dialogue";
  }
  if (Array.isArray(raw.characters)) c.characters = raw.characters.map(String).slice(0, 6);
  if (typeof raw.setting === "string") c.setting = raw.setting.slice(0, 200);
  if (Array.isArray(raw.objects)) c.objects = raw.objects.map(String).slice(0, 8);
  if (typeof raw.dialogue === "string") c.dialogue = raw.dialogue.slice(0, 300);
  if (typeof raw.sfx === "string") c.sfx = raw.sfx.slice(0, 120);
  if (typeof raw.description === "string") c.description = raw.description.slice(0, 800);
  if (typeof raw.promptDraft === "string") c.promptDraft = raw.promptDraft.slice(0, 800);
  return c;
}

// 대조표 1장 → 분류 호출. finish_reason/refusal/파싱 실패를 구체적 에러로 던진다.
async function callClassify(sheet, prompt, schema, key, model) {
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
      response_format: { type: "json_schema", json_schema: schema },
      max_tokens: 16384,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const d = await r.json();
  const choice = d.choices?.[0];
  const finish = choice?.finish_reason;
  const msg = choice?.message;
  if (msg?.refusal) throw new Error(`거부(refusal): ${String(msg.refusal).slice(0, 140)}`);
  const txt = msg?.content ?? "";
  let parsed;
  try {
    parsed = JSON.parse(txt || "{}");
  } catch {
    throw new Error(`JSON 파싱 실패 (finish=${finish}, ${txt.length}자 — 잘렸을 수 있음)`);
  }
  return { cuts: parsed.cuts || [], cost: costUsd(model, d.usage), finish };
}

// 컷을 배치(대조표 여러 장)로 나눠 분류 — 한 응답이 max_tokens 를 넘겨 잘리는 것 방지.
const BATCH = 12;

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
  const promptBase = loadPrompts().classify_task;
  const schema = buildSchema([...R.typeIdSet], [...R.textKindIdSet]);

  const out = regions.map(blankCut);
  let totalCost = 0;
  let typed = 0;

  for (let start = 0; start < n; start += BATCH) {
    const batch = regions.slice(start, start + BATCH);
    const bn = batch.length;
    await log?.(`컷 분류 ${start + 1}~${start + bn}/${n}…`);
    let sheet;
    try {
      sheet = await buildContactSheet(canvas, fileBuffers, batch, null);
    } catch (e) {
      await log?.(`  대조표 실패(이 구간 미분류): ${e?.message ?? e}`);
      continue;
    }
    const prompt = promptBase.replace(/\{n\}/g, String(bn)).replace(/\{types\}/g, typeLines);
    try {
      const res = await callClassify(sheet, prompt, schema, key, model);
      totalCost += res.cost;
      let hit = 0;
      for (const raw of res.cuts) {
        const li = Number(raw?.n) - 1; // 배치 내 1-base → 0-base
        if (li >= 0 && li < bn) {
          const c = normalizeCut(raw, R);
          out[start + li] = c;
          if (c.type) {
            typed++;
            hit++;
          }
        }
      }
      await log?.(`  → 응답 ${res.cuts.length}개 · 타입 ${hit}/${bn} (finish=${res.finish})`);
    } catch (e) {
      await log?.(`  분류 실패(이 구간 미분류): ${e?.message ?? e}`);
    }
  }

  try {
    await recordCost({
      projectId,
      vendor: "openai",
      model,
      costUsd: totalCost,
      meta: { kind: "cut-classify", cuts: n, classified: typed },
    });
  } catch {}
  await log?.(`컷 분류 완료: 타입 인식 ${typed}/${n} (~$${totalCost.toFixed(4)})`);
  return out;
}
