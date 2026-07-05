// ============================================================================
// M2 캐스팅 — 캐릭터 타입 컷을 VLM 이 인물별로 묶는다(누가 누군지).
// ----------------------------------------------------------------------------
// 인물 나오는 컷들의 대조표 1장을 VLM 에 주고 "서로 다른 인물 + 각자 등장 컷"을
// 받는다(Structured Outputs). 같은 인물 = 같은 엔티티 → 이후 image-2 에 같은
// 레퍼런스 이미지를 물려 얼굴 일관성. 라벨은 순서대로 '캐릭터 1·2·3'.
// 클러스터링은 전체를 한 번에 봐야 하므로 배치 없이 한 호출(출력은 작아 안전).
// ============================================================================

import { buildContactSheet } from "./group.mjs";
import { recordCost } from "./store.mjs";
import { loadPrompts } from "./config.mjs";

const PRICING = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
};
function costUsd(model, usage) {
  const p = PRICING[model] || PRICING["gpt-4o"];
  return ((usage?.prompt_tokens ?? 0) * p.input + (usage?.completion_tokens ?? 0) * p.output) / 1e6;
}

const CAST_SCHEMA = {
  name: "cast",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      characters: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            description: { type: "string" },
            cuts: { type: "array", items: { type: "integer" } },
          },
          required: ["description", "cuts"],
        },
      },
    },
    required: ["characters"],
  },
};

// charScenes: 인물 컷 Scene 배열(순서 유지). 대조표 번호 i(1-base) → charScenes[i-1].
export async function classifyCast(canvas, fileBuffers, charScenes, key, model, log, projectId) {
  const n = charScenes.length;
  if (!key || n === 0) return [];

  await log?.(`캐스팅 대조표 생성 (인물 컷 ${n}개)…`);
  let sheet;
  try {
    sheet = await buildContactSheet(
      canvas,
      fileBuffers,
      charScenes.map((s) => s.sourceRegion),
      null
    );
  } catch (e) {
    await log?.(`캐스팅 대조표 실패: ${e?.message ?? e}`);
    return [];
  }

  const prompt = loadPrompts().cast_task.replace(/\{n\}/g, String(n));
  await log?.("AI가 등장인물 구분 중…");
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
              image_url: { url: `data:image/png;base64,${sheet.toString("base64")}`, detail: "high" },
            },
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: CAST_SCHEMA },
      max_tokens: 4000,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const d = await r.json();
  const choice = d.choices?.[0];
  if (choice?.message?.refusal) throw new Error(`거부: ${String(choice.message.refusal).slice(0, 120)}`);
  const parsed = JSON.parse(choice?.message?.content ?? "{}");

  const cast = [];
  let idx = 0;
  for (const c of parsed.characters || []) {
    const sceneIds = [];
    for (const num of c.cuts || []) {
      const s = charScenes[Number(num) - 1];
      if (s && !sceneIds.includes(s.id)) sceneIds.push(s.id);
    }
    if (sceneIds.length === 0) continue;
    idx++;
    // 대표 컷: 소속 컷 중 중심인물(lead) 우선, 없으면 첫 컷.
    const leadId = sceneIds.find(
      (id) => charScenes.find((s) => s.id === id)?.cut?.type === "lead"
    );
    cast.push({
      id: `char-${idx}`,
      label: `캐릭터 ${idx}`,
      description: typeof c.description === "string" ? c.description.slice(0, 200) : "",
      refSceneId: leadId ?? sceneIds[0],
      sceneIds,
    });
  }

  try {
    await recordCost({
      projectId,
      vendor: "openai",
      model,
      costUsd: costUsd(model, d.usage),
      meta: { kind: "cast", charCuts: n, characters: cast.length },
    });
  } catch {}
  await log?.(`캐스팅 완료: 인물 ${cast.length}명 (~$${costUsd(model, d.usage).toFixed(4)})`);
  return cast;
}
