// ============================================================================
// 캐스팅 레퍼런스 얼굴 크롭 — Character.refBox 산출·적용
// ----------------------------------------------------------------------------
// 왜 필요한가(실제 사고): 재생성 때 캐릭터 일관성을 위해 '대표 컷(refSceneId)' 이미지를
// 레퍼런스로 함께 넣는데, 그게 패널 '전체'였다. 모델은 얼굴만이 아니라 그 컷의 구도·배경·
// 내용까지 보게 되고, 그래서 12번 컷을 재생성해도 대표 컷(대개 1~2번)을 닮은 그림이 나왔다
// (사용자 반복 보고: "첫번째 내지 두번째 그림을 자꾸 가져다 쓴다").
//
// 해결: 대표 컷에서 그 인물이 차지하는 영역만 잘라 레퍼런스로 보낸다. 영역은 캐릭터당
// VLM 1회로 구해 Character.refBox 에 캐시한다(이후 무료). 자체 얼굴검출 ML 은 쓰지 않는다.
//
// ★워커 자기완결 — ../lib import 금지.
// ============================================================================

import sharp from "sharp";

// 정규화 박스를 픽셀로 바꾸고, 얼굴만 딱 붙지 않게 여유(padding)를 준다.
// 어깨·머리카락·의상 일부가 들어와야 '정체성' 참고로 쓸모 있다.
const PAD = 0.12;

// VLM 에 대표 컷을 주고 그 인물의 얼굴~상반신 박스를 0~1 로 받는다.
// 실패하면 null → 호출측이 크롭 없이 진행(기존 동작으로 안전 폴백).
export async function detectRefBox(imgBuf, description, key, model = "gpt-4o") {
  if (!key) return null;
  try {
    // 박스만 필요하므로 작게 보내도 충분하다(비용·시간 절감).
    const small = await sharp(imgBuf).resize({ width: 768, withoutEnlargement: true }).png().toBuffer();
    const prompt =
      "이 만화 패널에서 아래 설명에 해당하는 인물 '한 명'의 얼굴과 상반신이 차지하는 영역을 찾아라.\n" +
      `인물 설명: ${description || "이 패널의 주요 인물"}\n` +
      "좌표는 이미지 전체를 0~1 로 정규화한 값. 얼굴이 안 보이면 그 인물의 몸 영역을 준다.\n" +
      "해당 인물을 못 찾으면 found=false.\n" +
      '오직 JSON: {"found":true,"left":0.1,"top":0.05,"right":0.6,"bottom":0.7}';
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
              { type: "image_url", image_url: { url: `data:image/png;base64,${small.toString("base64")}` } },
            ],
          },
        ],
        response_format: { type: "json_object" },
        max_tokens: 200,
      }),
      // ★워커는 단일 스레드 — 외부 호출엔 반드시 타임아웃.
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const j = JSON.parse(d.choices?.[0]?.message?.content ?? "{}");
    if (j.found === false) return null;
    const n = (v) => Math.max(0, Math.min(1, Number(v)));
    const box = { left: n(j.left), top: n(j.top), right: n(j.right), bottom: n(j.bottom) };
    if (!(box.right > box.left && box.bottom > box.top)) return null;
    // 너무 작으면(오검출) 신뢰하지 않는다 — 크롭했다가 얼굴 조각만 남는 사고 방지.
    if ((box.right - box.left) * (box.bottom - box.top) < 0.01) return null;
    return box;
  } catch {
    return null;
  }
}

// 정규화 박스로 실제 크롭(여유 포함). 실패하면 원본을 그대로 돌려준다(폴백).
export async function cropToBox(imgBuf, box) {
  try {
    const m = await sharp(imgBuf).metadata();
    const W = m.width || 0;
    const H = m.height || 0;
    if (!W || !H) return imgBuf;
    const bw = box.right - box.left;
    const bh = box.bottom - box.top;
    const l = Math.max(0, box.left - bw * PAD);
    const t = Math.max(0, box.top - bh * PAD);
    const r = Math.min(1, box.right + bw * PAD);
    const b = Math.min(1, box.bottom + bh * PAD);
    const left = Math.round(l * W);
    const top = Math.round(t * H);
    const width = Math.max(1, Math.round((r - l) * W));
    const height = Math.max(1, Math.round((b - t) * H));
    if (width < 32 || height < 32) return imgBuf; // 너무 작으면 크롭 안 함
    return await sharp(imgBuf)
      .extract({ left, top, width: Math.min(width, W - left), height: Math.min(height, H - top) })
      .png()
      .toBuffer();
  } catch {
    return imgBuf;
  }
}
