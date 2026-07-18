// ============================================================================
// 글씨 읽기(OCR) — 추출된 풀해상도 컷 이미지에서 대사·효과음을 정확히 전사 + 글씨 박스.
// ----------------------------------------------------------------------------
// 대조표 썸네일이 아니라 '풀해상도 컷 하나'를 gpt-4o(detail high)에 준다 → 한글 정확.
// 박스(0~1)는 마스크 재생성에서 '글씨 지울 곳'으로 재사용.
// ============================================================================

import sharp from "sharp";

const PRICING = { "gpt-4o": { input: 2.5, output: 10 } };

// OCR 전 리사이즈 — '긴 변'을 2048(gpt-4o high-detail 창 최대치)에 맞춘다. 작으면 확대,
// 크면 lanczos 로 깔끔히 축소. ★ 예전엔 '폭'만 1600으로 키워서, 세로로 긴 컷은 높이가
// 6000+ 가 되고 OpenAI 가 2048로 되축소 → 글자가 더 작아져 OCR 엉터리였음. 긴 변 기준이면
// 특히 대사 밴드(짧고 넓음)가 크게 확대돼 정확. + 샤픈으로 글자 또렷하게.
async function upscaleForOcr(pngBuf) {
  try {
    const m = await sharp(pngBuf).metadata();
    const w = m.width || 0;
    const h = m.height || 0;
    if (!w || !h) return pngBuf;
    const TARGET = Number(process.env.OCR_MAX_SIDE || 2048);
    const longest = Math.max(w, h);
    if (Math.abs(longest - TARGET) > 8) {
      const scale = TARGET / longest;
      return await sharp(pngBuf)
        .resize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), {
          kernel: "lanczos3",
        })
        .sharpen()
        .png()
        .toBuffer();
    }
  } catch {
    /* 원본 그대로 */
  }
  return pngBuf;
}
function costUsd(model, usage) {
  const p = PRICING[model] || PRICING["gpt-4o"];
  return ((usage?.prompt_tokens ?? 0) * p.input + (usage?.completion_tokens ?? 0) * p.output) / 1e6;
}

const BOX_PROPS = {
  left: { type: "number" },
  top: { type: "number" },
  right: { type: "number" },
  bottom: { type: "number" },
};
const OCR_SCHEMA = {
  name: "cut_text",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      // 말풍선(대사) 단위 — 각 풍선의 글자 + 그 풍선 영역. 화자를 풍선마다 붙일 수 있게.
      bubbles: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            translation: { type: "string" }, // 한국어 번역(편집 보조). 원문은 text 그대로, 한국어 원문이면 "".
            left: { type: "number" },
            top: { type: "number" },
            right: { type: "number" },
            bottom: { type: "number" },
          },
          required: ["text", "translation", "left", "top", "right", "bottom"],
        },
      },
      sfx: { type: "string" },
      // 마스크 재생성용 — 모든 글자(말풍선·자막·효과음) 영역.
      boxes: {
        type: "array",
        items: { type: "object", additionalProperties: false, properties: BOX_PROPS, required: ["left", "top", "right", "bottom"] },
      },
    },
    required: ["bubbles", "sfx", "boxes"],
  },
};

const PROMPT =
  "이 만화 컷 이미지의 모든 글자를 읽어라. " +
  "bubbles = 말풍선/대사/자막을 ★말풍선(글상자) 단위로 하나씩★ 배열로. 각 항목: text(그 풍선 글자를 ★원문 언어 그대로, 보이는 그대로 정확히★ — 번역·음역 금지, 빠뜨리거나 지어내지 마라, 확실히 안 읽히면 빈 문자열. 한국어일 때만 띄어쓰기를 표준 맞춤법에 맞게 정리. 세로쓰기·줄바꿈은 한 줄로 이어라), translation(그 풍선의 ★자연스러운 한국어 번역★ — 편집 보조용. ★누가 하는 말인지 인식해서 그 화자의 말투로 옮겨라★: 먼저 이 줄이 등장인물의 대사인지 화면 밖 내레이터(해설·서술)인지 판단하고 — 인물 대사면 그 인물(표정·나이·성별·분위기)에 맞는 어투·격식·감정(반말/존댓말, 거친/부드러운, 놀람·다급함)으로, 내레이터면 담담한 서술체로 옮겨라. 밋밋한 직역 금지. 원문 text 는 절대 안 바꾸고 이 필드에만 번역을 담아라. 원문이 이미 한국어이거나 글자가 없으면 빈 문자열), 그리고 그 풍선 영역 박스(left,top,right,bottom, 이미지 대비 0~1). 서로 다른 인물의 말풍선은 반드시 다른 항목으로 나눠라. 글자 없으면 빈 배열. " +
  "sfx = 효과음/의성어 글자(있으면 그대로, 없으면 빈 문자열). " +
  "boxes = 마스크용 — 모든 글자(말풍선·자막·효과음)가 차지한 영역들을 0~1 박스로. 글자 없으면 빈 배열. " +
  "오직 JSON.";

// pngBuf(풀해상도 컷) → { dialogue, sfx, boxes, cost }. 실패 시 throw.
export async function readCutText(pngBuf, key, model = "gpt-4o") {
  const img = await upscaleForOcr(pngBuf);
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
            { type: "text", text: PROMPT },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${img.toString("base64")}`,
                detail: "high",
              },
            },
          ],
        },
      ],
      response_format: { type: "json_schema", json_schema: OCR_SCHEMA },
      // ★원문+번역을 풍선마다 뱉으므로 넉넉히(1500이면 다풍선 컷에서 잘려 JSON 깨짐→OCR 통째 실패).
      max_tokens: Number(process.env.OCR_MAX_TOKENS || 4000),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  const d = await r.json();
  const raw = d.choices?.[0]?.message?.content ?? "{}";
  // ★응답이 잘렸으면(finish_reason=length) 조용히 삼키지 말고 명시적으로 알린다.
  if (d.choices?.[0]?.finish_reason === "length") {
    throw new Error(`OCR 응답 잘림(max_tokens 초과) — OCR_MAX_TOKENS 상향 필요`);
  }
  const parsed = JSON.parse(raw);
  const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  const validBox = (b) => b.right > b.left && b.bottom > b.top;
  const boxes = (parsed.boxes || [])
    .map((b) => ({ left: clamp(b.left), top: clamp(b.top), right: clamp(b.right), bottom: clamp(b.bottom) }))
    .filter(validBox);
  const bubbles = (parsed.bubbles || [])
    .map((b) => ({
      text: typeof b.text === "string" ? b.text.slice(0, 400) : "",
      translation: typeof b.translation === "string" ? b.translation.trim().slice(0, 400) : "",
      box: { left: clamp(b.left), top: clamp(b.top), right: clamp(b.right), bottom: clamp(b.bottom) },
    }))
    .filter((b) => b.text.trim() !== "") // 글자 없는 풍선은 버림
    .slice(0, 12);
  // 하위호환: dialogue = 풍선 글자들 합침. textBoxes 는 boxes(없으면 풍선 박스)로.
  const dialogue = bubbles.map((b) => b.text.trim()).filter(Boolean).join("\n").slice(0, 500);
  const textBoxes = (boxes.length ? boxes : bubbles.map((b) => b.box).filter(validBox)).slice(0, 12);
  return {
    bubbles,
    dialogue,
    sfx: typeof parsed.sfx === "string" ? parsed.sfx.slice(0, 200) : "",
    boxes: textBoxes,
    cost: costUsd(model, d.usage),
  };
}

// ★타일 OCR — 풀이미지 한 장으로 읽으면 gpt-4o 가 컷 '안'의 테두리 없는 내레이션 캡션
//   (그림 위에 얹힌 흰 글씨 등)을 자주 건너뛴다(VLM 리콜 한계 — 검증된 실측 누락). 컷을 가로 띠로
//   겹치게 잘라 각 조각을 따로 OCR 하면, 캡션이 조각의 큰 비중을 차지해 크게 확대되어 안 놓친다.
//   풀이미지 결과에 '빠진 줄만' 더한다(기존 대사·순서·마스크 안 흔드는 순수 안전망). 회수분은
//   마스크 박스에도 넣어 재생성 때 지워지게 한다. 반환은 readCutText 와 동형 + tiledAdded(회수 줄 수).
//   비용: 컷당 OCR 콜이 (1 + STRIPS)배. 기본 STRIPS=2 → 대략 3배(짧은 컷은 스킵). env 로 조절.
export async function readCutTextTiled(pngBuf, key, model = "gpt-4o") {
  const base = await readCutText(pngBuf, key, model);
  // 기본 1 = 타일 끔(풀이미지 OCR 그대로, 속도 원상). 캡션 누락이 심한 소스에서만
  // 워커 env OCR_TILE_STRIPS=2(또는 3) 로 켠다 — 켜면 컷당 OCR 콜이 (1+STRIPS)배로 느려짐.
  const STRIPS = Math.max(1, Number(process.env.OCR_TILE_STRIPS || 1));
  const MIN_H = Number(process.env.OCR_TILE_MIN_H || 500); // 이보다 낮은 컷은 이미 캡션이 커서 스킵(콜 절약)
  let H = 0;
  let W = 0;
  try {
    const m = await sharp(pngBuf).metadata();
    H = m.height || 0;
    W = m.width || 0;
  } catch {
    /* 메타 실패 시 타일 스킵 */
  }
  if (STRIPS < 2 || !W || H < MIN_H) return { ...base, tiledAdded: 0 };

  const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
  const seen = new Set(base.bubbles.map((b) => norm(b.text)).filter(Boolean));
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const stripH = Math.ceil(H / STRIPS);
  const OV = Math.round(stripH * Number(process.env.OCR_TILE_OVERLAP || 0.22)); // 겹침 — 경계에 걸친 캡션 보호
  const added = []; // 회수된 bubble(풀좌표 box)
  const addedBoxes = []; // 회수 캡션의 마스크 박스(풀좌표)
  let cost = base.cost;

  for (let i = 0; i < STRIPS; i++) {
    const top = Math.max(0, i * stripH - OV);
    const bottom = Math.min(H, (i + 1) * stripH + OV);
    if (bottom - top < 40) continue;
    let strip;
    try {
      strip = await sharp(pngBuf).extract({ left: 0, top, width: W, height: bottom - top }).png().toBuffer();
    } catch {
      continue;
    }
    let r;
    try {
      r = await readCutText(strip, key, model); // 내부서 업스케일 → 이 띠가 크게 확대돼 캡션 또렷
    } catch {
      continue; // 한 조각 실패해도 base 는 지킨다
    }
    cost += r.cost;
    const span = bottom - top;
    const toFull = (v) => clamp01((top + v * span) / H); // 조각 로컬 y(0~1) → 풀이미지 y(0~1)
    for (const b of r.bubbles) {
      const kk = norm(b.text);
      if (!kk || seen.has(kk)) continue; // 풀이미지·다른 조각이 이미 읽은 줄은 스킵(중복 제거)
      seen.add(kk);
      const box = { left: b.box.left, right: b.box.right, top: toFull(b.box.top), bottom: toFull(b.box.bottom) };
      added.push({ text: b.text, ...(b.translation ? { translation: b.translation } : {}), box });
      if (box.right > box.left && box.bottom > box.top) addedBoxes.push(box);
    }
  }

  if (!added.length) return { ...base, tiledAdded: 0, cost };
  // 회수분 합쳐 y(top) 오름차순 정렬 → 읽기순서(위→아래) 보존. dialogue 재구성.
  const bubbles = [...base.bubbles, ...added].sort((a, b) => (a.box?.top ?? 0) - (b.box?.top ?? 0));
  const dialogue = bubbles.map((b) => (b.text || "").trim()).filter(Boolean).join("\n").slice(0, 500);
  const boxes = [...base.boxes, ...addedBoxes].slice(0, 24); // 회수 캡션도 마스크되게(재생성 때 지움)
  return { bubbles, dialogue, sfx: base.sfx, boxes, cost, tiledAdded: added.length };
}
