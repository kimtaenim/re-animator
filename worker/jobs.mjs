// ============================================================================
// 잡 오케스트레이터 — split(분할), extract(컷 추출). I/O(Redis·Blob·다운로드)는
// 여기서, 픽셀 연산은 imaging.mjs, 경계 판정은 detect.mjs(순수)로 분리.
// ============================================================================

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { put } from "@vercel/blob";
import {
  getProject,
  saveProject,
  logProgress,
  resetProgress,
  saveRowProfile,
  recordCost,
  enqueueJob,
  logDub,
  resetDubLog,
} from "./store.mjs";
import sharp from "sharp";
import { computeRowProfile, extractRegion, trimBox, rawCacheStats, clearRawCache } from "./imaging.mjs";

// ★메모리 관측 한 줄 — 진행 로그(사용자가 앱에서 보는 그 로그)에 그대로 찍는다.
//   OOM 은 재현 순간의 숫자가 없으면 영영 추측이다. 로그를 달라고 하지 말고 스스로 남긴다.
function memLine() {
  const rss = Math.round(process.memoryUsage.rss() / 1048576);
  const rc = rawCacheStats();
  return `[mem] rss ${rss}MB · 원본raw ${rc.mb}MB(${rc.files}개·디코드${rc.decodes}회)`;
}
import { buildCanvas, pickRefWidth } from "./canvas.mjs";
import { detectRegions } from "./detect.mjs";
import { splitTallRegions, forceSplit } from "./group.mjs";
import { classifyScenes } from "./classify.mjs";
import { classifyCast } from "./cast.mjs";
import {
  regenScene,
  regenSceneMasked,
  regenScenePhoto,
  makePortrait,
  REGEN_CONCURRENCY,
} from "./regen.mjs";
import { regenSceneFal, regenSceneMaskedFal } from "./fal.mjs";
import { grokVideoFromImage, GROK_VIDEO_COST } from "./grok.mjs";
import { klingVideoFromImage, KLING_VIDEO_COST } from "./kling.mjs";
import { minimaxVideoFromImage, MINIMAX_VIDEO_COST, hasMinimax } from "./minimax.mjs";
import { renderCameraFx } from "./cameraRender.mjs";
import { presetLayer } from "./cameraKeyframes.mjs";
import { generateMatte, generateCleanPlate, matteWhiteRatio } from "./matte.mjs";
import { readCutText, readCutTextTiled, prepareOcrImage, readCutTextPrepared } from "./ocr.mjs";
import { detectRefBox, cropToBox } from "./refbox.mjs";
import { translateScenes, proofreadScenes, translateScenesMultilang } from "./translate.mjs";
import { groupIntoSequences } from "./sequence.mjs";
import { synthesize, synthSfx } from "./tts.mjs";

// 만화 효과음(한글 의성어) → ElevenLabs Sound Effects 용 짧은 영어 사운드 묘사. 실패 시 원문.
async function sfxToEnglish(korean, key) {
  if (!key) return korean;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_SFX_MODEL || "gpt-4o-mini",
        temperature: 0,
        max_tokens: 30,
        messages: [
          {
            role: "user",
            content: `만화 효과음 의성어 "${korean}" 를 그 소리를 만들 짧은 영어 사운드 묘사로만 답해. 예: 쾅→loud explosion bang, 두근→heartbeat thump, 쏴→pouring rain. 오직 묘사구(따옴표 없이).`,
          },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return korean;
    const d = await r.json();
    const t = d.choices?.[0]?.message?.content?.trim();
    return t ? t.replace(/^["']|["']$/g, "").slice(0, 200) : korean;
  } catch {
    return korean;
  }
}

// 영상(I2V)은 여러 컷을 병렬로 생성(각자 submit→poll). xAI 초당 1건 제한은 grok.mjs
// 레이트 게이트가 처리하므로, 여기선 병렬 개수만 정한다(제출은 1초 간격으로 자동 스로틀).
const VIDEO_CONCURRENCY = Number(process.env.VIDEO_CONCURRENCY || 3); // 6→3: 재생성 OOM 먹통과 같은 패턴 예방(다운로드+stripAudio 겹침). env 로 상향 가능

// 캐스팅 대상 = 인물이 담긴 컷. person(정지·반응) + action(동작 중 인물) 모두 포함.
const CHARACTER_TYPES = new Set(["person", "action"]);

// 말풍선·효과음 등 '글자만' 작은 컷(text)은 독립 이미지 컷으로 두지 않고 제거한다.
// 제거로 생긴 '틈'과 원래 컷 사이 빈 구간의 텍스트(내레이션 등)는 아래 addGapTextRegions 가
// 이웃 컷의 textRegions 로 잡아 추출 때 따로 OCR 한다(이미지엔 안 합침).
function absorbTextCuts(scenes) {
  const arr = scenes.slice().sort((a, b) => a.sourceRegion.yStart - b.sourceRegion.yStart);
  const h = (s) => s.sourceRegion.yEnd - s.sourceRegion.yStart;
  const heights = arr.map(h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 300;
  const isAbsorbable = (s) => s.cut?.type === "text" && h(s) < Math.max(280, median * 0.5);
  const reals = arr.filter((s) => !isAbsorbable(s));
  if (!reals.length) return arr; // 전부 흡수대상이면 그대로
  // ★제거되는 '텍스트만' 컷(말풍선·내레이션 밴드)의 영역을 가장 가까운 살아남은 컷의
  //   textRegions 로 확실히 넘긴다(검출 임계값에 안 의존 → 안 놓침). 추출이 그 영역만 따로
  //   OCR 해 그 컷 대사에 붙인다(영역엔 안 합침 → 재생성 이미지 오염 없음).
  for (const t of arr) {
    if (!isAbsorbable(t)) continue;
    const tc = (t.sourceRegion.yStart + t.sourceRegion.yEnd) / 2;
    let best = null;
    let bd = Infinity;
    for (const s of reals) {
      const c = (s.sourceRegion.yStart + s.sourceRegion.yEnd) / 2;
      const d = Math.abs(c - tc);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (!best) continue;
    if (!best.cut) best.cut = { dialogue: "", sfx: "", type: null };
    if (!best.cut.textRegions) best.cut.textRegions = [];
    best.cut.textRegions.push({
      yStart: t.sourceRegion.yStart,
      yEnd: t.sourceRegion.yEnd,
      xStart: t.sourceRegion.xStart,
      xEnd: t.sourceRegion.xEnd,
    });
  }
  return reals;
}

// ★가장자리 확장 — 컷 위/아래 가장자리가 '내용 행'과 맞닿아 이어지면 내용이 끝나는 데까지
//   컷을 늘린다. 어두운 만화에서 거터 오판으로 그림 중간(머리통 등)에 경계가 서는 문제의
//   결정론적 수술(사용자 실측: 컷 가장자리 밖으로 그림이 이어져 잘려 보임). 텍스트 밴드가
//   맞닿아 있으면 컷 안으로 들어오는데, 컷 안 글자는 정상 경로(OCR+textBoxes 마스크)라 무해.
function extendRegionEdges(regions, profile, totalH) {
  const STD = Number(process.env.EDGE_EXT_STD || 8); // 이 이상 = 내용 있는 행
  const BLANK_OK = 10; // 그림 내 미세 공백 허용(px) — 이보다 길게 비면 진짜 여백으로 보고 중단
  const MAX_EXT = 1600; // 폭주 방지
  const sorted = regions.slice().sort((a, b) => a.yStart - b.yStart);
  let grown = 0;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const before = r.yEnd - r.yStart;
    // 아래쪽 가장자리
    const nextStart = Math.round(sorted[i + 1]?.yStart ?? totalH);
    let y = Math.round(r.yEnd);
    let blank = 0;
    let moved = 0;
    while (y < nextStart - 4 && moved < MAX_EXT) {
      if (profile[y] > STD) {
        r.yEnd = y + 1;
        blank = 0;
      } else if (++blank > BLANK_OK) break;
      y++;
      moved++;
    }
    // 위쪽 가장자리(앞 컷은 이미 확장 완료된 yEnd 를 경계로)
    const prevEnd = Math.round(sorted[i - 1]?.yEnd ?? 0);
    y = Math.round(r.yStart) - 1;
    blank = 0;
    moved = 0;
    while (y > prevEnd + 4 && moved < MAX_EXT) {
      if (profile[y] > STD) {
        r.yStart = y;
        blank = 0;
      } else if (++blank > BLANK_OK) break;
      y--;
      moved++;
    }
    if (r.yEnd - r.yStart > before + 24) {
      grown++;
      // 세로로 크게 늘었으면 트림된 가로 크롭이 새 내용과 안 맞을 수 있어 전체 폭으로 해제.
      delete r.xStart;
      delete r.xEnd;
    }
  }
  return grown;
}

// ★ 컷이 아닌 '빈 구간'(내레이션 밴드 등)도 텍스트가 있을 수 있다. 컷들이 안 덮은 y 구간 중
// '내용 있는'(행별 평탄도 프로파일이 높은) 곳을 가장 가까운 컷의 textRegions 로 추가 → 추출 때
// 따로 OCR 해 대사/내레이션을 그 컷에 붙인다. 평탄한 거터(내용 없음)는 건너뛴다.
function addGapTextRegions(scenes, profile, totalHeight, log) {
  if (!scenes.length) return 0;
  const sorted = scenes.slice().sort((a, b) => a.sourceRegion.yStart - b.sourceRegion.yStart);
  const gaps = [];
  let cursor = 0;
  const push = (a, b) => {
    if (b - a > 24) gaps.push({ yStart: a, yEnd: b });
  };
  for (const s of sorted) {
    push(cursor, s.sourceRegion.yStart);
    cursor = Math.max(cursor, s.sourceRegion.yEnd);
  }
  push(cursor, totalHeight);
  // ★핵심 수정: 갭이 텍스트인지 '평균'이 아니라 '글자 있는 행(피크)'으로 판정한다. 여백에
  // 둘러싸인 얇은 내레이션 밴드는 평균을 내면 임계 아래로 깔려 통째로 스킵됐다(= 못 잡던 원인).
  // 글자 행의 위·아래 끝을 찾아 그 밴드로 좁혀 저장 → 추출이 그 부분만 OCR 해 이웃 컷에 붙인다.
  const TEXT_STD = Number(process.env.GAP_TEXT_STD || 8); // 이 이상 = 글자(잉크) 있는 행
  const MIN_ROWS = Number(process.env.GAP_MIN_ROWS || 4); // 글자 행이 이만큼은 있어야 텍스트
  const MAX_BANDS = Number(process.env.GAP_MAX_BANDS || 240); // ★24→120→240: 중국 만화 실측서 120도 14개 초과(그림 run 이 슬롯을 먹음)
  // absorbTextCuts 가 이미 넘긴 밴드는 건너뛴다(중복 OCR·중복 대사 방지).
  const existing = [];
  for (const s of scenes) for (const tr of s.cut?.textRegions ?? []) existing.push([tr.yStart, tr.yEnd]);
  const overlapsExisting = (a, b) => existing.some(([x, y]) => Math.min(b, y) - Math.max(a, x) > 8);
  // ★갭 안의 '내용 있는 행'을 연속 구간(run)별로 쪼갠다(빈 행 20px 이상이면 분리).
  //   예전엔 갭당 첫~끝 행을 밴드 1개로 묶고, 흡수 밴드와 겹치면 갭 전체를 버렸다 —
  //   같은 갭에 있던 다른 내레이션까지 같이 유실(중국 만화에서 실측 확인). run 단위로
  //   각각 판정하면 겹치는 run 만 스킵되고 나머지는 산다.
  const textyRuns = (a, b) => {
    const y0 = Math.max(0, Math.floor(a));
    const y1 = Math.min(profile.length, Math.ceil(b));
    const runs = [];
    let first = -1;
    let last = -1;
    let count = 0;
    let blank = 0;
    const flush = () => {
      if (first >= 0 && count >= MIN_ROWS) runs.push({ yStart: Math.max(y0, first - 6), yEnd: Math.min(y1, last + 6) });
      first = -1;
      last = -1;
      count = 0;
    };
    for (let y = y0; y < y1; y++) {
      if (profile[y] > TEXT_STD) {
        if (first < 0) first = y;
        last = y;
        count++;
        blank = 0;
      } else if (first >= 0 && ++blank >= 20) {
        flush();
        blank = 0;
      }
    }
    flush();
    // ★run 이 갭 끝에 붙어 있으면(=글줄이 씬 경계에 잘려 이어짐) 이웃 씬 쪽으로 90px 연장해
    //   잘린 줄 전체가 OCR 되게 한다(밴드는 OCR 전용이라 씬 영역과 겹쳐도 무해).
    for (const r of runs) {
      if (r.yStart <= y0 + 8) r.yStart = Math.max(0, y0 - 90);
      if (r.yEnd >= y1 - 8) r.yEnd = Math.min(profile.length, y1 + 90);
    }
    return runs;
  };
  let added = 0;
  let dropped = 0;
  for (const g of gaps) {
    for (const band of textyRuns(g.yStart, g.yEnd)) {
      if (overlapsExisting(band.yStart, band.yEnd)) continue; // 이미 흡수로 넘어간 run 만 스킵
      if (added >= MAX_BANDS) {
        dropped++;
        continue;
      }
      const gc = (band.yStart + band.yEnd) / 2;
      let best = null;
      let bd = Infinity;
      for (const s of scenes) {
        const c = (s.sourceRegion.yStart + s.sourceRegion.yEnd) / 2;
        const d = Math.abs(c - gc);
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
      if (!best) continue;
      if (!best.cut) best.cut = { dialogue: "", sfx: "", type: null };
      if (!best.cut.textRegions) best.cut.textRegions = [];
      best.cut.textRegions.push({ yStart: band.yStart, yEnd: band.yEnd });
      added++;
    }
  }
  // ★침묵 상한 금지 — 잘렸으면 로그로 알린다(예전엔 24개에서 조용히 중단 = 유실 은폐).
  if (dropped > 0 && log) log(`⚠ 텍스트 밴드 상한(${MAX_BANDS}) 초과 — ${dropped}개 구간 예약 못함(GAP_MAX_BANDS 상향 필요)`);
  return added;
}

// 컷 대사 병합 — 자기이미지 말풍선 + 위/아래 내레이션 밴드를 읽는 순서(위→컷→아래)로 합치되,
// ★밴드가 자기이미지와 '같은 글줄'을 읽은 중복은 버린다(밴드는 경계서 90px 연장돼 컷과 겹침 →
//   같은 대사 두 번 잡히던 버그). 자기이미지 풍선은 전부 보존(모델이 일부러 나눈 별개 대사),
//   밴드 쪽에서 이미 나온 텍스트만 스킵(밴드끼리 중복도 제거). 정규화(공백 제거) 텍스트로 비교.
function mergeCutBubbles(above, ownBubbles, below) {
  const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
  const seen = new Set((ownBubbles || []).map((b) => norm(b.text)).filter(Boolean));
  const keepBand = (arr) =>
    (arr || []).filter((b) => {
      const k = norm(b.text);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return [...keepBand(above), ...(ownBubbles || []), ...keepBand(below)];
}

// 재추출/분할/합병 시 풍선별 화자(speakerId)·자막위치(subtitleX/Y) 보존 — 새 OCR 풍선을
// 옛 풍선과 글자로 매칭해 옮긴다. 옛 풍선이 없고 컷 단위 레거시 화자만 있으면 풍선 1개일 때 물려준다.
function mergeBubbleSpeakers(newBubbles, oldBubbles, legacySpeakerId) {
  const bubbles = (newBubbles || []).map((b) => ({ text: b.text, box: b.box, ...(b.translation ? { translation: b.translation } : {}) }));
  const old = oldBubbles || [];
  const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
  for (const nb of bubbles) {
    const match = old.find(
      (ob) =>
        (ob.speakerId || ob.subtitleX != null || ob.subtitleY != null || ob.emotion) &&
        norm(ob.text) === norm(nb.text)
    );
    if (match) {
      if (match.speakerId) nb.speakerId = match.speakerId;
      if (typeof match.subtitleX === "number") nb.subtitleX = match.subtitleX;
      if (typeof match.subtitleY === "number") nb.subtitleY = match.subtitleY;
      if (match.emotion) nb.emotion = match.emotion; // 감정 연기도 화자처럼 보존
      if (!nb.translation && match.translation) nb.translation = match.translation; // OCR 번역 없을 때만 옛 번역 유지
    }
  }
  if (!old.some((o) => o.speakerId) && legacySpeakerId && bubbles.length === 1 && !bubbles[0].speakerId) {
    bubbles[0].speakerId = legacySpeakerId;
  }
  return bubbles;
}
// ★내레이션은 '별개'가 아니라 화자=내레이터인 대사 줄일 뿐(사용자 지시). 레거시 cut.narration
//   문자열을 말풍선(speakerId=narrationSpeakerId ?? null = 내레이터)으로 흡수하고 분리 필드는 비운다.
//   → 이후 더빙·합성·자막이 전부 bubbles 한 경로로만 흐른다(이중 처리·UI 분리 제거).
function normalizeNarration(cut) {
  if (!cut) return;
  const nar = (cut.narration || "").trim();
  if (!nar) return;
  cut.bubbles = cut.bubbles ?? [];
  const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
  const already = cut.bubbles.some((b) => b.speakerId == null && norm(b.text) === norm(nar));
  if (!already) {
    cut.bubbles.push({
      text: nar,
      speakerId: cut.narrationSpeakerId ?? null, // null = 기본 내레이터
      ...(cut.narrationTranslation ? { translation: cut.narrationTranslation } : {}),
      ...(cut.narrationAudioUrl ? { audioUrl: cut.narrationAudioUrl } : {}),
    });
  }
  cut.narration = "";
  delete cut.narrationTranslation;
  delete cut.narrationSpeakerId;
  delete cut.narrationAudioUrl;
}

// 검출된 효과음 문자열(cut.sfx) → 통제 가능한 '효과음' 말풍선(speakerId=__sfx__)으로 통일.
// 사용자가 연출 보고서/편집기에서 보고 지우거나 고칠 수 있고(=통제), 더빙 때만 ElevenLabs 효과음으로
// 생성된다. 절제: OCR 이 실제로 잡은 의성어/앰비언스만 한 줄로 등록하고, 원치 않으면 사용자가 지운다.
// ★효과음인데 '대사(내레이터)' 로 잡힌 줄을 되돌린다 —
//   OCR 이 말풍선 밖 의성어를 bubbles 에 넣으면 화자가 없어(null) 내레이터 목소리가 그걸
//   읽어버린다(사용자 보고: 효과음이 내레이터로 잡힘). 프롬프트로도 막지만 모델은 실수하므로
//   결정적 판정을 코드로 둔다. ★사람이 화자를 지정한 줄은 절대 건드리지 않는다.
const SFX_WORDS =
  /^(쾅|콰앙|쿵|퍽|퍼억|팍|턱|툭|탁|털썩|우당탕|와장창|쨍그랑|후욱|휙|휘익|쉭|촤악|철썩|찰싹|버럭|으드득|바스락|사각|스륵|스르륵|덜컥|덜덜|부르르|두근|두근두근|쿵쾅|삐걱|끼익|끼이익|드르륵|따당|탕|빵|펑|펑펑|쏴아|촤아|주르륵|뚝|똑|딸깍|치익|지익|파앗|번쩍|화악|훅|헉|흡|끄응|으윽|윽|억|악|캬|콜록|훌쩍)+[!?~…\.\s]*$/;
const SFX_JP = /^[゠-ヿㇰ-ㇿ･-ﾟ…!?~\s]{1,10}$/; // 가타카나(반각 포함) 의성어 덩어리 // 가타카나 의성어 덩어리
function looksLikeSfx(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.length > 12) return false; // 긴 문장은 대사로 본다(오탐 방지)
  if (SFX_WORDS.test(t)) return true;
  if (SFX_JP.test(t)) return true;
  // 같은 글자 3회 이상 반복(쾅쾅쾅, ㄷㄷㄷ, ~~~) + 문장부호만 남는 짧은 덩어리
  if (/(.)\1{2,}/.test(t) && t.length <= 8) return true;
  // ★"짧은 한글 + 느낌표" 규칙은 뺐다 — 살려줘!/형!/정말이야? 같은 실제 대사를 효과음으로
  //   잡아 대사가 통째로 사라진다(검증에서 오탐 확인). 사전(SFX_WORDS)에 있는 것만 인정한다.
  return false;
}

function normalizeSfx(cut) {
  if (!cut) return;
  cut.bubbles = cut.bubbles ?? [];
  const norm = (t) => String(t || "").replace(/\s+/g, "").trim();

  // (1) OCR 이 bubbles 에 잘못 넣은 의성어를 효과음으로 되돌린다.
  //     조건: 화자가 아직 정해지지 않은 줄(undefined/null)만. 사람이 지정한 줄은 보존.
  for (const b of cut.bubbles) {
    if (!b || b.speakerId === "__sfx__") continue;
    const unassigned = b.speakerId === undefined || b.speakerId === null;
    if (unassigned && looksLikeSfx(b.text)) b.speakerId = "__sfx__";
  }

  // (2) cut.sfx 문자열 → 효과음 말풍선(기존 동작)
  const sfx = (cut.sfx || "").trim();
  if (!sfx) return;
  const already = cut.bubbles.some((b) => b.speakerId === "__sfx__" && norm(b.text) === norm(sfx));
  if (!already) cut.bubbles.push({ text: sfx, speakerId: "__sfx__" });
  cut.sfx = ""; // 단일 원천 = 말풍선(__sfx__). 중복 등록 방지.
}
import { loadSplitConfig } from "./config.mjs";
import { directCut, CAMERA_PROMPTS, DIRECTOR_CAMERA_TO_PRESET } from "./director.mjs";
import { resolveCameraWork } from "./cameraKeyframes.mjs"; // ★워커 자기완결(../lib 금지)

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`다운로드 실패 ${r.status} ${String(url).slice(0, 80)}`);
  return Buffer.from(await r.arrayBuffer());
}

// ★영상은 '메모리에 올리지 않고' 디스크로 흘려 받는다 —
//   예전엔 download() 가 전체 영상을 Buffer 로 만들고, conformVideo 가 결과를 또 Buffer 로
//   읽어서, 컷당 큰 버퍼 2개가 RAM 에 남았다. 동시 3이면 최대 6개 → Render 워커 OOM.
//   compose.mjs 는 원래부터 스트리밍이라 같은 문제가 없었다. 같은 방식으로 맞춘다.
async function downloadToFile(url, dest) {
  const r = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`다운로드 실패 ${r.status} ${String(url).slice(0, 80)}`);
  if (r.body) await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
  else await writeFile(dest, Buffer.from(await r.arrayBuffer()));
}

// ffmpeg 경로(지연 확정) — ffmpeg-static 있으면 그걸, 없으면 PATH. env override 우선.
let _ffPath = null;
async function ffmpegPath() {
  if (_ffPath !== null) return _ffPath;
  try {
    _ffPath = process.env.FFMPEG_PATH || (await import("ffmpeg-static")).default || "ffmpeg";
  } catch {
    _ffPath = process.env.FFMPEG_PATH || "ffmpeg";
  }
  return _ffPath;
}

// ffprobe 경로(지연 확정) — ffprobe-static 있으면 그걸, 없으면 PATH. env override 우선.
let _fpPath = null;
async function ffprobePath() {
  if (_fpPath !== null) return _fpPath;
  try {
    _fpPath = process.env.FFPROBE_PATH || (await import("ffprobe-static")).default?.path || "ffprobe";
  } catch {
    _fpPath = process.env.FFPROBE_PATH || "ffprobe";
  }
  return _fpPath;
}

// mp4 버퍼에서 오디오 트랙 제거(그록 I2V가 자동으로 넣는 소리 삭제). 실패하면 null → 원본 사용.
// 재인코딩 없이 -c copy -an 이라 빠르다.
// ── ffmpeg 직렬 게이트 ────────────────────────────────────────────────────────
// 워커는 메모리가 빡빡하고(Render), ffmpeg 는 컨테이너 메모리를 프로세스째 먹는다.
// 네트워크 대기(영상 생성 API, 컷당 수 분)는 병렬로 겹쳐야 빠르지만, 인코딩까지 같이
// 병렬로 돌면 [입력 버퍼 + 출력 버퍼 + ffmpeg 프로세스] 가 동시성만큼 겹쳐 OOM 난다.
// → 인코딩 구간만 한 줄로 세운다. 실패해도 큐가 막히지 않게 catch 로 체인을 잇는다.
let _ffmpegGate = Promise.resolve();
function withFfmpeg(fn) {
  const run = _ffmpegGate.then(fn, fn);
  _ffmpegGate = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function stripAudio(buf) {
  let dir;
  try {
    const ff = await ffmpegPath();
    dir = await mkdtemp(join(tmpdir(), "vstrip-"));
    const inp = join(dir, "in.mp4");
    const out = join(dir, "out.mp4");
    await writeFile(inp, buf);
    await new Promise((res, rej) => {
      const pr = spawn(ff, ["-y", "-i", inp, "-c", "copy", "-an", "-movflags", "+faststart", out]);
      let err = "";
      pr.stderr.on("data", (d) => (err += d));
      pr.on("error", rej);
      pr.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}: ${err.slice(-200)}`))));
    });
    return await readFile(out);
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// 프로젝트 지정 비율의 출력 픽셀(합성 targetDims 과 동일 값 — 단일 원천처럼 맞춘다).
function targetDims(project) {
  const ar = project?.aspectRatio;
  if (ar === "9:16") return [720, 1280];
  if (ar === "1:1") return [1024, 1024];
  return [1280, 720];
}

// Grok I2V 출력을 '지정 비율'로 채워-크롭(crop-to-fill) + 오디오 제거. Grok 이 입력(예: 1:1)과 무관하게
// 가로형 등 기본 비율로 내는 걸 바로잡는다. force_original_aspect_ratio=increase → 중앙 crop = 검은 띠 없이
// 프레임을 꽉 채움. (1:1 이미지가 가로 프레임에 필러박스로 들어온 경우, 중앙 crop 이 원래 1:1 내용을 정확히 복원)
// maxSec(선택): 이 길이로 잘라낸다. ★Kling 은 최소 3초라 1~2초짜리 액션 컷도 3초로 받는데,
//   모델이 남는 시간을 '동작 반복'으로 채운다(사용자: 발차기가 여러 번 나온다). 의도한 길이로
//   자르면 반복 구간이 사라진다. 트림은 재인코딩 중 -t 라 추가 비용이 없다.
// srcPath(파일 경로) → outPath. ★버퍼를 만들지 않는다(OOM 회피). 실패 시 null.
//   호출측이 outDir 을 주면 그 안에 결과를 만들고, 정리는 호출측이 한다(스트림 업로드용).
async function conformVideoFile(srcPath, project, maxSec, outDir) {
  try {
    const ff = await ffmpegPath();
    const [W, H] = targetDims(project);
    const out = join(outDir, "conformed.mp4");
    const vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
    const args = ["-y", "-i", srcPath, "-vf", vf, "-an"];
    if (maxSec && maxSec > 0) args.push("-t", Number(maxSec).toFixed(2));
    args.push(
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
      "-threads", "1", "-tune", "zerolatency", "-bf", "0", "-g", "48",
      "-max_muxing_queue_size", "256", "-movflags", "+faststart", out
    );
    await new Promise((res, rej) => {
      const pr = spawn(ff, args);
      let timedOut = false;
      const kill = setTimeout(() => { timedOut = true; try { pr.kill("SIGKILL"); } catch {} }, 3 * 60 * 1000);
      let err = "";
      pr.stderr.on("data", (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
      pr.on("error", (e) => { clearTimeout(kill); rej(e); });
      pr.on("close", (c) => { clearTimeout(kill); timedOut ? rej(new Error("ffmpeg 타임아웃(3분)")) : (c === 0 ? res() : rej(new Error(`ffmpeg ${c}: ${err.slice(-200)}`))); });
    });
    return out;
  } catch (e) {
    console.error("[conformVideoFile] 비율 맞춤 실패 → 원본 사용:", String(e?.message ?? e).slice(0, 300));
    return null;
  }
}

async function conformVideo(buf, project, maxSec) {
  let dir;
  try {
    const ff = await ffmpegPath();
    const [W, H] = targetDims(project);
    dir = await mkdtemp(join(tmpdir(), "vconf-"));
    const inp = join(dir, "in.mp4");
    const out = join(dir, "out.mp4");
    await writeFile(inp, buf);
    const vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
    await new Promise((res, rej) => {
      const args = ["-y", "-i", inp, "-vf", vf, "-an"];
      if (maxSec && maxSec > 0) args.push("-t", Number(maxSec).toFixed(2));
      // ★메모리 절약 — Render 워커는 512MB 급이고 sharp 까지 상주한다. libx264 는 스레드·lookahead
      //   버퍼가 메모리를 크게 먹으므로 조인다: threads 1, 룩어헤드 비활성(zerolatency), B프레임 0.
      //   품질 영향은 미미(crf 20 유지)하고 OOM 여유는 크게 늘어난다.
      args.push(
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
        "-threads", "1", "-tune", "zerolatency", "-bf", "0", "-g", "48",
        "-max_muxing_queue_size", "256", "-movflags", "+faststart", out
      );
      const pr = spawn(ff, args);
      // ★매달림 방어: ffmpeg 가 멈추면 SIGKILL(고아 프로세스 누적→OOM 방지). 3분 캡(비율 맞춤은 짧은 작업).
      let timedOut = false;
      const kill = setTimeout(() => { timedOut = true; try { pr.kill("SIGKILL"); } catch {} }, 3 * 60 * 1000);
      let err = "";
      pr.stderr.on("data", (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
      pr.on("error", (e) => { clearTimeout(kill); rej(e); });
      pr.on("close", (c) => { clearTimeout(kill); timedOut ? rej(new Error("ffmpeg 타임아웃(3분) — 강제 종료")) : (c === 0 ? res() : rej(new Error(`ffmpeg ${c}: ${err.slice(-200)}`))); });
    });
    return await readFile(out);
  } catch (e) {
    // ★실패하면 원본(비율 안 맞음=정사각형 등)으로 폴백되므로, 왜 실패했는지 로그에 남긴다(진단).
    console.error("[conformVideo] 비율 맞춤 실패 → 원본 폴백:", String(e?.message ?? e).slice(0, 300));
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function sortedFiles(p) {
  return (p.sourceFiles ?? []).slice().sort((a, b) => a.order - b.order);
}

// ── split: 소스 파일들 → 가상 캔버스 + 컷 경계(Scene) ────────────────────────
export async function runSplit(projectId) {
  await resetProgress(projectId);
  const t0 = Date.now();
  const log = async (m) => {
    const el = ((Date.now() - t0) / 1000).toFixed(0); // 경과초 — 어느 단계서 시간 새는지 증거
    console.error("[split]", `+${el}s`, m);
    await logProgress(projectId, `[+${el}s] ${m}`);
  };
  // ★단계별 소요 시간 측정 — "느리다"는 보고가 와도 '어디가' 느린지 몰라 추측 수정이 반복됐다.
  //   한 번의 실행으로 병목 단계를 확정하려고 구간 시계만 둔다(동작 변경 없음).
  const marks = [];
  let tMark = Date.now();
  const mark = (name) => {
    marks.push(`${name} ${((Date.now() - tMark) / 1000).toFixed(0)}s`);
    tMark = Date.now();
  };

  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const files = sortedFiles(p);
  if (files.length === 0) throw new Error("소스 파일이 없어요");

  const cfg = loadSplitConfig();
  const refWidth = pickRefWidth(files.map((f) => f.width), cfg.refWidthMode);
  // ★런타임 자가 보고 — "코드는 같은데 새 배포부터 다르다"를 조사할 때 실제 Node 버전이
  //   증거가 된다(render.yaml 이 runtime:node 라 Dockerfile 의 node:20 고정이 안 먹었고,
  //   버전을 안 박으면 재빌드 때 바뀔 수 있다). 사용자가 Render 로그를 뒤지지 않아도 보이게.
  await log(`기준폭 ${refWidth}px, 파일 ${files.length}개 — 행 프로파일 계산… (node ${process.version})`);

  // 파일을 하나씩 열어 프로파일 계산. 버퍼는 VLM 그룹핑 썸네일용으로 보관.
  const profiles = [];
  const normHeights = [];
  const buffers = [];
  for (let i = 0; i < files.length; i++) {
    await log(`파일 ${i + 1}/${files.length} 프로파일…`);
    const buf = await download(files[i].url);
    buffers.push(buf);
    const { profile, normHeight } = await computeRowProfile(buf, refWidth);
    profiles.push(profile);
    normHeights.push(normHeight);
  }

  const canvas = buildCanvas(refWidth, normHeights);

  // 전역 프로파일 이어붙이기(수백만 원소여도 float 라 수 MB).
  const global = new Float32Array(canvas.totalHeight);
  let acc = 0;
  for (const pr of profiles) {
    global.set(pr, acc);
    acc += pr.length;
  }
  // 프로파일 저장 → 앱이 '그 컷만 분할'을 워커 왕복 없이 즉시 계산.
  await saveRowProfile(
    projectId,
    Buffer.from(global.buffer, global.byteOffset, global.byteLength).toString("base64")
  );

  // 1) 어디서 자를지 = 알고리즘. 실제 평탄 행(패널 사이 거터)에서만 자른다.
  //    → 인물 몸(평탄하지 않음)을 물리적으로 못 자르고, 거터 없는 패널을 못 쪼갠다.
  mark("프로파일");
  await log("경계 검출(실제 거터)…");
  let regions = detectRegions(global, cfg).map((c) => ({ yStart: c.yStart, yEnd: c.yEnd }));
  await log(`거터 컷 ${regions.length}개`);
  mark("거터검출");

  // 2) 무엇이 장면인지 = VLM. 거터 없는 '키 큰' 구간만 여러 장면인지 판정하고,
  //    그 위치도 실제 경계로 엄격 스냅 — 진짜 경계 없으면 안 자른다(연속 그림·몸 보호).
  const key = process.env.OPENAI_API_KEY;
  const VLM_MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o";
  if (key) {
    try {
      regions = await splitTallRegions(canvas, buffers, regions, key, VLM_MODEL, log, projectId);
    } catch (e) {
      await log(`분할 검사 실패(거터 컷 유지): ${e?.message ?? e}`);
    }
  }
  mark("긴구간분할");

  // 3) 여백 트림: 각 박스를 그려진 내용에 4변으로 딱 조인다(검은/단색/그라데이션 여백 제거).
  regions = regions.map((r) => ({ yStart: r.yStart, yEnd: r.yEnd, xStart: 0, xEnd: refWidth }));
  await log(`장면 ${regions.length}개 여백 트림…`);
  const trimmed = [];
  for (let i = 0; i < regions.length; i++) {
    if (i % 2 === 0 || i === regions.length - 1)
      await log(`여백 트림 ${i + 1}/${regions.length}… (${Math.round((i / regions.length) * 100)}%)`);
    const r = regions[i];
    const x0 = r.xStart ?? 0;
    const x1 = r.xEnd ?? refWidth;
    let box = { yStart: r.yStart, yEnd: r.yEnd, xStart: x0, xEnd: x1 };
    try {
      const png = await extractRegion(canvas, buffers, r.yStart, r.yEnd, x0, x1);
      const t = await trimBox(png);
      const ny0 = r.yStart + t.top;
      const ny1 = r.yStart + t.bottom;
      const nx0 = x0 + t.left;
      const nx1 = x0 + t.right;
      if (ny1 - ny0 >= 40 && nx1 - nx0 >= 40) box = { yStart: ny0, yEnd: ny1, xStart: nx0, xEnd: nx1 };
    } catch (e) {
      await log(`컷 ${i + 1} 트림 건너뜀: ${e?.message ?? e}`);
    }
    trimmed.push(box);
  }
  regions = trimmed;
  // 가장자리가 그림을 자르고 있으면 내용 끝까지 확장(머리통 절단 방지).
  const grown = extendRegionEdges(regions, global, canvas.totalHeight);
  if (grown) await log(`경계 확장: ${grown}개 컷 가장자리가 그림에 걸려 있어 내용 끝까지 늘림`);
  await log(`최종 장면 ${regions.length}개 · ${memLine()}`);
  mark("여백트림");

  // 4) 컷 온톨로지 분류 — 각 컷의 타입(중심)+내용. 사람이 G1 에서 확정.
  let cuts = regions.map(() => null);
  if (key) {
    try {
      cuts = await classifyScenes(canvas, buffers, regions, key, VLM_MODEL, log, projectId);
    } catch (e) {
      await log(`컷 분류 실패(미분류): ${e?.message ?? e}`);
    }
  }
  mark("컷분류");

  const rawScenes = regions.map((r, idx) => ({
    id: randomUUID(),
    order: idx,
    sourceRegion: { yStart: r.yStart, yEnd: r.yEnd, xStart: r.xStart, xEnd: r.xEnd },
    cut: cuts[idx] ?? undefined,
    status: "review",
  }));
  // 말풍선·효과음(글자만) 컷 흡수 → 대사만 옆 장면에 붙이고 컷은 제거.
  const before = rawScenes.length;
  const scenes = absorbTextCuts(rawScenes).map((s, i) => ({ ...s, order: i }));
  if (scenes.length !== before) await log(`말풍선 컷 흡수: ${before} → ${scenes.length}컷`);
  // 컷 밖 빈 구간(내레이션 등)도 OCR 잡히게 이웃 컷 textRegions 로 예약.
  const gapN = addGapTextRegions(scenes, global, canvas.totalHeight, log);
  if (gapN) await log(`컷 밖 텍스트 구간 ${gapN}개 → 이웃 컷에 OCR 예약`);
  // ── 진단: 텍스트 캡처가 어디서 새는지 보이게 ──
  const typeCounts = {};
  for (const s of scenes) {
    const t = s.cut?.type ?? "(미분류)";
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  const totalTR = scenes.reduce((n, s) => n + (s.cut?.textRegions?.length || 0), 0);
  await log(`[진단] 컷 타입 ${JSON.stringify(typeCounts)}`);
  await log(`[진단] 텍스트 밴드 예약 총 ${totalTR}개(흡수+갭) — 이 수만큼 내레이션이 이웃 컷 OCR에 붙음`);

  // ★대사 읽기 — 컷마다 '풀해상도 자기 이미지'를 하나씩 OCR 한다. (예전엔 340px 대조표
  //   썸네일에 대사를 맡겨 지어냈음 — 사용자가 처음부터 "썸네일론 안 읽힌다" 지적한 근본 버그.)
  //   자기 이미지 + 예약된 내레이션 밴드(위/아래)를 함께 읽어 읽는 순서(y)대로 bubbles/dialogue
  //   에 채운다 → G1 에서 진짜 대사가 바로 보인다. (추출 2단계가 다시 읽어 덮으므로 실패해도 유실 아님.)
  // ★프리뷰(OCR·교정·번역)는 best-effort — 필수 결과인 '경계(scenes)'는 이 뒤에 저장된다.
  //   무거운 프리뷰가 잡 12분 캡을 넘기면 경계까지 통째로 버려진다(열린 버그: OCR교정 다음 멈춤/실패).
  //   → 프리뷰에 soft deadline(잡 시작 t0 기준)을 둬 캡 전에 스스로 멈추고, 아래 저장이 반드시 돌게 한다.
  //   못 읽은 대사는 추출 2단계가 다시 읽어 채우므로 유실 아님.
  const PREVIEW_SOFT_MS = Number(process.env.SPLIT_PREVIEW_SOFT_MS || 9.5 * 60 * 1000);
  const previewBudgetLeft = () => Date.now() - t0 < PREVIEW_SOFT_MS;
  if (key) {
    const ocrTodo = scenes.filter((s) => s.sourceRegion);
    await log(`대사 읽기(풀해상도) ${ocrTodo.length}컷…`);
    // ★속도·메모리 분리 — 준비는 '순차'(한 번에 디코딩 1개), 호출만 '병렬'로 겹쳐 대기시간을 줄인다.
    // ★★그런데 7a69579 에서 개수 캡(NET=8)만 두었다가 Render 워커 OOM 재발.
    //   착오: 동시 '디코딩'은 3→1로 줄었지만, VLM 응답을 기다리는 동안 동시에 '붙들고 있는' 풀해상도
    //   PNG 는 3→8로 늘었다. 디코딩은 순간이고 OOM 을 내는 건 보유량이다.
    //   → 개수가 아니라 **바이트 예산**으로 상한한다. 컷 크기는 작품마다 10배씩 달라서 "N개"라는
    //     캡은 애초에 메모리를 상한하지 못한다(작은 컷이면 8개도 여유, 큰 컷이면 3개도 초과).
    //     보유 바이트가 예산을 넘으면 준비 루프가 스스로 멈춰 기다린다 → 작품 크기와 무관하게 상한.
    const NET = Number(process.env.SPLIT_OCR_NET_CONCURRENCY || 4); // 동시 VLM 호출 수(상한, 보조)
    const MEM_BUDGET = Number(process.env.SPLIT_OCR_MEM_MB || 48) * 1024 * 1024; // 동시 보유 이미지 총량
    const inflight = new Set();
    let heldBytes = 0; // 현재 in-flight 태스크들이 붙들고 있는 이미지 바이트 합
    let done = 0;
    for (const s of ocrTodo) {
      if (!previewBudgetLeft()) {
        await log(`시간 예산 초과 — 남은 대사 읽기는 추출 단계에서(경계는 저장됨)`);
        break;
      }
      // 0) 대기 — 이미 붙들고 있는 이미지가 예산을 넘으면, 새로 만들지 않고 먼저 비운다.
      //    ★준비 '전에' 막아야 한다. 준비 후에 막으면 예산 초과분이 이미 할당된 뒤다(OOM 재발 지점).
      while (inflight.size >= NET || heldBytes >= MEM_BUDGET) await Promise.race(inflight);
      // 1) 준비 — 이 컷 + 예약 내레이션 밴드 이미지를 순차 추출(디코딩 동시 실행 없음).
      let png = null;
      const bands = [];
      try {
        // ★업스케일(prepareOcrImage)까지 여기서 끝낸다 — 아래 병렬 호출 안에 sharp 가 남아 있으면
        //   호출 N개 병렬 = sharp N개 병렬이 되어 OOM(실제 사고). 병렬 구간은 네트워크 전용이어야 한다.
        png = await prepareOcrImage(
          await extractRegion(canvas, buffers, s.sourceRegion.yStart, s.sourceRegion.yEnd, s.sourceRegion.xStart, s.sourceRegion.xEnd)
        );
        const trs = (s.cut?.textRegions ?? []).slice().sort((a, b) => a.yStart - b.yStart);
        for (const tr of trs) {
          try {
            bands.push({
              tr,
              png: await prepareOcrImage(await extractRegion(canvas, buffers, tr.yStart, tr.yEnd, tr.xStart, tr.xEnd)),
            });
          } catch {}
        }
      } catch {
        continue; // 준비 실패한 컷은 건너뜀(추출 2단계가 다시 읽음)
      }
      // 2) 호출 — 준비된 이미지로 VLM 병렬 실행. 보유 바이트를 계상하고, 끝나면 반드시 반납한다.
      const heldNow = png.length + bands.reduce((n, b) => n + b.png.length, 0);
      heldBytes += heldNow;
      let p;
      p = (async () => {
        try {
          const own = await readCutTextPrepared(png, key, VLM_MODEL);
          if (!s.cut) s.cut = { dialogue: "", sfx: "", type: null };
          // 내레이션 밴드(컷 위/아래)도 읽어 순서 보존해 합친다 — 위 밴드는 앞, 아래 밴드는 뒤.
          const above = [];
          const below = [];
          let sfx = own.sfx || "";
          for (const b of bands) {
            try {
              const t = await readCutTextPrepared(b.png, key, VLM_MODEL);
              if (t.bubbles?.length) (b.tr.yStart < s.sourceRegion.yStart ? above : below).push(...t.bubbles);
              if (t.sfx) sfx = sfx ? `${sfx} ${t.sfx}` : t.sfx;
            } catch {}
          }
          const allBubbles = mergeCutBubbles(above, own.bubbles, below).map((b) => ({
            text: b.text,
            ...(b.translation ? { translation: b.translation } : {}),
          }));
          if (allBubbles.length) {
            s.cut.bubbles = allBubbles;
            s.cut.dialogue = allBubbles.map((b) => (b.text || "").trim()).filter(Boolean).join("\n").slice(0, 500);
          }
          if (sfx) s.cut.sfx = sfx;
          s.cut.textBoxes = own.boxes;
        } catch {}
      })()
        .catch(() => {})
        .finally(() => {
          heldBytes -= heldNow; // 반납(성공·실패 무관) — 안 하면 예산이 새서 루프가 영구 정지
          png = null;
          bands.length = 0; // 참조 끊어 GC 가 즉시 회수하게(클로저가 붙들지 않도록)
          inflight.delete(p);
        });
      inflight.add(p);
      done++;
      if (done % 5 === 0 || done === ocrTodo.length) {
        await log(`대사 읽기 ${done}/${ocrTodo.length} (${Math.round((done / ocrTodo.length) * 100)}%) · ${memLine()}`);
      }
    }
    // ★준비(이미지 추출)가 전부 끝났다 — 이제 raw 캐시(파일당 수십 MB)는 짐이다. 실측: 이걸
    //   들고 마지막 응답들을 기다리던 순간이 rss 501/512MB 피크였다. 응답 대기 전에 비운다.
    clearRawCache(buffers);
    await Promise.all([...inflight]); // 남은 호출 마무리
    const withText = scenes.filter((s) => (s.cut?.bubbles ?? []).some((b) => (b.text || "").trim())).length;
    await log(`대사 읽기 완료 — ${withText}/${scenes.length}컷에서 글자 확보 · ${memLine()}`);
  }
  mark("대사읽기");

  // ★OCR 교정(보수적) — 컷마다 따로 읽어 생긴 고유명사 불일치(诺德/诸德/浩德)·오독을 전체 문맥으로
  //   바로잡는다. 번역 전에 원문을 고쳐야 번역도 일관됨. bubble.text 가 바뀌므로 cut.dialogue 재구성.
  try {
    if (!previewBudgetLeft()) throw new Error("시간 예산 초과(추출 단계서 처리)");
    const { fixed, cost } = await proofreadScenes(scenes);
    if (fixed > 0) {
      for (const s of scenes)
        if (s.cut?.bubbles?.length)
          s.cut.dialogue = s.cut.bubbles.map((b) => (b.text || "").trim()).filter(Boolean).join("\n").slice(0, 500);
      await log(`OCR 교정(Claude) ${fixed}줄 — 고유명사 통일·오독 정정(~$${cost.toFixed(4)})`);
    }
  } catch (e) {
    await log(`OCR 교정 건너뜀: ${String(e?.message ?? e).slice(0, 100)}`);
  }
  mark("OCR교정");

  // ★번역(Claude) — G1 검수 화면에 대사·내레이션 뜻이 바로 보이게. 컷 대사 + 말풍선 전부 한 번에.
  try {
    if (!previewBudgetLeft()) throw new Error("시간 예산 초과(추출 단계서 처리)");
    const { translated, cost } = await translateScenes(scenes);
    await log(`대사 번역(Claude) ${translated}줄 채움(~$${cost.toFixed(4)}) — G1에 '역:' 표시`);
    if (!translated && !process.env.ANTHROPIC_API_KEY) await log("⚠ ANTHROPIC_API_KEY 없음 — 번역 스킵됨(워커 env 확인)");
  } catch (e) {
    await log(`번역 실패(대사는 그대로): ${String(e?.message ?? e).slice(0, 120)}`);
  }
  mark("번역");
  await log(`⏱ 단계별 소요: ${marks.join(" · ")}`);

  // 최신 프로젝트를 다시 읽어 결과만 병합(중간에 다른 갱신 있었을 수 있음).
  const p2 = await getProject(projectId);
  if (!p2) throw new Error("프로젝트가 사라졌어요");
  p2.virtualCanvas = canvas;
  p2.scenes = scenes;
  p2.steps.source = {
    ...p2.steps.source,
    kind: "source",
    status: "review", // G1 경계 검수 대기
    error: undefined,
    updatedAt: Date.now(),
  };
  await saveProject(p2);

  // ★★섹션(시퀀스)을 '기본'으로 — 사용자가 찾아 들어가 버튼을 누를 일이 아니다.
  //   시퀀스로 나눠 부분부분 작업하는 게 이 툴의 기본 작업 방식인데, 지금까지는 섹션 바를
  //   찾아 '자동 나누기'를 눌러야 했다(그래서 존재조차 못 봤다는 보고).
  //   → 분할이 끝나면 곧바로 시퀀스 나누기를 자동 적재한다. 사용자는 G1 에 들어오는 순간
  //     이미 섹션 탭이 있는 상태로 시작한다. 텍스트만 쓰는 가벼운 잡이라 부담도 없다.
  //   이미 섹션이 있으면(사람이 손으로 나눴거나 재분할) 건드리지 않는다.
  //   컷이 적으면(12개 이하) 나눌 의미가 없으므로 생략.
  if (!(p2.sectionStarts ?? []).length && scenes.length > 12) {
    try {
      await enqueueJob("sequence", projectId, {});
      await log(`시퀀스 자동 나누기 예약 — 잠시 뒤 섹션 탭이 생깁니다`);
    } catch (e) {
      await log(`시퀀스 자동 나누기 예약 실패(수동으로 나눌 수 있음): ${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  return scenes.length;
}

// ── translate: 대상 언어 번역만 다시 돌린다(재추출 없이) ──────────────────────
//    ★왜 필요한가: 다국어 번역은 지금까지 runExtract 안에서만 돌았다. 그래서 이미 추출을
//    끝낸 프로젝트에서 🌐 대상 언어를 켜도 tracks 가 영원히 비어 있고, 채우려면 전 컷을
//    재추출(재OCR·재업로드, 비싸고 느림)해야 했다 — 사용자: "일본어는 여전히 안 보인다".
//    이 잡은 텍스트만 다룬다(이미지·OCR·업로드 없음) → 싸고 빠르고 메모리도 안 쓴다.
export async function runTranslate(projectId) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[translate]", m);
    await logProgress(projectId, m);
  };
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  if (!scenes.length) throw new Error("번역할 컷이 없어요(분할·추출 먼저)");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY 없음 — Render 워커 환경변수에 넣어주세요");

  // 1) 한국어(역:) — 비어 있는 줄만 채운다(기존 동작과 동일한 함수).
  try {
    const { translated, cost } = await translateScenes(scenes);
    await log(`한국어 번역 ${translated}줄(~$${cost.toFixed(4)})`);
  } catch (e) {
    await log(`한국어 번역 실패(계속): ${String(e?.message ?? e).slice(0, 120)}`);
  }

  // 2) 대상 언어(ja/en …) → bubble.tracks[lang].text
  const langs = Array.isArray(p.targetLanguages) ? p.targetLanguages : [];
  if (!langs.length) throw new Error("대상 언어가 꺼져 있어요 — 🌐 대상 언어에서 일본어·영어를 켜고 다시 실행하세요");
  const { translated: mt, cost: mc } = await translateScenesMultilang(scenes, langs);
  await log(`다국어 번역(${langs.join("·")}) ${mt}줄 tracks 채움(~$${mc.toFixed(4)})`);

  // 저장 규약 — 긴 호출 뒤엔 fresh 재읽기 후 '번역 결과 필드만' 머지.
  // 통째 저장하면 그 사이 워커/사용자가 쓴 오디오·영상 URL 을 덮는다(과거 사고).
  const p2 = await getProject(projectId);
  if (!p2) throw new Error("프로젝트가 사라졌어요");
  const byId = new Map(scenes.map((s) => [s.id, s.cut]));
  p2.scenes = (p2.scenes ?? []).map((fresh) => {
    const cut = byId.get(fresh.id);
    if (!cut || !fresh.cut) return fresh;
    // 말풍선은 인덱스+원문 일치할 때만 번역 필드를 얹는다(그 사이 대사가 바뀌었으면 건드리지 않음).
    const bubbles = (fresh.cut.bubbles ?? []).map((fb, i) => {
      const nb = (cut.bubbles ?? [])[i];
      if (!nb || (nb.text ?? "") !== (fb.text ?? "")) return fb;
      return {
        ...fb,
        ...(nb.translation ? { translation: nb.translation } : {}),
        ...(nb.tracks ? { tracks: { ...(fb.tracks || {}), ...nb.tracks } } : {}),
      };
    });
    return { ...fresh, cut: { ...fresh.cut, bubbles } };
  });
  await saveProject(p2);
  await log(`번역 반영 완료 — G1·씬 목록에서 확인하세요`);
  return mt;
}

// ── sequence: 컷들을 서사 시퀀스로 자동 묶기 → project.sectionStarts(섹션 경계) ────
//    텍스트만 Claude 에 주고 경계를 받는다(저렴·빠름). 결과는 fresh 재읽기 후 필드만 저장(저장 규약).
export async function runSequence(projectId, payload) {
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  if (scenes.length < 4) throw new Error("컷이 적어 시퀀스로 나눌 필요가 없어요");
  const items = scenes.map((s, i) => ({
    i,
    type: s.cut?.type ?? "",
    setting: String(s.cut?.setting || "").slice(0, 80),
    desc: String(s.cut?.description || s.cut?.dialogue || "").replace(/\s+/g, " ").slice(0, 120),
  }));
  const target = Number(payload?.targetCount) > 1 ? Number(payload.targetCount) : undefined;
  await logProgress(projectId, `시퀀스 자동 나누기 — ${scenes.length}컷 분석 중…`);
  const { starts, cost, error } = await groupIntoSequences(items, target);
  if (error) throw new Error(`시퀀스 나누기 실패: ${error}`);
  const norm = [...new Set([0, ...starts.filter((x) => x > 0 && x < scenes.length)])].sort((a, b) => a - b);
  const p2 = await getProject(projectId);
  if (!p2) throw new Error("프로젝트가 사라졌어요");
  p2.sectionStarts = norm.length > 1 ? norm : undefined; // 경계 못 찾으면 해제(전체 한 덩어리)
  await saveProject(p2);
  try {
    await recordCost({ projectId, vendor: "anthropic", model: "claude-sequence", costUsd: cost, meta: { kind: "sequence", cuts: scenes.length, sections: Math.max(1, norm.length) } });
  } catch {}
  await logProgress(projectId, `시퀀스 ${Math.max(1, norm.length)}개로 나눔(~$${cost.toFixed(4)})`);
  return Math.max(1, norm.length);
}

// ── extract: G1 확정된 경계로 컷 이미지 추출 → Blob → Scene.originalImage ─────
export async function runExtract(projectId, payload) {
  const log = async (m) => {
    console.error("[extract]", m);
    await logProgress(projectId, m);
  };

  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  if (!p.virtualCanvas) throw new Error("가상 캔버스가 없어요(분할 먼저)");
  const files = sortedFiles(p);
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  if (scenes.length === 0) throw new Error("추출할 컷이 없어요");
  // ★섹션(시퀀스) 단위 작업 — payload.sceneIds 가 오면 그 컷들만 처리한다.
  //   회분 전체를 한 잡에 몰아 넣으면 12분 잡 캡을 넘기고 메모리도 겹쳐 터진다.
  //   내레이션 밴드 재예약(addGapTextRegions)은 경계 계산이라 전체 기준으로 그대로 두고,
  //   무거운 작업(추출·업로드·OCR·연출·교정·번역)만 선택 범위로 좁힌다.
  const selIds = Array.isArray(payload?.sceneIds) && payload.sceneIds.length ? new Set(payload.sceneIds) : null;
  let work = selIds ? scenes.filter((s) => selIds.has(s.id)) : scenes;
  if (work.length === 0) throw new Error("선택한 섹션에 컷이 없어요");
  if (selIds) await log(`섹션 작업: 컷 ${work.length}개만 처리(회분 전체 ${scenes.length}개)`);
  // ★버튼 하나 원칙(사용자 인터페이스 지침) — 섹션 없이 통째로 들어와도 사람이 먼저 뭘
  //   나눌 필요 없게, 여기서 8컷씩 자동 분절해 이어달리기한다. 추출의 안전 분절은 서사
  //   섹션과 별개라 UI 섹션(sectionStarts)은 건드리지 않는다. 통째 실행(실측 501/512MB)이
  //   죽음의 조건이었으므로, '나눠져 있지 않으면 통째로 돈다'는 경로 자체를 없앤다.
  if (!selIds && !(Array.isArray(payload?.nextSections) && payload.nextSections.length) && work.length > 10) {
    const CHUNK = Math.max(4, Number(process.env.EXTRACT_CHUNK || 8));
    const ids = work.map((s) => s.id);
    const chunks = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    const first = new Set(chunks[0]);
    work = work.filter((s) => first.has(s.id));
    payload = { ...(payload ?? {}), nextSections: chunks.slice(1) };
    await log(`자동 분절: ${ids.length}컷 → ${chunks.length}묶음(${CHUNK}컷씩) 이어달리기 — 묶음마다 저장`);
  }

  await log(`소스 ${files.length}개 다운로드…`);
  const buffers = [];
  for (const f of files) buffers.push(await download(f.url));

  // ★내레이션 재예약(구조 수정): 분할이 예약한 textRegions 를 G1 경계 저장(/api/boundaries
  //   cleanCut)이 지워버려 추출은 늘 '밴드 0개'로 돌았다(= 내레이션 반복 소실의 원인).
  //   소비자인 추출이 시작할 때 '최종 경계' 기준으로 컷 밖 텍스트 밴드를 다시 계산해 예약한다
  //   → 경계를 어떤 경로(G1 저장·재분할·컷 분할/합병)로 고쳤어도 안 사라진다.
  //   이미 있는 밴드와 겹치면 스킵(addGapTextRegions 내장)이라 중복 OCR 없음.
  try {
    const global = new Float32Array(p.virtualCanvas.totalHeight);
    let acc = 0;
    for (const buf of buffers) {
      const { profile } = await computeRowProfile(buf, p.virtualCanvas.refWidth);
      const room = global.length - acc;
      if (room <= 0) break;
      global.set(room >= profile.length ? profile : profile.subarray(0, room), acc);
      acc += profile.length;
    }
    const gapN = addGapTextRegions(scenes, global, p.virtualCanvas.totalHeight, log);
    const totalTR = scenes.reduce((n, s) => n + (s.cut?.textRegions?.length || 0), 0);
    await log(`[진단] 내레이션 밴드: 추출 직전 재예약 ${gapN}개 → 총 ${totalTR}개`);
  } catch (e) {
    await log(`내레이션 밴드 재예약 실패(추출은 계속): ${String(e?.message ?? e).slice(0, 80)}`);
  }

  // ★ 증분: 이미 추출된 컷(originalImage 있음 = 경계 안 바뀜)은 건너뛴다. 새/바뀐 컷만.
  const todo = work.filter((s) => !s.originalImage);
  await log(`추출 대상 ${todo.length}컷 (범위 ${work.length}, 기존 유지 ${work.length - todo.length})`);
  for (const s of scenes) if (s.originalImage) s.status = "approved";

  // ★ 메모리: 추출 PNG 를 전부 들고 있지 않는다(예전 pngById 41장 누적 → raw 캔버스+소스와
  // 겹쳐 OOM 크래시=먹통). 컷당 추출→업로드만 하고 버림. OCR 은 아래에서 그 영역만 다시 추출.
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i];
    await log(`컷 추출·업로드 ${i + 1}/${todo.length}… (${Math.round((i / todo.length) * 100)}%)`);
    try {
      const png = await extractRegion(
        p.virtualCanvas,
        buffers,
        s.sourceRegion.yStart,
        s.sourceRegion.yEnd,
        s.sourceRegion.xStart,
        s.sourceRegion.xEnd
      );
      const { url } = await put(
        `project/${projectId}/cut-${s.order}-${Date.now()}.png`,
        png,
        { access: "public", contentType: "image/png", addRandomSuffix: false }
      );
      s.originalImage = url;
      s.status = "approved";
    } catch (e) {
      await log(`컷 ${s.order + 1} 추출 실패: ${String(e?.message ?? e).slice(0, 100)}`);
    }
  }

  // 글씨 읽기(OCR) — ★ 증분 아님. 이미지 있는 '모든' 컷을 매번 다시 읽는다(예전엔 새 컷만
  // 읽어서, 재추출해도 옛 컷 대사가 안 갱신됐음). 메모리 위해 그 영역만 다시 추출해서 읽음.
  const key = process.env.OPENAI_API_KEY;
  const ocrTodo = work.filter((s) => s.originalImage);
  if (key && ocrTodo.length > 0) {
    const OCR_MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o";
    const C = Number(process.env.OCR_CONCURRENCY || 2); // 업스케일 이미지가 커서 동시성 낮게
    let done = 0;
    let trTotal = 0; // [진단] textRegion(넘어온 내레이션 밴드) OCR 시도/성공 수
    let trHit = 0;
    let dirOk = 0; // [진단] AI 연출 성공 컷 수
    let dirCost = 0; // AI 연출 비용 합계(USD)
    let trlOk = 0; // [진단] 번역 채운 줄 수(OCR가 원문과 함께 뽑음)
    let tileOk = 0; // [진단] 타일 OCR 이 풀이미지가 놓친 컷 안 캡션을 회수한 줄 수
    for (let i = 0; i < ocrTodo.length; i += C) {
      const chunk = ocrTodo.slice(i, i + C);
      await Promise.all(
        chunk.map(async (s) => {
          try {
            if (!s.cut) s.cut = { dialogue: "", sfx: "", type: null };
            // ★이중 OCR 제거: 분할이 이미 풀해상도로 읽어 bubbles 를 채웠으면 다시 안 읽는다(추출 시간
            //   대폭 절약, 검토한 대사=결과 일관성도 ↑). 경계 바뀐 컷은 저장 라우트가 bubbles 를 비워 재OCR.
            const hasSplitText = (s.cut.bubbles ?? []).some((b) => (b.text || "").trim());
            const needCam = !(s.cut.motion || "").trim();
            const needDur = s.cut.durationSec == null;
            const needTrans = s.cut.transition == null;
            const needAction = s.cut.action == null;
            const needEmo = (s.cut.bubbles ?? []).some((b) => !b.emotion && b.speakerId !== "__sfx__" && (b.text || "").trim());
            const needSubY = (s.cut.bubbles ?? []).some((b) => b.subtitleY == null && b.speakerId !== "__sfx__" && (b.text || "").trim());
            const needsDirect = needCam || needDur || needTrans || needAction || needEmo || needSubY;
            // ★필요할 때만 픽셀 추출 — 예전엔 OCR·연출을 전부 건너뛸 컷도 무조건 풀해상도 PNG 를
            //   뽑았다(동시 2개). 재추출처럼 대사·연출이 이미 있는 프로젝트에서 이 루프가
            //   '글씨 읽기 8/15'에서 메모리로 죽던 원인(2026-08-02 실측 로그). 안 쓸 이미지는 안 만든다.
            const png = (!hasSplitText || needsDirect)
              ? await extractRegion(
                  p.virtualCanvas,
                  buffers,
                  s.sourceRegion.yStart,
                  s.sourceRegion.yEnd,
                  s.sourceRegion.xStart,
                  s.sourceRegion.xEnd
                )
              : null;
            if (!hasSplitText) {
            const own = await readCutTextTiled(png, key, OCR_MODEL);
            tileOk += own.tiledAdded || 0;
            // ★ OCR(풀해상도)이 이 컷 대사의 유일 정답. 자기 이미지 안 글자 = own.
            // ★읽는 순서 보존: 밴드를 y 오름차순으로 돌고, 컷 '위' 밴드 글은 컷 안 글보다
            //   앞에, '아래' 밴드 글은 뒤에 둔다(위 문장이 아래로 가는 역전 방지).
            const above = [];
            const below = [];
            let sfx = own.sfx || "";
            const trs = (s.cut.textRegions ?? []).slice().sort((a, b) => a.yStart - b.yStart);
            for (const tr of trs) {
              try {
                const tpng = await extractRegion(
                  p.virtualCanvas,
                  buffers,
                  tr.yStart,
                  tr.yEnd,
                  tr.xStart,
                  tr.xEnd
                );
                const t = await readCutText(tpng, key, OCR_MODEL);
                trTotal++;
                if (t.bubbles?.length) {
                  (tr.yStart < s.sourceRegion.yStart ? above : below).push(...t.bubbles);
                  trHit++;
                }
                if (t.sfx) sfx = sfx ? `${sfx} ${t.sfx}` : t.sfx;
              } catch {}
            }
            let allBubbles = mergeCutBubbles(above, own.bubbles, below); // ★자기이미지↔밴드 중복 대사 제거
            // 풍선별 speakerId 는 기존 값(텍스트 매칭)으로 보존해 화자 귀속이 안 날아가게.
            s.cut.bubbles = mergeBubbleSpeakers(allBubbles, s.cut.bubbles, s.cut.speakerId);
            s.cut.dialogue = allBubbles
              .map((b) => (b.text || "").trim())
              .filter(Boolean)
              .join("\n")
              .slice(0, 500);
            if (sfx) s.cut.sfx = sfx;
            s.cut.textBoxes = own.boxes; // 마스크는 '이 컷 이미지 안' 글자만(흡수 밴드는 이미지에 없음)
            trlOk += (s.cut.bubbles ?? []).filter((b) => (b.translation || "").trim()).length;
            } // end if(!hasSplitText) — 분할 대사 재사용 시 위 OCR 블록 스킵
            // ── AI 연출: 번역을 읽고 풀 연출안(카메라·길이·전환·동작·줄별 감정·자막위치)을
            //   디폴트로 채운다. ★사용자가 이미 지정한 값은 절대 안 덮는다(미지정 필드만).
            if (needsDirect) {
              try {
                const lines = (s.cut.bubbles ?? [])
                  .map((b, bi) => ({ index: bi, speaker: b.speakerId === "__sfx__" ? null : b.speakerId ? "character" : "narration", text: (b.text || "").trim(), translation: (b.translation || "").trim() }))
                  .filter((l) => l.speaker && l.text);
                const d = await directCut(png, s.cut, lines);
                if (d) {
                  if (needCam && d.camera !== "none" && CAMERA_PROMPTS[d.camera]) {
                    s.cut.motion = CAMERA_PROMPTS[d.camera]; // I2V 프롬프트용(기존)
                    // ★★그리고 '카메라 미리보기·굽기가 실제로 읽는' 구조체에도 넣는다.
                    //   이게 없어서 AI 연출이 카메라를 정해도 카메라 탭은 늘 '정지'였다(열흘 버그).
                    //   사람이 이미 직접 지정한 컷은 덮지 않는다(수동 우선).
                    const pre = DIRECTOR_CAMERA_TO_PRESET[d.camera];
                    if (pre && !s.cut.cameraWork) {
                      const dur = Number(s.cut.durationSec) || Number(d.durationSec) || 3.5;
                      s.cut.cameraWork = resolveCameraWork(pre, { duration_s: dur }, dur);
                    }
                  }
                  if (needDur && d.durationSec) s.cut.durationSec = d.durationSec;
                  if (needTrans && d.transition) s.cut.transition = d.transition;
                  if (needAction) s.cut.action = d.action; // "" 도 저장 → '동작 없음'으로 확정(재실행 방지)
                  for (const e of d.emotions) {
                    const b = s.cut.bubbles?.[e.index];
                    if (!b || b.speakerId === "__sfx__" || !(b.text || "").trim()) continue;
                    if (!b.emotion && e.emotion !== "none") b.emotion = e.emotion;
                    if (b.subtitleY == null && typeof e.subtitleY === "number") b.subtitleY = e.subtitleY;
                  }
                  dirOk++;
                  dirCost += d.costUsd || 0;
                }
              } catch (e) {
                await log(`컷 ${s.order + 1} ${String(e?.message ?? e).slice(0, 120)}`);
              }
            }
          } catch (e) {
            await log(`컷 ${s.order + 1} 글씨읽기 실패: ${String(e?.message ?? e).slice(0, 100)}`);
          }
        })
      );
      done = Math.min(i + C, ocrTodo.length);
      await log(`글씨 읽기 ${done}/${ocrTodo.length} (${Math.round((done / ocrTodo.length) * 100)}%) · ${memLine()}`);
    }
    await log(`[진단] 내레이션 밴드 OCR: ${trHit}/${trTotal} 성공(글자 잡힘) — 0/0이면 밴드가 분할서 안 넘어온 것`);
    if (trlOk > 0) {
      await log(`[진단] 대사 번역: ${trlOk}줄 (OCR가 원문과 함께 뽑음 — 별도 비용 없음, 원문·더빙은 그대로)`);
    }
    if (tileOk > 0) {
      await log(`[진단] 타일 OCR 회수: ${tileOk}줄 — 풀이미지가 놓친 컷 안 캡션(테두리 없는 내레이션 등)`);
    }
    if (dirOk > 0) {
      await log(`[진단] AI 연출: ${dirOk}컷에 카메라·감정 디폴트 채움(Claude, $${dirCost.toFixed(3)})`);
      try {
        await recordCost({
          projectId,
          vendor: "anthropic",
          model: process.env.CLAUDE_DIRECTOR_MODEL || "claude-opus-4-8",
          costUsd: dirCost,
          meta: { kind: "direct", cuts: dirOk },
        });
      } catch {}
    } else if (!process.env.ANTHROPIC_API_KEY) {
      await log("AI 연출 건너뜀 — 워커 env 에 ANTHROPIC_API_KEY 를 넣으면 카메라·감정 자동 지정");
    }
  }
  // ★픽셀 작업 끝 — 이후(교정·번역·저장)는 전부 텍스트다. raw 캐시(파일당 수십 MB)와
  //   소스 원본 버퍼를 여기서 내려놓아 뒤 단계가 벼랑 끝에서 돌지 않게 한다(분할과 동일 처방).
  clearRawCache(buffers);
  buffers.length = 0;

  for (const s of scenes) { normalizeNarration(s.cut); normalizeSfx(s.cut); } // 내레이션·효과음 문자열 → 통제 가능한 말풍선으로 통일

  // ★중간 저장 — 추출은 끝에서만 저장해서, 막판(번역·저장 직전)에 죽으면 OCR·연출 결과가
  //   전부 증발하고 다음 실행이 같은 무게로 처음부터 다시 돌다 같은 곳에서 죽는 루프가 됐다
  //   (2026-08-02 19:12 실측: 다국어 번역까지 마치고 저장 직전 사망 → 전량 소실).
  //   무거운 단계가 끝날 때마다 fresh 재읽기+컷 머지로 저장(저장 규약 준수) — 죽어도 전진한다.
  const midSave = async (label) => {
    try {
      const pm = await getProject(projectId);
      if (!pm) return;
      const doneById = new Map(work.map((s) => [s.id, s]));
      pm.scenes = (pm.scenes ?? []).map((fresh) => doneById.get(fresh.id) ?? fresh);
      await saveProject(pm);
      await log(`중간 저장(${label}) — 여기까지의 결과는 죽어도 보존됩니다 · ${memLine()}`);
    } catch (e) {
      await log(`중간 저장(${label}) 실패(계속): ${String(e?.message ?? e).slice(0, 80)}`);
    }
  };
  await midSave("글씨·연출");

  // ★OCR 교정(보수적) — 추출 단계에서도 오독·고유명사 불일치를 전체 문맥으로 잡는다(단계마다 검출).
  //   기존 프로젝트도 추출 재실행 때 교정됨. bubble.text 교정 → cut.dialogue 재구성 후 번역.
  try {
    const { fixed, cost } = await proofreadScenes(work);
    if (fixed > 0) {
      for (const s of scenes)
        if (s.cut?.bubbles?.length)
          s.cut.dialogue = s.cut.bubbles.map((b) => (b.text || "").trim()).filter(Boolean).join("\n").slice(0, 500);
      await log(`OCR 교정(Claude) ${fixed}줄 — 고유명사 통일·오독 정정(~$${cost.toFixed(4)})`);
    }
  } catch (e) {
    await log(`OCR 교정 건너뜀: ${String(e?.message ?? e).slice(0, 100)}`);
  }
  // ★번역(Claude) — 추출된 말풍선 대사 전부 한국어로. 이후 모든 단계(캐스팅·편집기·미리보기)에 '역:' 표시.
  try {
    const { translated, cost } = await translateScenes(work);
    await log(`대사 번역(Claude) ${translated}줄 채움(~$${cost.toFixed(4)})`);
    if (!translated && !process.env.ANTHROPIC_API_KEY) await log("⚠ ANTHROPIC_API_KEY 없음 — 번역 스킵됨(워커 env 확인)");
  } catch (e) {
    await log(`번역 실패(대사는 그대로): ${String(e?.message ?? e).slice(0, 120)}`);
  }
  await midSave("교정·번역");
  // ── 다국어 번역(§10) — 프로젝트에 targetLanguages 설정 시 원어→각 언어 tracks 채움. 미설정이면 스킵(기존 무영향). ──
  try {
    const proj = await getProject(projectId);
    const langs = Array.isArray(proj?.targetLanguages) ? proj.targetLanguages : [];
    if (langs.length) {
      const { translated: mt, cost: mc } = await translateScenesMultilang(work, langs);
      await log(`다국어 번역(${langs.join("·")}) ${mt}줄 tracks 채움(~$${mc.toFixed(4)})`);
    }
  } catch (e) {
    await log(`다국어 번역 스킵: ${String(e?.message ?? e).slice(0, 100)}`);
  }
  const p2 = await getProject(projectId);
  if (!p2) throw new Error("프로젝트가 사라졌어요");
  // ★저장 규약 — 통째 덮지 않고 '이번에 처리한 컷'만 머지한다.
  //   섹션을 순차로 돌리면 앞 섹션에서 생성한 영상·더빙 결과가 이 잡 시작 시점 스냅샷으로
  //   되돌아갈 수 있다(긴 잡 + 통째 저장 = 과거 사고 패턴).
  const doneById = new Map(work.map((s) => [s.id, s]));
  p2.scenes = (p2.scenes ?? []).map((fresh) => doneById.get(fresh.id) ?? fresh);
  // ★섹션 이어달리기 — 남은 섹션이 있으면 저장 후 다음 섹션 추출 잡을 스스로 적재하고
  //   running 을 유지한다(마지막 섹션에서만 approved). 한 잡=한 섹션 → 12분 캡·메모리
  //   벼랑에서 자유롭고, 죽어도 그 섹션만 잃는다(섹션 중심 설계 — 사용자 지정).
  const nextSections = Array.isArray(payload?.nextSections)
    ? payload.nextSections.filter((a) => Array.isArray(a) && a.length > 0)
    : [];
  if (nextSections.length > 0) {
    p2.steps.source = {
      ...p2.steps.source,
      kind: "source",
      status: "running",
      error: undefined,
      updatedAt: Date.now(),
    };
    await saveProject(p2);
    await enqueueJob("extract", projectId, {
      sceneIds: nextSections[0],
      nextSections: nextSections.slice(1),
    });
    await log(`이 섹션 완료·저장 — 다음 섹션 추출을 이어갑니다(남은 ${nextSections.length}구간)`);
    return work.length;
  }
  p2.steps.source = {
    ...p2.steps.source,
    kind: "source",
    status: "approved", // 1단계 완료 → 이후 M2 진입 가능
    error: undefined,
    updatedAt: Date.now(),
  };
  await saveProject(p2);
  return scenes.length;
}

// ── resplit: 한 컷(order)을 다시 분할 → 서브컷으로 교체 → G1 재검수 ────────────
export async function runResplit(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[resplit]", m);
    await logProgress(projectId, m);
  };

  const order = Number(payload?.order);
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  if (!p.virtualCanvas) throw new Error("가상 캔버스가 없어요");
  const canvas = p.virtualCanvas;
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  const target = scenes.find((s) => s.order === order) ?? scenes[order];
  if (!target) throw new Error("재분할할 컷을 찾을 수 없어요");

  const cfg = loadSplitConfig();
  const files = sortedFiles(p);
  await log(`소스 ${files.length}개 다운로드…`);
  const buffers = [];
  for (const f of files) buffers.push(await download(f.url));

  // 전역 프로파일 → 대상 구간 슬라이스 → 더 민감한 거터 재검출.
  await log("대상 구간 프로파일…");
  const global = new Float32Array(canvas.totalHeight);
  let acc = 0;
  for (const buf of buffers) {
    const { profile } = await computeRowProfile(buf, canvas.refWidth);
    const room = global.length - acc;
    if (room <= 0) break;
    global.set(room >= profile.length ? profile : profile.subarray(0, room), acc);
    acc += profile.length;
  }
  const y0 = Math.round(target.sourceRegion.yStart);
  const y1 = Math.round(target.sourceRegion.yEnd);
  const cfg2 = {
    ...cfg,
    minGapPx: Math.max(12, Math.round((cfg.minGapPx ?? 40) / 2)),
    minSceneHeightPx: Math.max(30, Math.round((cfg.minSceneHeightPx ?? 60) / 2)),
  };
  let subs = detectRegions(global.subarray(y0, y1), cfg2).map((r) => ({
    yStart: y0 + r.yStart,
    yEnd: y0 + r.yEnd,
  }));
  if (subs.length === 0) subs = [{ yStart: y0, yEnd: y1 }];
  await log(`거터 재검출 ${subs.length}개`);

  // VLM 강제 분할(경계 있을 때만) — 거터로 못 나눈 붙은 장면도 나눔.
  const key = process.env.OPENAI_API_KEY;
  const VLM_MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o";
  if (key) {
    const out = [];
    for (const s of subs) {
      try {
        out.push(...(await forceSplit(canvas, buffers, s, key, VLM_MODEL, log)));
      } catch (e) {
        await log(`VLM 분할 실패(유지): ${e?.message ?? e}`);
        out.push(s);
      }
    }
    subs = out;
  }

  // 여전히 1개면(강한 경계 못 찾음) 가장 평탄한 행에서 강제 2분할 — 사람이 '분할'을
  // 눌렀으니 최소 한 번은 나눈다. 평탄(=거터 같은) 행을 골라 인물 몸 관통 최소화.
  if (subs.length === 1 && subs[0].yEnd - subs[0].yStart >= 120) {
    const s = subs[0];
    const lo = s.yStart + Math.round((s.yEnd - s.yStart) * 0.3);
    const hi = s.yStart + Math.round((s.yEnd - s.yStart) * 0.7);
    let bestY = -1;
    let bestStd = Infinity;
    for (let y = lo; y < hi; y++) {
      if (global[y] < bestStd) {
        bestStd = global[y];
        bestY = y;
      }
    }
    if (bestY > s.yStart + 20 && bestY < s.yEnd - 20) {
      subs = [
        { yStart: s.yStart, yEnd: bestY },
        { yStart: bestY, yEnd: s.yEnd },
      ];
      await log(`강제 2분할 @${bestY} (평탄도 ${bestStd.toFixed(1)})`);
    }
  }

  // 여백 트림(대상의 x 범위 상속).
  const x0 = target.sourceRegion.xStart ?? 0;
  const x1 = target.sourceRegion.xEnd ?? canvas.refWidth;
  const trimmed = [];
  for (const s of subs) {
    let box = { yStart: s.yStart, yEnd: s.yEnd, xStart: x0, xEnd: x1 };
    try {
      const png = await extractRegion(canvas, buffers, s.yStart, s.yEnd, x0, x1);
      const t = await trimBox(png);
      const ny0 = s.yStart + t.top;
      const ny1 = s.yStart + t.bottom;
      const nx0 = x0 + t.left;
      const nx1 = x0 + t.right;
      if (ny1 - ny0 >= 40 && nx1 - nx0 >= 40) box = { yStart: ny0, yEnd: ny1, xStart: nx0, xEnd: nx1 };
    } catch (e) {
      await log(`트림 건너뜀: ${e?.message ?? e}`);
    }
    trimmed.push(box);
  }
  await log(`재분할 결과 ${trimmed.length}개`);

  // 새 서브컷 분류.
  let cuts = trimmed.map(() => null);
  if (key) {
    try {
      cuts = await classifyScenes(canvas, buffers, trimmed, key, VLM_MODEL, log, projectId);
    } catch (e) {
      await log(`재분류 실패(미분류): ${e?.message ?? e}`);
    }
  }

  const newScenes = trimmed.map((b, k) => ({
    id: randomUUID(),
    order: 0,
    sourceRegion: b,
    cut: cuts[k] ?? undefined,
    status: "review",
  }));

  // 대상 컷을 새 서브컷으로 교체, 전체 정렬·order 재부여.
  const p2 = await getProject(projectId);
  if (!p2) throw new Error("프로젝트가 사라졌어요");
  const kept = (p2.scenes ?? []).filter((s) => s.id !== target.id);
  const merged = [...kept, ...newScenes].sort(
    (a, b) => a.sourceRegion.yStart - b.sourceRegion.yStart
  );
  p2.scenes = absorbTextCuts(merged).map((s, i) => ({ ...s, order: i }));
  p2.steps.source = {
    ...p2.steps.source,
    kind: "source",
    status: "review",
    error: undefined,
    updatedAt: Date.now(),
  };
  await saveProject(p2);
  return newScenes.length;
}

// ── cast(M2): 캐릭터 타입 컷을 VLM 이 인물별로 묶어 캐스트 생성 → G0 검수 ────────
export async function runCast(projectId) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[cast]", m);
    await logProgress(projectId, m);
  };

  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  if (!p.virtualCanvas) throw new Error("가상 캔버스가 없어요(분할 먼저)");
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  const charScenes = scenes.filter((s) => s.cut?.type && CHARACTER_TYPES.has(s.cut.type));
  await log(`인물 컷 ${charScenes.length}개 (전체 ${scenes.length})`);

  let cast = [];
  const buffers = []; // 화자 추론 패스도 씀 — 블록 밖으로 호이스트
  if (charScenes.length > 0) {
    const files = sortedFiles(p);
    await log(`소스 ${files.length}개 다운로드…`);
    for (const f of files) buffers.push(await download(f.url));

    const key = process.env.OPENAI_API_KEY;
    const VLM_MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o";
    cast = await classifyCast(p.virtualCanvas, buffers, charScenes, key, VLM_MODEL, log, projectId);
  }

  const p2 = await getProject(projectId);
  if (!p2) throw new Error("프로젝트가 사라졌어요");
  p2.cast = cast;

  // 화자 자동 귀속: 대사 있는 컷에 배정된 캐릭터가 정확히 1명이면 그 사람이 화자.
  const charsBySceneId = new Map();
  for (const c of cast) {
    for (const sid of c.sceneIds) {
      if (!charsBySceneId.has(sid)) charsBySceneId.set(sid, []);
      charsBySceneId.get(sid).push(c.id);
    }
  }
  let attributed = 0;
  for (const s of p2.scenes ?? []) {
    if (!s.cut) continue;
    const hasDialogue =
      (s.cut.dialogue && s.cut.dialogue.trim()) ||
      (s.cut.type === "text" && s.cut.textKind === "dialogue");
    if (!hasDialogue) continue;
    const chars = charsBySceneId.get(s.id) ?? [];
    if (chars.length === 1) {
      s.cut.speakerId = chars[0];
      attributed++;
    } else if (s.cut.speakerId === undefined) {
      s.cut.speakerId = null; // 애매(0명·여러명) → 사람이 지정
    }
  }
  await log(`화자 자동 귀속 ${attributed}건`);

  // ★화자 자동 배정(VLM) — 컷 이미지 + 앞뒤 컷 맥락 + 캐스트 명단으로 각 대사 줄의 화자를
  //   추론해 기본값으로 채운다(사용자 요구: 자동으로 골라주고 사람은 나중에 터치만).
  //   이미 지정된 줄(speakerId !== undefined)은 절대 안 건드린다. 판단 불가는 미지정으로 남김.
  const keyA = process.env.OPENAI_API_KEY;
  const VLM_A = process.env.OPENAI_VLM_MODEL || "gpt-4o";
  if (keyA && cast.length > 0 && buffers.length > 0) {
    const scList = (p2.scenes ?? []).slice().sort((a, b) => a.order - b.order);
    // ★추론 대상 = 캐릭터로 안 정해진 모든 줄(undefined + null). null(내레이션)도 다시 판정한다 —
    //   추출/화면 저장 경로가 전 줄을 null 로 깔아버려 '미지정만' 조건이면 대상 0개가 됨(실측).
    //   보호는 문자열 id(캐릭터·효과음)만: 사람이 캐릭터로 고른 줄은 절대 안 덮는다.
    const open = (b) => b.speakerId == null && (b.text || "").trim();
    const todo = scList.filter((s) => (s.cut?.bubbles ?? []).some(open));
    const roster = cast.map((c) => `${c.id}: ${c.label}${c.note ? " — " + c.note : ""}`).join("\n");
    const castIds = new Set(cast.map((c) => c.id));
    await log(`화자 추론(앞뒤 맥락) 대상 ${todo.length}컷…`);
    let assigned = 0;
    let usdA = 0;
    const CC = 2;
    for (let i = 0; i < todo.length; i += CC) {
      await Promise.all(
        todo.slice(i, i + CC).map(async (s) => {
          try {
            const idx = scList.findIndex((x) => x.id === s.id);
            // ★캐스팅 반영 — 화자 후보를 '이 컷 + 앞뒤 컷에 나오는 인물'로 좁힌다(전체 명단 X →
            //   이 장면에 없는 인물로 오배정되던 것 급감). 좁힌 명단이 비면 전체로 폴백.
            const near = new Set(charsBySceneId.get(s.id) ?? []);
            for (const adj of [scList[idx - 1], scList[idx + 1]])
              for (const cid of (adj && charsBySceneId.get(adj.id)) || []) near.add(cid);
            const sceneRoster =
              cast.filter((c) => near.has(c.id)).map((c) => `${c.id}: ${c.label}${c.note ? " — " + c.note : ""}`).join("\n") || roster;
            const ctx = (x) =>
              x
                ? `컷${x.order + 1}(${x.cut?.type ?? "?"}): ${(x.cut?.description ?? "").slice(0, 80)} / 대사: ${(x.cut?.bubbles ?? [])
                    .map((b) => (b.translation || b.text || "").slice(0, 25))
                    .join(" | ")
                    .slice(0, 120)}`
                : "(없음)";
            const png = await extractRegion(
              p2.virtualCanvas,
              buffers,
              s.sourceRegion.yStart,
              s.sourceRegion.yEnd,
              s.sourceRegion.xStart,
              s.sourceRegion.xEnd
            );
            const img = await sharp(png).resize({ width: 512, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
            const ask = (s.cut.bubbles ?? [])
              .map((b, bi) => ({ bi, t: (b.text || "").trim(), tr: (b.translation || "").trim(), open: open(b) }))
              .filter((l) => l.open);
            if (!ask.length) return;
            const body = {
              model: VLM_A,
              temperature: 0,
              response_format: { type: "json_object" },
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "image_url", image_url: { url: "data:image/jpeg;base64," + img.toString("base64") } },
                    {
                      type: "text",
                      text:
                        `웹툰 컷 이미지와 앞뒤 맥락으로 각 대사 줄의 화자를 정하라.\n★이 장면에 등장하는 인물 명단(id: 이름) — 화자는 원칙적으로 이 안에서 고른다:\n${sceneRoster}\n\n` +
                        `앞 컷: ${ctx(scList[idx - 1])}\n뒤 컷: ${ctx(scList[idx + 1])}\n\n이 컷의 대사 줄:\n` +
                        ask.map((l) => `${l.bi}. ${l.t.slice(0, 60)}${l.tr ? ` (뜻: ${l.tr.slice(0, 60)})` : ""}`).join("\n") +
                        `\n\n규칙: 장면 밖 서술·해설이면 "narration". 명단 인물이 말하는 대사면 그 id(입 모양·시선·말풍선 꼬리·앞뒤 대화 흐름으로 판단). ` +
                        `★★핵심: 이 컷에 보이는 인물이 '말하는 쪽'이 아니라 '듣는 쪽'일 수 있다 — 입이 닫혀 있거나(리액션·놀람·경청 표정), 말풍선 꼬리가 화면 밖을 가리키면 화자는 이 컷에 안 보이는 다른 인물이다. 대화는 보통 번갈아 오가니(A→B→A), 그럴 땐 앞 컷 화자와 다른 인물(주로 그 상대)이 말하는 것으로 봐라. 보이는 인물을 무조건 화자로 찍지 마라. ` +
                        `★이 컷 화면에 안 보이는 인물이 말할 수도 있다(오프스크린 대사) — 호명·대화 흐름·번갈아 말하기상 명단 인물이 확실하면 그 id 를 써라. 판단이 어려우면 "unknown". ` +
                        `JSON 만: {"speakers":[{"i":줄번호,"s":"id|narration|unknown"}]}`,
                    },
                  ],
                },
              ],
            };
            const r = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { authorization: `Bearer ${keyA}`, "content-type": "application/json" },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(60_000),
            });
            if (!r.ok) return;
            const j = await r.json();
            usdA += ((j.usage?.prompt_tokens ?? 0) * 2.5 + (j.usage?.completion_tokens ?? 0) * 10) / 1e6;
            const out = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
            for (const e of out.speakers ?? []) {
              const b = s.cut.bubbles?.[e.i];
              if (!b || typeof b.speakerId === "string") continue; // 캐릭터·효과음으로 지정된 줄만 보호
              if (e.s === "narration") {
                b.speakerId = null;
                assigned++;
              } else if (castIds.has(e.s)) {
                b.speakerId = e.s;
                assigned++;
              }
            }
          } catch {}
        })
      );
      const done = Math.min(i + CC, todo.length);
      if (done === todo.length || done % 10 < CC) await log(`화자 추론 ${done}/${todo.length}…`);
    }
    await log(`[진단] 화자 자동 배정 ${assigned}줄 (~$${usdA.toFixed(3)}) — unknown 은 미지정, 캐스팅 화면에서 확인·수정`);
    try {
      await recordCost({ projectId, vendor: "openai", model: VLM_A, costUsd: usdA, meta: { kind: "speakers", lines: assigned } });
    } catch {}
  }

  p2.steps.cast = {
    ...p2.steps.cast,
    kind: "cast",
    status: "review", // G0 캐스트 검수 대기
    error: undefined,
    updatedAt: Date.now(),
  };
  await saveProject(p2);
  return cast.length;
}

// ── regen(M3): 각 컷을 이미지 모델(gpt-image-2 기본 · fal Flux)로 재생성 → 청크 병렬
//    → Scene.generatedImage ─
// payload.sceneIds 주면 그 컷들만(컷 하나씩 테스트/다시생성). 청크마다 저장 → 진행 표시.
// 캐릭터의 refBox(대표 컷 안의 인물 영역)를 얻는다 — 캐시 우선, 없으면 VLM 1회 후 저장.
// 저장은 프로젝트 저장 규약대로 fresh 재읽기 + 그 필드만 머지(긴 생성 호출 뒤 통째 저장 금지).
async function refBoxFor(c, refBuf, key, model, projectId, log) {
  if (c.refBox) return c.refBox;
  const box = await detectRefBox(refBuf, c.description, key, model);
  if (!box) return null;
  c.refBox = box; // 이번 잡 안에서 재검출 방지
  try {
    const pp = await getProject(projectId);
    if (pp) {
      const target = (pp.cast ?? []).find((x) => x.id === c.id);
      if (target && !target.refBox) {
        target.refBox = box;
        await saveProject(pp);
        await log?.(`[진단] ${c.label ?? c.id} 인물 영역 산출·캐시(다음부턴 무료)`);
      }
    }
  } catch {}
  return box;
}

// ★캐스팅 정본 레퍼런스 수집(단일 원천) — 이 컷에 나오는 캐릭터(casting sceneIds)의 대표
//   이미지를 모은다. 실사 초상 우선, 없으면 대표 컷에서 '인물 영역만 크롭'(대표 컷을 통째로
//   넣으면 그 컷 구도까지 따라가는 사고가 있었다). 컷의 '인물 참고 끄기'면 빈 배열.
//   ★모든 재생성 경로(전체·마스크·Flux)가 이 함수를 쓴다 — 예전엔 전체 경로에만 있어서
//   다른 경로로 그리면 얼굴을 지어냈다.
async function collectCastRefs(s, p, key, VLM_MODEL, projectId, log) {
  const bufs = [];
  const urls = [];
  if (s.cut?.noCastRef) return { bufs, urls };
  // ★레퍼런스는 '그림에 인물이 보이는 컷'에만 — 인물 배정(sceneIds)에는 목소리만 나오는
  //   컷(하늘·풍경에 화면 밖 대사)도 포함된다. 그런 컷에 얼굴 정본을 넣으면, 특히 내용
  //   프롬프트까지 비어 있을 때 모델이 레퍼런스 인물을 '내용'으로 삼아 컷을 갈아치운다
  //   (실사례 2026-08-02: 구름 하늘 컷이 남자 뒷목 클로즈업으로 재생성됨).
  //   분류가 그림에서 본 인물(cut.characters)이 없고 타입도 인물 무관(사물·텍스트)이면 제외.
  const visibleChars = s.cut?.characters?.length ?? 0;
  if (visibleChars === 0 && (s.cut?.type === "object" || s.cut?.type === "text")) {
    await log?.(`[진단] 컷 ${s.order + 1}: 그림에 인물 없음(${s.cut?.type}) — 인물 참고이미지 제외`);
    return { bufs, urls };
  }
  // ★타입이 오분류돼도 걸리게 — '확인된 인물 없음 + 내용 프롬프트 비어 있음' 조합이면 제외.
  //   내용 앵커가 없는 채로 얼굴 정본이 들어가면 모델이 정본을 내용으로 삼는다(하늘 컷 사고
  //   의 정확한 조건). 사람이 인물참고 토글을 만질 필요가 없어야 한다(인터페이스 원칙).
  const hasContent = !!String(s.cut?.description || s.cut?.promptDraft || "").trim();
  if (visibleChars === 0 && !hasContent) {
    await log?.(`[진단] 컷 ${s.order + 1}: 확인된 인물·내용 프롬프트 둘 다 없음 — 인물 참고이미지 제외(원본 충실 재생성)`);
    return { bufs, urls };
  }
  for (const c of p.cast ?? []) {
    if (bufs.length >= 3) break;
    if (!(c.sceneIds ?? []).includes(s.id)) continue; // 이 컷에 나오는 인물만
    let refUrl = c.realImage;
    if (!refUrl) {
      const rs = (p.scenes ?? []).find((x) => x.id === c.refSceneId && x.id !== s.id);
      refUrl = rs?.generatedImage || rs?.originalImage;
    }
    if (!refUrl) {
      await log?.(`[진단] 컷 ${s.order + 1} ${c.label ?? c.id}: 참고이미지 없음(대표 컷 미지정) — 얼굴을 지어낼 수 있음`);
      continue;
    }
    try {
      let rb = await download(refUrl);
      let how = "실사초상";
      if (!c.realImage) {
        const box = await refBoxFor(c, rb, key, VLM_MODEL, projectId, log);
        if (box) {
          rb = await cropToBox(rb, box);
          how = "대표컷 인물크롭";
        } else {
          how = "대표컷 전체(크롭 실패)";
        }
      }
      bufs.push(rb);
      urls.push(refUrl); // Flux 는 URL 로 받는다(image_urls)
      await log?.(`[진단] 컷 ${s.order + 1} 참고이미지 ← ${c.label ?? c.id}: ${how} ${String(refUrl).split("/").pop()}`);
    } catch (e) {
      await log?.(`[진단] 컷 ${s.order + 1} ${c.label ?? c.id} 참고이미지 실패: ${String(e?.message ?? e).slice(0, 60)}`);
    }
  }
  if (!bufs.length && (s.cut?.type === "person" || s.cut?.type === "action")) {
    await log?.(`[진단] 컷 ${s.order + 1}: 인물 컷인데 참고이미지 0개 — 캐스팅에서 이 컷에 인물이 배정됐는지 확인하세요`);
  }
  return { bufs, urls };
}

export async function runRegen(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[regen]", m);
    await logProgress(projectId, m);
  };

  // 모델 선택 — 컷별(payload.models[sceneId]) 우선 → payload.model → gpt-image-2.
  // gpt-image* → OpenAI, fal/flux → fal.ai Flux. 컷마다 달라도 워커 메모리엔 영향 없음
  // (모델은 라우팅 문자열일 뿐, 피크 메모리는 REGEN_CONCURRENCY 개 이미지 버퍼로 결정).
  const key = process.env.OPENAI_API_KEY;
  const falKey = process.env.FAL_KEY;
  // ★80c6dc7 이 collectCastRefs(…, VLM_MODEL, …) 를 이 함수에 넣으면서 정의를 빠뜨려
  //   재생성 첫 컷부터 ReferenceError("VLM_MODEL is not defined")로 전멸했다(2026-08-02 실측).
  const VLM_MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o";
  const models = payload?.models && typeof payload.models === "object" ? payload.models : null;
  const defModel = payload?.model || "gpt-image-2";
  const resolveModel = (id) => (models && models[id]) || defModel;

  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  // 텍스트 오버레이 제외, 추출된 컷만(원본 이미지 필요).
  let cand = scenes.filter((s) => s.originalImage && s.cut?.type !== "text");
  if (Array.isArray(payload?.sceneIds) && payload.sceneIds.length) {
    const set = new Set(payload.sceneIds);
    cand = cand.filter((s) => set.has(s.id));
  }
  await log(`재생성 대상 ${cand.length}컷 · 모델 ${models ? "컷별" : defModel} · 동시 ${REGEN_CONCURRENCY}`);
  if (cand.length === 0) throw new Error("재생성할 컷이 없어요(컷 추출 먼저)");
  // ★진단: "12번을 시켰는데 1번 그림이 다시 그려진다"는 오배정 보고가 반복된다(사용자).
  //   앱·워커 모두 scene id 기준이라 코드상 오배정 지점을 못 찾았다. 추측으로 고치지 않고,
  //   '어떤 컷 번호가 어떤 원본 파일을 입력으로 받았는지'를 남겨 다음 발생 때 확정한다.
  //   원본 파일명은 cut-<order>-<시각>.png 라, 컷 번호와 파일명의 order 가 어긋나면 그게 증거다.
  for (const s of cand) {
    const f = String(s.originalImage ?? "").split("/").pop() ?? "(없음)";
    await log(`[진단] 컷 ${s.order + 1} (id ${String(s.id).slice(0, 8)}) ← 원본 ${f}`);
  }

  const genById = new Map(); // sceneId → { url } | { error }
  let costTotal = 0;
  let ok = 0;

  // 누적 결과를 프로젝트에 반영 저장(청크마다 호출 → 진행되는 대로 화면에 채워짐).
  const flush = async (finalStep) => {
    const pp = await getProject(projectId);
    if (!pp) return;
    for (const s of pp.scenes ?? []) {
      const g = genById.get(s.id);
      if (!g) continue;
      if (g.url) {
        s.generatedImage = g.url;
        s.regenError = undefined;
        // ★이미지가 바뀌면 그 이미지에서 만든 매트·배경판은 낡은 것 — 지워서 다음 계층 B 굽기가
        //   새 이미지 기준으로 다시 만들게 한다(옛 이미지 매트로 합성하면 인물이 어긋난다).
        s.matteUrl = undefined;
        s.cleanPlateUrl = undefined;
      } else {
        s.regenError = g.error || "생성 실패";
      }
    }
    if (finalStep) {
      pp.steps.regen = {
        ...pp.steps.regen,
        kind: "regen",
        status: "review",
        error: undefined,
        updatedAt: Date.now(),
      };
    }
    await saveProject(pp);
  };

  for (let i = 0; i < cand.length; i += REGEN_CONCURRENCY) {
    const chunk = cand.slice(i, i + REGEN_CONCURRENCY);
    await log(`이미지 생성 ${i + 1}~${i + chunk.length}/${cand.length}…`);
    await Promise.all(
      chunk.map(async (s) => {
        try {
          let buf, cost;
          const sel = resolveModel(s.id);
          const photoreal = sel === "photoreal"; // 실사화(image-2 + 캐릭터 실사 레퍼런스)
          const useFal = !photoreal && (sel === "fal" || sel.startsWith("flux"));
          const openaiModel = sel.startsWith("gpt-image")
            ? sel
            : process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
          if (useFal && !falKey) throw new Error("FAL_KEY 없음(Render 워커 환경변수)");
          if (!useFal && !key) throw new Error("OPENAI_API_KEY 없음");
          const mode = s.regenMode || p.regenMode || "full"; // 디폴트=새로 그리기(full) — 사용자 지시
          if (photoreal) {
            const imgBuf = await download(s.originalImage);
            // 이 컷에 등장하는 캐릭터의 실사 초상을 얼굴 고정 레퍼런스로(최대 3장).
            const refBufs = [];
            for (const c of p.cast ?? []) {
              if (refBufs.length >= 3) break;
              if (c.realImage && (c.sceneIds ?? []).includes(s.id)) {
                try {
                  refBufs.push(await download(c.realImage));
                } catch {}
              }
            }
            ({ buf, cost } = await regenScenePhoto(s, imgBuf, p, key, refBufs));
          } else if (useFal) {
            if (mode === "mask") {
              const imgBuf = await download(s.originalImage);
              ({ buf, cost } = await regenSceneMaskedFal(s, imgBuf, p, falKey));
            } else {
              // ★Flux 도 캐스팅 정본을 넣는다 — kontext 는 1장만 받아 레퍼런스를 못 넣었고,
              //   그래서 Flux 로 그리면 모델이 얼굴을 지어냈다. 레퍼런스가 있으면 다중 이미지
              //   모델(image_urls)로 전환된다(fal.mjs). URL 로 넘기므로 다운로드 불필요.
              const { urls: refUrls } = await collectCastRefs(s, p, key, VLM_MODEL, projectId, log);
              ({ buf, cost } = await regenSceneFal(s, p, falKey, refUrls));
            }
          } else {
            const imgBuf = await download(s.originalImage);
            // ★★캐스팅 정본 레퍼런스는 '모든 재생성 경로'에 넣는다 —
            //   예전엔 전체 재생성(full·gpt-image)에만 넣어서, 마스크 모드나 Flux 로 그리면
            //   레퍼런스가 아예 안 들어가 모델이 얼굴을 지어냈다(사용자: 캐릭터 지정했는데
            //   없는 얼굴을 만든다). 여기서 한 번 모아 두 경로가 같이 쓴다.
            const { bufs: refBufs, urls: refUrls } = await collectCastRefs(s, p, key, VLM_MODEL, projectId, log);
            if (mode === "mask") {
              ({ buf, cost } = await regenSceneMasked(s, imgBuf, p, key, openaiModel, refBufs));
            } else {
              ({ buf, cost } = await regenScene(s, imgBuf, p, key, openaiModel, refBufs));
            }
            void refUrls;
          }
          costTotal += cost;
          const { url } = await put(
            `project/${projectId}/gen-${s.order}-${Date.now()}.png`,
            buf,
            { access: "public", contentType: "image/png", addRandomSuffix: false }
          );
          genById.set(s.id, { url });
          ok++;
          await log(`컷 ${s.order + 1} 완료`);
        } catch (e) {
          genById.set(s.id, { error: String(e?.message ?? e) });
          await log(`컷 ${s.order + 1} 실패: ${String(e?.message ?? e).slice(0, 120)}`);
        }
        await flush(false); // ★ 이미지 하나 끝날 때마다 반영 → 그때그때 화면에
      })
    );
    const doneN = Math.min(i + chunk.length, cand.length);
    await log(`진행 ${doneN}/${cand.length} (${Math.round((doneN / cand.length) * 100)}%)`);
  }

  try {
    await recordCost({
      projectId,
      vendor: "openai",
      model: models ? "mixed" : defModel,
      costUsd: costTotal,
      meta: { kind: "regen", images: cand.length, ok },
    });
  } catch {}

  await flush(true); // 마지막 반영 + 단계 review
  await log(`재생성 완료: ${ok}/${cand.length} (~$${costTotal.toFixed(3)})`);
  return ok;
}

// ── portrait: 캐릭터 대표 컷 → 실사 인물 초상 생성 → Character.realImage. 캐스팅 얼굴 고정용.
//    payload { charId }. cast 단계 상태는 안 건드림(캐스팅 UI 유지) — 앱이 cast 를 폴링해 반영.
export async function runPortrait(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[portrait]", m);
    await logProgress(projectId, m);
  };
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY 없음");
  const charId = payload?.charId;
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const ch = (p.cast ?? []).find((c) => c.id === charId);
  if (!ch) throw new Error("캐릭터를 찾을 수 없어요");
  // 대표 컷(refSceneId) 원본 이미지. 없으면 첫 sceneId.
  const refSid = ch.refSceneId || ch.sceneIds?.[0];
  const refScene = (p.scenes ?? []).find((s) => s.id === refSid);
  const srcUrl = refScene?.originalImage;
  if (!srcUrl) throw new Error("대표 컷 이미지가 없어요(컷 추출 먼저)");
  await log(`${ch.label} 실사 초상 생성…`);
  const refBuf = await download(srcUrl);
  const { buf } = await makePortrait(refBuf, key, payload?.prompt ?? ch.realPrompt);
  const { url } = await put(`project/${projectId}/portrait-${charId}-${Date.now()}.png`, buf, {
    access: "public",
    contentType: "image/png",
    addRandomSuffix: false,
  });
  // 최신 상태 재읽기 후 그 캐릭터만 realImage 반영(다른 편집 안 덮게).
  const pp = (await getProject(projectId)) ?? p;
  const c2 = (pp.cast ?? []).find((c) => c.id === charId);
  if (c2) {
    c2.realImage = url;
    await saveProject(pp);
  }
  try {
    await recordCost({ projectId, vendor: "openai", model: "gpt-image-2", costUsd: 0.04, meta: { kind: "portrait", charId } });
  } catch {}
  await log(`${ch.label} 실사 초상 완료`);
  return 1;
}

// 영상 길이(초) 추정. 우선순위: ①사람 지정(cut.durationSec) → ②대사 글자 수(한국어 ~5자/초)
// → ③무대사 장면전환(transition)은 길게 → ④그 외 최소 비트. 나중에 TTS 오디오 길이가 마스터.
const half = (x) => Math.max(0.5, Math.min(15, Math.round(x * 2) / 2)); // 0.5초 단위로 스냅
// 모션 티어별 길이 범위(초, 스펙 §3): talk 3-4·idle 2-3·emote 2·action 1-2 강제.
// ★talk 상한 8초(사용자 2026-08-03: "대화 컷이 너무 짧다") — 대사 길이(글자수/5cps)가 티어
//   범위로 클램프되므로, 상한 4초는 긴 대사에서 소리·자막이 다음 컷 위로 크게 흘러넘쳤다.
//   엔진은 전부 수용(Kling 3~15·MiniMax 6/10 반올림·Grok ≤10, 짧은 쪽은 트림). env 로 조정 가능.
const TIER_SEC = { talk: [2.5, Number(process.env.TIER_TALK_MAX_SEC || 8)], idle: [2, 3], emote: [1.5, 2.5], action: [1, 2] };
function estimateVideoSeconds(cut) {
  const MIN = Number(process.env.VIDEO_MIN_SEC || 2);
  const MAX = Number(process.env.VIDEO_MAX_SEC || 8);
  if (cut?.durationSec) return half(cut.durationSec); // 사람 지정이 최우선(티어보다 우선)
  const parts = [];
  if (cut?.bubbles?.length) for (const b of cut.bubbles) parts.push(b.text || "");
  else if (cut?.dialogue) parts.push(cut.dialogue);
  if (cut?.narration) parts.push(cut.narration);
  const chars = parts.join(" ").replace(/\s+/g, "").length;
  let sec;
  if (chars > 0) {
    const CPS = Number(process.env.VIDEO_CHARS_PER_SEC || 5);
    sec = Math.max(MIN, Math.min(MAX, Math.round(chars / CPS)));
  } else if (cut?.type === "transition") {
    sec = Number(process.env.VIDEO_TRANSITION_SEC || 1.5);
  } else {
    sec = Number(process.env.VIDEO_SILENT_SEC || 1); // 대사 없는 정지컷 기본 1초
  }
  // ★모션 티어(§3) 있으면 그 범위로 — 대사 있으면 대사길이를 티어 범위로 클램프, 무대사면 티어 중앙값.
  const tr = TIER_SEC[cut?.motionTier];
  if (tr) {
    const [lo, hi] = tr;
    sec = chars > 0 ? Math.max(lo, Math.min(hi, sec)) : (lo + hi) / 2;
    return half(sec);
  }
  return sec;
}

// 영상 모션 프롬프트 = 컷 모션(카메라 워크) + 가이드(스톱모션 느낌). aninews video_motion 계승.
// 정지컷 내용은 이미지가 담고 있으니 프롬프트엔 '어떻게 움직일지'만 넣는다.
// ★기본 톤(사용자 지정): 무조건 스타일리시. '작고 느리고 잔잔하게'는 aninews 용이고
//   re-animator 는 빠르고 스타일리시하게 — 정적 샷도 허용하되 '디자인된 것처럼' 멋있어야 한다.
//   일관성 가드(스타일·인물 유지, 새 오브젝트·텍스트·변형 금지)는 그대로 지킨다.
// ★설계 교훈(2026-07-18): 공통 지침에 'LARGE fast movement 가 정답'을 넣었더니 모델이
//   '피사체를 크게 움직여라'로 해석 — 쓸데없는 인물 동작만 커지고 정작 카메라 문법(급가속·
//   스냅)은 실종(사용자: "싸구려"). 역할 분리로 재설계: 프리셋(cut.motion)이 카메라의
//   '무엇·언제'를 시간 구조로 지시하고, 공통 지침은 '그대로 정밀 실행 + 피사체는 정지'만.
// 인물 동작 규칙(2026-07-18 사용자 확정): 잔잔한 동작은 살리되 작게 — 고개 들기/내리기/돌리기
// 같은 3D 움직임 권장, 표정은 원본 그대로, ★없는 인물·사물 생성 절대 금지★.
// ★사용자 지정(2026-07-18): Grok 은 거의 '정지'로 — 카메라워크는 워커 후처리(postfx 줌 커브)로
//   따로 굽는다. Grok 이 크게 움직이면 그림이 뭉개져 품질이 무너졌음. 여기선 '살아있는 사진'
//   수준의 미세한 생동감만 요청하고, 카메라 이동은 절대 시키지 않는다.
// 카메라는 항상 정지(카메라워크는 후처리). 항상 붙는다.
const CAMERA_STATIC =
  "CAMERA: completely static, locked frame — no pan/tilt/zoom/dolly/shake/rotation. "
// ★orbit(계층 C) 전용 — I2V 에 맡기는 유일한 카메라. 피사체 주위를 천천히 도는 궤도 카메라.
const ORBIT_CAMERA =
  "Slowly ORBIT the camera around the main subject in a smooth, gentle circular arc, keeping the subject centered and in focus. " +
  "Move the CAMERA only — the subject holds its pose. Keep it slow and cinematic; no fast spinning, no warping, no distortion. ";
// ★동작 크기 상한 — 사용자가 "동작이 너무 크다"고 지적. 모든 움직임을 작고 절제되게, 과장·빠른 동작 금지.
const SUBTLE_LIFE =
  "MOTION: small, slow, restrained — a living photograph. No large or fast movement; err toward too little. Only " +
  "breathing, slow blinks, slight hair/cloth sway, small head move. Keep each face's expression as drawn. Never add " +
  "people or objects not in the still. Keep the art style; no text; no morphing faces or composition. "
// ★자세한 판(verbose) — 압축 전 원문. Kling 은 상한 2500자로 여유가 있어 이쪽을 쓴다.
//   압축판만 주자 Kling 품질이 떨어졌다(사용자 보고): 압축 전에는 잘린 프롬프트였어도
//   동작·정체성 설명의 '자세한 원문'이 앞부분에 들어 있었고 그걸 Kling 이 잘 쓰고 있었다.
//   MiniMax(2000자)는 자리가 없어 압축판을 그대로 쓴다.
const SUBTLE_LIFE_FULL =
  "MOTION: keep it SMALL, slow, calm and RESTRAINED — like a subtle living photograph, not an action scene. " +
  "Absolutely avoid large, fast, sweeping or exaggerated movement; err on the side of too little motion. " +
  "Bring the still to life only with gentle breathing, slow blinking, small hair and cloth sway, a slight weight shift, " +
  "a very small 3D head movement. Keep each character's facial EXPRESSION exactly as drawn — do not change the emotion. " +
  "NEVER add characters, people or objects not in the still. Keep the art style and colors; no text; " +
  "do not distort or morph faces or the composition. "
const TIER_ACTION_LIFE_FULL =
  "MOTION: this is an ACTION moment — allow ONE contained but energetic beat of movement, a quick decisive motion or a " +
  "short burst of dynamic energy, stronger than a calm living photo but still controlled and believable. " +
  "Keep each character's identity, face and the art style intact — NO morphing, NO distortion, NO warping of faces or " +
  "the composition, and NEVER add characters, people or objects not in the still. "
const IDENTITY_LOCK_FULL =
  "IDENTITY LOCK — every visible character must remain the EXACT SAME person for the entire clip: the same face, same " +
  "facial features, same proportions, same hairstyle and hair color, same clothing, in every single frame. Do NOT let any " +
  "face drift, morph, re-shape, swap, age, or turn into a different-looking person over time; do NOT regenerate or " +
  "re-invent facial features between frames. Treat the drawn face as fixed identity that only moves as a rigid whole. "

// ★action 티어(스펙 §3·§4) — 절제 완화: 담긴 강한 한 박자는 허용하되 얼굴·화풍·구도는 보존(모프·왜곡·신규요소 금지).
const TIER_ACTION_LIFE =
  "MOTION: an ACTION beat — ONE quick, decisive, energetic movement, controlled and believable. Keep every character's " +
  "identity, face and the art style intact: no morphing, no distortion, no warping, and never add people or objects " +
  "not in the still. "
// ★★얼굴 정체성 고정 — 사용자: "한 컷 안에서도 인물 얼굴이 달라진다". I2V 는 프레임마다 얼굴을
//   다시 생성하다시피 해서 조금씩 다른 사람이 된다(모든 I2V 공통 약점, Kling 만의 문제 아님).
//   프롬프트로 '같은 사람 = 프레임마다 동일'을 강하게 못박아 표류를 억제한다. 완전 제거는 불가하나
//   움직임을 줄이면(특히 고개 회전) 함께 줄어든다.
const IDENTITY_LOCK =
  "IDENTITY LOCK: every character stays the EXACT SAME person in every frame — same face, features, proportions, hair, " +
  "clothing. No face drift, morphing, reshaping, swapping or aging; never re-invent facial features between frames. "
// ★'그림 속 그림'의 인물은 정지 — 사진·초상·포스터·표지·그림·간판·화면 안에 그려진 사람은 움직이지 않는다.
const PICTURE_STATIC =
  "Any person shown inside a photo, portrait, poster, painting, cover, sign or screen is a STATIC image — keep them " +
  "perfectly still; only the real, live subject(s) may move. "
// ★★단발성 강제 — 사용자 지적의 핵심: "침을 뱉으면 한 번만 툭 떨어지고, 멱살을 잡으면 한 번만
//   올라오고, 발차기는 한 번만 맞고 한 번만 날아가야 한다. 지금은 무의미한 동작이 반복된다."
//   원인: I2V 는 요청 길이를 채우려고 동작을 루프시킨다. 특히 Kling 은 최소 3초인데 action 티어는
//   1~2초를 요청하므로(TIER_SEC), 짧은 동작이 3초에 맞춰 2~3회 반복된다.
//   → 프롬프트에서 '한 번만, 반복 금지, 끝나면 정지'를 명시하고 남는 시간은 정지로 채우게 한다.
//   이 지시는 티어·명시동작 여부와 무관하게 '항상' 붙는다(예전엔 반복 금지 문구가 아예 없었다).
const SINGLE_BEAT =
  "The motion happens exactly ONCE — never loop, repeat or replay it. When it completes, hold the resulting pose still " +
  "for the rest of the clip. "
// ★구체 예시 — 액션 컷(Kling)에 특히 효과적이었다. 길이 예산이 허락할 때만 덧붙인다.
//   압축 때 이걸 통째로 빼자 Kling(=액션 담당) 품질이 떨어졌다(사용자 보고).
const SINGLE_BEAT_EXAMPLES =
  "For example: a spit falls once and lands; a collar-grab happens once and holds; a kick lands once, the target is " +
  "knocked back once, and it does not reset and kick again. Never rewind to the starting pose to redo it. "
// 명시적 동작(버튼·프롬프트)이 없을 때만 — 이미 있는 동작만 이어가고 새 동작 창작 금지.
const CONTINUE_ONLY =
  "Continue only the action already drawn (someone mid-walk keeps walking); start no new actions or gestures. ";
// 인물 몸동작 프리셋(버튼) id → 영어 지시. 모두 '작고 절제되게'로 상한을 건다(사용자: 동작이 너무 큼).
const BODY_MOTION_PROMPTS = {
  still: "The body stays still and grounded; only the faintest signs of life (soft breathing, a slow blink). No stepping, no walking, no gestures.",
  sway: "Only a very small, slow weight shift or gentle sway — barely perceptible. No stepping, no big moves.",
  "walk-in": "The character walks slowly and calmly a SHORT distance into the frame with small, unhurried steps. Gentle and restrained — not fast, not far.",
  "walk-out": "The character walks slowly and calmly a SHORT distance across or out of the frame with small, unhurried steps. Gentle and restrained — not fast, not far.",
  run: "The character moves at a light, controlled jog — believable and contained, NOT frantic or exaggerated. Keep the pace moderate and the movement small within the frame.",
  turn: "The character slowly turns their head and upper body to look — a small, calm movement. No large body rotation.",
  gesture: "A small, slow hand or arm gesture — subtle, not large or sweeping.",
};
// 대사 있는 인물 컷: '말하는 것처럼' 입/얼굴 움직임(진짜 립싱크 아님 — Grok I2V 한계).
const SPEAKING_GUIDANCE =
  "The character is talking: natural, subtle lip and mouth movement as if speaking, with a slight, " +
  "lively facial expression. Keep the same identity and pose; do not add text or captions.";
// ★이 컷의 보이는 인물이 지금 말하는 게 아니면(대사 없음 or 다른/화면 밖 화자) → 입 다물기 강제.
const MOUTH_CLOSED_GUIDANCE =
  "Nobody speaks in this shot: keep every mouth firmly CLOSED and still, calm expression. No lip, mouth or jaw movement."

// 이 컷에 '보이는 인물이 직접 하는 대사'가 있나 — 인물/액션 컷 + 화자(charId)가 ★이 컷에 등장하는 인물★일 때만.
// 내레이션(speakerId=null)·효과음·★다른/화면 밖 인물★이 말하면 false = 이 컷 인물은 입이 안 움직인다.
//   shownCharIds = 캐스팅상 이 컷에 나오는 캐릭터 id 들. 없으면(폴백) 예전처럼 화자만 있으면 말하는 것으로.
function hasSpokenDialogue(cut, shownCharIds) {
  if (!cut || (cut.type !== "person" && cut.type !== "action")) return false;
  const bubs = cut.bubbles ?? [];
  if (bubs.length)
    return bubs.some((b) => {
      if (!b.speakerId || b.speakerId === "__sfx__" || !(b.text || "").trim()) return false;
      if (Array.isArray(shownCharIds) && shownCharIds.length) return shownCharIds.includes(b.speakerId);
      return true;
    });
  return (cut.dialogue || "").trim() !== "";
}
// 이 컷에 '무엇이·누가' 있는지 = 정체성/장면 앵커. Kling 에 '어떻게 움직여라'만 주면 인물이
// 누군지 몰라 얼굴을 지킬 기준이 없다(사용자 제안: 내용을 프롬프트로 같이 주자). 캐스팅 외모
// 서술 + 컷 장면 묘사를 '이미 화면에 있는 것 — 그대로 보존, 새로 추가 금지'로 못박아 준다.
function buildContentClause(cut, shownCast) {
  const parts = [];
  const who = (shownCast || [])
    .map((c) => (c.description || "").trim() || (c.label || "").trim())
    .filter(Boolean);
  if (who.length) parts.push(`The people in frame are: ${who.join("; ")}.`);
  // 장면 묘사 — 영문 초안(promptDraft) 우선, 없으면 자유 서술(description).
  const scene = (String(cut?.promptDraft || "").trim() || String(cut?.description || "").trim());
  if (scene) parts.push(scene);
  if (!parts.length) return "";
  return (
    "SCENE CONTENT (this describes what is ALREADY in the still — keep these exact same characters, faces, " +
    "outfits and setting consistent throughout; do NOT add, remove, or replace anyone or anything): " +
    parts.join(" ") +
    " "
  );
}
export function buildVideoPrompt(cut, shownCharIds, storyContext, shownCast, opts) {
  // ★사용자가 프롬프트를 직접 편집(고급)했으면 그대로 사용 — 전체 제어(자동 조립 무시).
  const override = String(cut?.videoPromptOverride || "").trim();
  if (override) return override;
  // ★카메라(cut.motion)는 Grok 에 안 준다(카메라워크=후처리). 여기선 정지 + 절제된 생동감(SUBTLE_LIFE)
  //   + 스토리 맥락(맥락 어긋남 방지) + 명시 동작(버튼 bodyMotion / 프롬프트 videoPrompt / 자유 action).
  const desc = String(cut?.videoPrompt || "").trim();
  const bodyPhrase = BODY_MOTION_PROMPTS[cut?.bodyMotion] || ""; // 버튼 프리셋
  const action = String(cut?.action || "").trim();
  const hint = String(cut?.motionPromptHint || "").trim(); // VLM 티어 맞춤 모션 서술(§3)
  const story = String(storyContext || "").trim();
  const explicit = [];
  if (bodyPhrase) explicit.push(`Subject motion: ${bodyPhrase}`);
  else if (action) explicit.push(`Subject action (keep it small and slow): ${action}`);
  else if (hint) explicit.push(`Motion (${cut?.motionTier || "auto"} tier): ${hint}`); // 명시 동작 없을 때 티어 힌트
  if (desc) explicit.push(`What happens in this shot: ${desc}`);
  // ★엔진별 길이 예산 — Kling 2500·MiniMax 2000자 상한(초과분은 API 가 뒤를 자른다).
  const BUDGET = Number(opts?.budget || process.env.VIDEO_PROMPT_MAX || 1900);
  // 예산 여유가 있는 엔진(Kling 2400)엔 '자세한 판', 좁은 엔진(MiniMax 1900)엔 압축판.
  const RICH = BUDGET >= 2200;
  // ★모션 티어(§3): action 이면 절제 완화(강한 한 박자), 그 외(talk/idle/emote)는 절제 유지.
  const isAction = cut?.motionTier === "action";
  // ★orbit(스펙 §2 계층 C): 유일하게 I2V 에 카메라를 맡긴다(2D 후처리로 시점 회전 불가). 이 컷은
  //   camerafx(후처리)에서 스킵되므로 여기서 궤도 카메라를 지시(이중 무빙 방지). 그 외는 카메라 정지.
  const isOrbit = cut?.cameraWork?.preset === "orbit";
  const cameraClause = isOrbit ? ORBIT_CAMERA : CAMERA_STATIC;
  // 인물이 있는 컷(person/action)엔 얼굴 정체성 고정 + 내용(누가·무엇) 앵커를 붙인다.
  const hasPeople = cut?.type === "person" || cut?.type === "action";
  const idClause = hasPeople ? (RICH ? IDENTITY_LOCK_FULL : IDENTITY_LOCK) : "";
  const lifeClause = isAction ? (RICH ? TIER_ACTION_LIFE_FULL : TIER_ACTION_LIFE) : RICH ? SUBTLE_LIFE_FULL : SUBTLE_LIFE;
  const contentClause = buildContentClause(cut, shownCast); // 캐스팅 외모 + 장면 묘사
  const storyClause = story
    ? `STORY (motion must not contradict this — e.g. a dying, injured or unconscious character never cheers up or jumps up): ${story}. `
    : "";
  // ★명시 동작(버튼·AI 연출 hint·action)이 있어도 '그 동작 하나만' 이라는 제한은 유지한다.
  //   예전엔 explicit 이 있으면 CONTINUE_ONLY 가 통째로 빠져서, AI 연출이 컷마다 동작을 채우는
  //   지금 구조에선 '새 동작 창작 금지'가 사실상 한 번도 적용되지 않았다(무의미한 동작의 원인).
  const motionClause = explicit.length
    ? `${explicit.join(". ")}. Perform ONLY that one motion — no other actions or gestures. `
    : CONTINUE_ONLY;
  const mouthClause = hasSpokenDialogue(cut, shownCharIds) ? SPEAKING_GUIDANCE : MOUTH_CLOSED_GUIDANCE;

  // ★★조립 순서 = 중요도 순. 이유: I2V API 는 프롬프트 길이 상한이 있고(MiniMax 2000·Kling 2500자)
  //   넘으면 '뒤가 잘린다'. 예전 순서에서는 잘리는 뒷부분이 하필 단발성(SINGLE_BEAT)·입 다물기·
  //   스토리 맥락·실제 동작 지시였다 → 내가 넣은 수정들이 전송 직전에 통째로 사라져 영상이 안
  //   바뀌었다(사용자: "고쳐도 그대로/반복된다"의 진짜 원인).
  //   → 가장 중요한 것부터 앞에 놓고, 잘려도 되는 것(그림 속 인물 정지 등)을 뒤로 보낸다.
  const parts = [
    SINGLE_BEAT,      // 1. 반복 금지 — 가장 큰 불만
    SINGLE_BEAT_EXAMPLES, // 1b. 구체 예시 — ★반복이 최우선 불만이라 두 엔진 모두에 항상 넣는다.
                          //     예산이 모자라면 아래 tail-drop 이 덜 중요한 뒤쪽(그림 속 인물 정지 등)을 버린다.
    idClause,         // 2. 얼굴 정체성 고정
    lifeClause,       // 3. 동작 크기 상한(티어별)
    cameraClause,     // 4. 카메라 정지
    motionClause,     // 5. 이 컷에서 실제로 할 동작
    mouthClause,      // 6. 입 움직임 규칙
    contentClause,    // 7. 누가·무엇(앵커)
    storyClause,      // 8. 스토리 맥락
    cut?.animatePicture ? "" : PICTURE_STATIC, // 9. 그림 속 인물 정지(가장 뒤 = 잘려도 피해 최소)
  ].filter(Boolean);

  // ★길이 예산 — 잘림을 API 에 맡기지 않는다. MiniMax 2000·Kling 2500자 상한이라, 넘치면
  //   API 가 문장 중간에서 뒤를 날려버린다(그게 내 수정들이 무력화된 원인).
  //   여기서 '뒤 조각부터' 통째로 빼서 예산에 맞춘다 → 앞의 중요한 지시는 항상 온전히 전달된다.
  const glue = (a) => a.map((t) => t.trim()).filter(Boolean).join(" ").replace(/\.\.+/g, ".");
  while (parts.length > 1 && glue(parts).length > BUDGET) parts.pop();
  return glue(parts);
}

// ── video(M4): 재생성 컷(generatedImage)을 Grok I2V 로 영상화 → Scene.videoUrl ─
//    scene 단계로 진행 표시. payload.sceneIds 있으면 그 컷만. 길이는 대사 기반 추정.
export async function runVideo(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[video]", m);
    await logProgress(projectId, m);
  };

  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  let cand = scenes.filter((s) => s.generatedImage); // 재생성된 컷만 I2V 대상
  if (Array.isArray(payload?.sceneIds) && payload.sceneIds.length) {
    const set = new Set(payload.sceneIds);
    cand = cand.filter((s) => set.has(s.id));
  }
  if (cand.length === 0) throw new Error("영상 만들 컷이 없어요(먼저 3단계 재생성)");
  // ★엔진 선택 — 이제 '컷별'로 결정한다(사용자: 액션=Kling, 일반=MiniMax).
  //   - project.videoEngine 이 grok/kling/minimax 로 '명시'되면 전 컷 그 엔진(강제).
  //   - 기본(auto): action 티어 → Kling(첫+끝 프레임 보간 가능), 나머지 → MiniMax.
  //     키 없으면 순차 폴백(minimax→kling→grok), 생성이 끊기지 않게.
  const hasKling = !!(process.env.KLING_API_KEY || (process.env.KLING_ACCESS_KEY && process.env.KLING_SECRET_KEY));
  const hasMM = hasMinimax();
  // ★"자동"은 버튼을 눌러야 켜지는 게 아니라 '기본'이어야 한다(사용자 지시).
  //   문제: videoEngine="kling" 은 MiniMax 도입 전 시대의 기본값이라 옛 프로젝트에 그대로 남아
  //   있고, 그걸 '강제'로 해석하면 티어 배분이 통째로 죽어 전 컷 Kling 이 된다(왜 다 클링이냐).
  //   → kling 저장값은 '강제'로 보지 않는다(레거시 기본값과 구분 불가). 티어 배분이 그대로 돈다.
  //   액션 컷은 어차피 티어 배분에서 Kling 이라 Kling 을 못 쓰게 되는 것도 아니다.
  //   grok·minimax 는 MiniMax 도입 후에만 저장되므로 명시 선택으로 존중한다.
  const forced = p.videoEngine === "grok" || p.videoEngine === "minimax" ? p.videoEngine : null;
  const legacyKling = p.videoEngine === "kling";
  // 이 컷에 실제로 쓸 엔진. 없는 키는 건너뛰고 있는 것으로 폴백.
  const engineFor = (cut) => {
    let want = forced || (cut?.motionTier === "action" ? "kling" : "minimax");
    if (want === "minimax" && !hasMM) want = hasKling ? "kling" : "grok";
    if (want === "kling" && !hasKling) want = hasMM ? "minimax" : "grok";
    return want;
  };
  const engLabel = forced
    ? forced
    : `auto(액션=${hasKling ? "Kling" : hasMM ? "MiniMax" : "Grok"}·일반=${hasMM ? "MiniMax" : hasKling ? "Kling" : "Grok"})`;
  await log(`영상 생성 대상 ${cand.length}컷 · ${engLabel} · 동시 ${VIDEO_CONCURRENCY}`);
  await log(`[진단] 엔진 키: MiniMax=${hasMM ? "있음" : "없음"} · Kling=${hasKling ? "있음" : "없음"} · 강제=${forced ?? "없음(자동)"}`);
  if (legacyKling)
    await log(`(옛 설정 videoEngine="kling" 무시 — 티어 배분 자동 적용: 액션=Kling·나머지=MiniMax)`);
  // 대상 컷의 티어 분포 + 배분 결과를 한 줄로 — 왜 그 엔진이 뽑혔는지 즉시 보인다.
  {
    const dist = {};
    for (const s of cand) {
      const k = `${s.cut?.motionTier || "미분류"}→${engineFor(s.cut)}`;
      dist[k] = (dist[k] || 0) + 1;
    }
    await log(`[진단] 티어→엔진 배분: ${Object.entries(dist).map(([k, v]) => `${k}×${v}`).join(", ")}`);
  }
  // ★사용자가 MiniMax 를 골랐는데(강제) 키가 없으면, 조용히 Kling/Grok 로 폴백돼 "선택이 안
  //   먹는다·미니맥스 맞냐"가 된다. 명시적으로 알린다.
  if (forced === "minimax" && !hasMM)
    await log(`⚠ MiniMax 선택했지만 MINIMAX_API_KEY 없음 — ${hasKling ? "Kling" : "Grok"} 으로 대체됩니다. Render 워커 env 에 키를 넣어주세요.`);
  if (!forced && !hasMM)
    await log(`⚠ MINIMAX_API_KEY 없음 — 일반 컷도 ${hasKling ? "Kling" : "Grok"} 으로 나갑니다(MiniMax 미적용).`);
  // ★이어달리기(soft deadline) — 잡 캡은 12분인데 Kling 은 컷당 2~4분이라, 동시 3이어도
  //   12분에 대략 9~18컷이 한계다. 넘기면 잡은 '타임아웃 실패'로 찍히지만 Promise.race 는
  //   실행 중인 잡을 취소하지 못해 백그라운드로 계속 돌고, 워커는 다음 잡을 집는다
  //   → 두 잡의 메모리가 겹쳐 OOM. (동영상 생성 중 OOM 의 구조적 요인)
  //   → 캡 전에 스스로 멈추고, 남은 컷을 새 video 잡으로 재적재해 이어서 돌린다.
  //     사용자에겐 '계속 진행 중'으로 보이고, 잡은 항상 캡 안에서 끝나 겹침이 없다.
  const vt0 = Date.now();
  const VIDEO_SOFT_MS = Number(process.env.VIDEO_SOFT_MS || 9.5 * 60 * 1000);
  const videoBudgetLeft = () => Date.now() - vt0 < VIDEO_SOFT_MS;
  const leftover = [];

  // ★엔진·키 상태를 '프로젝트'에 기록 → 앱이 화면에 배너로 보여준다(사용자가 로그를 뒤질
  //   필요 없게). 워커(Render) env 는 앱(Vercel)에서 못 읽으므로 워커가 여기 적어 전달한다.
  try {
    const pk = await getProject(projectId);
    if (pk) {
      pk.workerEngines = { minimax: hasMM, kling: hasKling, at: Date.now() };
      await saveProject(pk);
    }
  } catch {}

  const byId = new Map(); // sceneId → { url, engine } | { error }
  let costTotal = 0;
  let ok = 0;
  const engCount = {}; // 엔진별 사용 컷 수(비용 집계·표시용)

  const flush = async (finalStep) => {
    const pp = await getProject(projectId);
    if (!pp) return;
    for (const s of pp.scenes ?? []) {
      const g = byId.get(s.id);
      if (!g) continue;
      if (g.url) {
        s.videoUrl = g.url;
        s.videoError = undefined;
        if (g.engine) s.videoEngineUsed = g.engine; // ★실제 사용 엔진 — 컷 카드에 배지로 표시
        // ★새 영상 생성 → 옛 영상 기준으로 구운 후처리(fxUrl/fx) 무효화. 안 지우면 카드·미리보기가
        //   fxUrl 을 우선 보여줘서 "다시 생성해도 똑같다"(옛 영상)가 됨. 카메라워크는 새 영상에 다시 구우면 됨.
        delete s.fxUrl;
        delete s.fx;
      } else {
        s.videoError = g.error || "영상 실패";
      }
    }
    if (finalStep) {
      pp.steps.scene = {
        ...pp.steps.scene,
        kind: "scene",
        status: "review",
        error: undefined,
        updatedAt: Date.now(),
      };
    }
    await saveProject(pp);
  };

  for (let i = 0; i < cand.length; i += VIDEO_CONCURRENCY) {
    const chunk = cand.slice(i, i + VIDEO_CONCURRENCY);
    if (!videoBudgetLeft()) {
      leftover.push(...cand.slice(i).map((s) => s.id)); // 남은 컷은 다음 잡으로
      break;
    }
    await log(`영상 ${i + 1}~${i + chunk.length}/${cand.length}…`);
    await Promise.all(
      chunk.map(async (s) => {
        try {
          const dur = estimateVideoSeconds(s.cut); // 대사/타입/지정 기반 초(0.5 단위 가능)
          const grokDur = Math.max(1, Math.min(10, Math.round(dur))); // Grok 은 정수만
          // ★콘텐츠 정책 거부 시 순화 프롬프트로 1회 자동 재시도 — 프롬프트가 원인이면 통과.
          //   이미지 자체가 걸리면 그래도 실패(그건 3단계에서 그 컷을 순화 재생성해야 함).
          // ★엔진 분기: kling(첫+끝 프레임 보간 가능·품질) 또는 grok. 프롬프트는 공통(buildVideoPrompt).
          //   동작 보간(스펙 §4): 이 컷 interpolationOn 이면 끝 프레임 = 바로 다음(연속) 컷의 이미지.
          //   구조 변경 없음 — 두 컷 다 씬으로 남고, 이 컷이 "이 이미지→다음 이미지"로 움직이는 클립이 된다.
          let eng = engineFor(s.cut); // ★컷별 엔진(action=Kling, 일반=MiniMax, 폴백 포함)
          const nextScene = scenes.find((x) => x.order > s.order && x.generatedImage);
          // ★끝 프레임 결정 —
          //   (1) 동작 보간 켠 컷: 끝 프레임 = 다음 연속 컷 이미지(원래 기능).
          //   (2) 그 외 '잔잔한' 컷: 끝 프레임 = 자기 자신(앵커링). I2V 는 프레임마다 얼굴을 다시
          //       그려 시간이 갈수록 다른 사람이 되는데(사용자: 동영상 얼굴 고정 불안), 끝을 원본
          //       그림으로 못박으면 클립이 원본 얼굴로 돌아와야 하므로 표류가 구조적으로 묶인다.
          //   ★액션 컷은 앵커링하지 않는다 — 끝이 시작과 같아지면 '한 번만 차고 끝'이 아니라
          //     되감기가 되어 SINGLE_BEAT 규칙과 정면 충돌한다(사용자 지시: 되감기 금지).
          //   문제 생기면 워커 env VIDEO_ANCHOR_TAIL=0 으로 즉시 끌 수 있다.
          // ★앵커 기본 OFF — 앵커를 걸면 끝프레임 때문에 트림을 못 하고(trimTo=!tailUrl) 클립이
          //   엔진 최소 길이(MiniMax 6초)로 남아 파일·버퍼가 2배가 된다. 1080p 상향과 겹쳐
          //   워커가 즉시 OOM 났다(사용자: 예전엔 안 터지던 분량이 바로 터짐). 메모리가 여유
          //   있을 때만 env VIDEO_ANCHOR_TAIL=1 로 켠다.
          const ANCHOR = (process.env.VIDEO_ANCHOR_TAIL ?? "0") === "1";
          // ★앵커는 '움직임이 연속적이고 되돌아와도 자연스러운' 티어에만 — talk(입·표정)·idle(숨·머리카락).
          //   emote(표정 A→B)·action(한 박자)에 앵커를 걸면 끝이 시작과 같아져 '되감기'가 되고,
          //   침 뱉기·발차기가 되돌아가 버린다(사용자 금지 사항). 그 티어는 앵커 없이 트림으로 처리.
          const tier = s.cut?.motionTier;
          const anchorable = tier === "talk" || tier === "idle";
          let tailUrl;
          if (s.cut?.interpolationOn && nextScene) tailUrl = nextScene.generatedImage; // (1) 보간
          else if (ANCHOR && anchorable) tailUrl = s.generatedImage; // (2) 자기 자신으로 앵커(표류 억제)
          // Grok 은 끝 프레임 미지원 → 앵커·보간 모두 무시된다(전달만 하고 grok.mjs 가 안 씀).
          // ★대기 로그는 '드물게·경과시간과 함께'. 엔진 폴링은 6초마다 tick 하는데 그때마다
          //   찍으면 컷 3개 기준 분당 30줄이라, 진행 로그(120줄)가 몇 분이면 통째로 밀려
          //   정작 필요한 [진단]·실패 사유가 사라진다. 또 같은 문구만 반복되면 진행 중인지
          //   멈춘 건지 구분도 안 된다 → 30초마다, 경과 초를 붙여 남긴다.
          const tickStart = Date.now();
          let lastTick = 0;
          const tick = (label) => async () => {
            const el = Math.round((Date.now() - tickStart) / 1000);
            if (el - lastTick < 30) return; // 30초 간격으로만
            lastTick = el;
            await log(`컷 ${s.order + 1} 생성 대기 ${el}s…(${label})`);
          };
          const genOn = (e, prompt) =>
            e === "kling"
              ? klingVideoFromImage(
                  { imageUrl: s.generatedImage, imageTailUrl: tailUrl, prompt, duration: dur },
                  tick(`Kling${tailUrl ? "·보간" : ""}`)
                )
              : e === "minimax"
              ? minimaxVideoFromImage(
                  { imageUrl: s.generatedImage, imageTailUrl: tailUrl, prompt, duration: dur },
                  tick(tailUrl ? (s.cut?.interpolationOn ? "MiniMax·보간" : "MiniMax·앵커") : "MiniMax")
                )
              : grokVideoFromImage(
                  { imageUrl: s.generatedImage, prompt, duration: grokDur },
                  tick(`Grok ${grokDur}s`)
                );
          // ★엔진 failover — 한 엔진이 죽어도 컷을 잃지 않는다. 콘텐츠 정책 거부는 엔진을
          //   바꿔도 같으니 그대로 올려보내고(위에서 순화 재시도), 그 외 실패(연결·5xx·타임아웃)는
          //   다른 엔진으로 한 번 더 시도한다. 실제 사고: MiniMax "fetch failed" 로 컷 3개 통째 실패.
          // 이 컷에 '보이는' 캐릭터들(캐스팅 sceneIds 기준) — 화자가 이 중에 없으면 입 다뭄.
          // ★sceneIds 에는 '목소리만 나오는 컷'(하늘·풍경에 화면 밖 대사)도 들어간다. 그런 컷에
          //   인물 묘사·발화 지시를 실으면 I2V 가 '입을 움직일 얼굴'을 지어 넣는다(실사례:
          //   영상 생성에 이상한 얼굴 끼어듦). 그림에서 확인된 인물이 없는 비인물 컷은 빈 목록.
          const noVisibleChar =
            (s.cut?.characters?.length ?? 0) === 0 && (s.cut?.type === "object" || s.cut?.type === "text");
          const shownCast = noVisibleChar ? [] : (p.cast ?? []).filter((c) => (c.sceneIds ?? []).includes(s.id));
          const shownCharIds = shownCast.map((c) => c.id);
          // ★엔진별 프롬프트 예산 — Kling 2500·MiniMax 2000자 상한(초과분은 API 가 뒤를 자른다).
          //   둘 다 1900 으로 깎았더니 Kling 이 쓸 수 있는 여유를 버려 품질이 떨어졌다(사용자 보고).
          const budgetFor = (e) => (e === "kling" ? 2400 : e === "minimax" ? 1900 : 1800);
          const promptFor = (e) =>
            buildVideoPrompt(s.cut, shownCharIds, p.storyContext, shownCast, { budget: budgetFor(e) });
          const genVideo = async (override) => {
            try {
              return await genOn(eng, override ?? promptFor(eng));
            } catch (e) {
              const msg = String(e?.message ?? e);
              if (/콘텐츠 정책|content|policy|moderation|safety|flag/i.test(msg)) throw e;
              const alt = eng === "minimax" ? (hasKling ? "kling" : "grok") : hasMM ? "minimax" : "grok";
              if (alt === eng) throw e;
              await log(`컷 ${s.order + 1} ${eng} 실패(${msg.slice(0, 80)}) → ${alt} 로 재시도`);
              eng = alt; // 비용·배지도 실제 사용 엔진으로 기록되게
              return await genOn(alt, override ?? promptFor(alt)); // ★엔진 바뀌면 그 엔진 예산으로 재조립
            }
          };
          let videoUrl;
          try {
            videoUrl = await genVideo();
          } catch (e) {
            if (/콘텐츠 정책|content|policy|moderation|safety|flag/i.test(String(e?.message ?? e))) {
              await log(`컷 ${s.order + 1} 정책 거부 → 순화 프롬프트로 재시도`);
              videoUrl = await genVideo(
                "Subtle, gentle, calm cinematic camera movement only. The motion happens exactly ONCE — never loop or repeat it. Do not add, change, or emphasize anything in the scene."
              );
            } else throw e;
          }
          // ★영상은 디스크로 흘려 받고, 인코딩도 파일→파일, 업로드도 스트림 — RAM 에 영상이 없다.
          const vdir = await mkdtemp(join(tmpdir(), `vid${s.order}-`));
          let uploadedUrl = null;
          try {
            const srcPath = join(vdir, "src.mp4");
            await downloadToFile(videoUrl, srcPath);
          // ★지정 비율로 채워-크롭 + 오디오 제거. Grok 이 1:1 입력을 가로형으로 내도 여기서 프로젝트 비율로 바로잡음.
          //   실패 시 오디오만 제거(stripAudio), 그것도 실패면 원본.
          // ★★ffmpeg 구간은 직렬(withFfmpeg) — 영상 생성(네트워크, 컷당 수 분)은 3개 병렬로 두되,
          //   인코딩은 한 번에 하나만. 예전엔 3벌이 동시에 돌아 [원본 버퍼 + 결과 버퍼 + ffmpeg
          //   프로세스] × 3 이 겹쳐 Render 워커가 메모리 초과 재시작했다(사용자 보고).
          //   Render 는 컨테이너 전체를 재므로 ffmpeg 프로세스 메모리도 같이 계산된다.
          // ★길이 트림 — 엔진 최소 길이(Kling 3초)와 의도한 길이(dur)가 다르면 잘라낸다.
          //   단 '동작 보간' 클립은 끝 프레임(다음 컷 이미지)에 도달하는 게 목적이라 자르면
          //   도착 포즈가 사라진다 → 보간 컷은 트림하지 않는다.
            const trimTo = !tailUrl && dur > 0 ? dur : undefined;
            // 인코딩은 여전히 직렬(withFfmpeg) — 동시에 여러 ffmpeg 가 뜨지 않게.
            const conformed = await withFfmpeg(() => conformVideoFile(srcPath, p, trimTo, vdir));
            const finalPath = conformed ?? srcPath; // 실패하면 원본 그대로 올린다(끊기지 않게)
            const size = (await stat(finalPath)).size;
            const r2 = await put(
              `project/${projectId}/vid-${s.order}-${Date.now()}.mp4`,
              Readable.toWeb(createReadStream(finalPath)), // ★스트림 업로드 — 버퍼 안 만든다
              { access: "public", contentType: "video/mp4", addRandomSuffix: false }
            );
            uploadedUrl = r2.url;
            await log(`컷 ${s.order + 1} 업로드 ${(size / 1048576).toFixed(1)}MB${conformed ? "" : " (비율맞춤 실패 → 원본)"}`);
          } finally {
            await rm(vdir, { recursive: true, force: true }).catch(() => {}); // 임시파일 즉시 정리(디스크)
          }
          const url = uploadedUrl;

          byId.set(s.id, { url, engine: eng });
          // 엔진별 초당 단가 × 길이.
          const unitCost = eng === "kling" ? KLING_VIDEO_COST : eng === "minimax" ? MINIMAX_VIDEO_COST : GROK_VIDEO_COST;
          costTotal += unitCost * dur;
          engCount[eng] = (engCount[eng] || 0) + 1;
          ok++;
          const engName = eng === "kling" ? "Kling" : eng === "minimax" ? "MiniMax" : "Grok";
          await log(`컷 ${s.order + 1} 영상 완료 (${dur}s · ${engName})`); // ★실제 사용 엔진 표시

        } catch (e) {
          byId.set(s.id, { error: String(e?.message ?? e) });
          await log(`컷 ${s.order + 1} 영상 실패: ${String(e?.message ?? e).slice(0, 120)}`);
        }
        await flush(false);
      })
    );
    const doneN = Math.min(i + chunk.length, cand.length);
    await log(`진행 ${doneN}/${cand.length} (${Math.round((doneN / cand.length) * 100)}%)`);
  }

  try {
    // 컷별로 엔진이 섞일 수 있어 vendor 는 가장 많이 쓴 엔진 기준(집계는 meta.engines 에).
    const topEng = Object.entries(engCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "kling";
    await recordCost({
      projectId,
      vendor: topEng === "kling" ? "kling" : topEng === "minimax" ? "minimax" : "xai",
      model: topEng === "kling" ? "kling-i2v" : topEng === "minimax" ? "minimax-hailuo" : "grok-imagine-video",
      costUsd: costTotal,
      meta: { kind: "video", engines: engCount, clips: cand.length, ok },
    });
  } catch {}

  // 남은 컷이 있으면 이어달리기 — 지금까지 결과는 저장하되 단계는 running 으로 두고
  // 후속 잡을 적재한다. 사용자에겐 계속 진행 중으로 보이고, 잡은 캡 안에서 끝난다.
  if (leftover.length) {
    await flush(false);
    try {
      await enqueueJob("video", projectId, { sceneIds: leftover });
      await log(`⏱ 잡 시간 한도 — 남은 ${leftover.length}컷은 이어서 자동 진행합니다(계속 대기하세요)`);
    } catch (e) {
      await flush(true);
      await log(`남은 ${leftover.length}컷 이어달리기 적재 실패: ${String(e?.message ?? e).slice(0, 100)} — 다시 실행해 주세요`);
    }
    return ok;
  }

  await flush(true);
  await log(`영상 완료: ${ok}/${cand.length} (~$${costTotal.toFixed(3)})`);
  return ok;
}

// ── dub(M6): 대사·내레이션을 TTS로 음성화 → bubble.audioUrl / cut.narrationAudioUrl ──
//    화자=캐릭터면 그 캐릭터 목소리, 화자 없음(내레이션)이면 프로젝트 나레이터 목소리.
//    payload.sceneIds 있으면 그 컷만. scene 단계로 진행 표시.
// ── postfx: Grok 원본 클립에 줌 커브(크래시인/아웃·램프·펀치)를 ffmpeg 로 실제 픽셀에 굽기 ──
//    결과는 scene.fxUrl — 미리보기·합성이 그대로 재사용(미리보기 = 최종 픽셀). 원본 videoUrl 은
//    보존이라 강도 바꿔 재적용·해제(none) 가능. 저장은 fresh 재읽기 후 해당 필드만 머지(저장 규약).
export async function runPostfx(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[postfx]", m);
    await logProgress(projectId, m);
  };
  const effect = String(payload?.effect ?? "");
  const strength = Math.max(1, Math.min(3, Math.round(Number(payload?.strength) || 2)));
  const ids = new Set(Array.isArray(payload?.sceneIds) ? payload.sceneIds : []);
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const targets = (p.scenes ?? []).filter((s) => ids.has(s.id) && s.videoUrl);
  if (!targets.length) throw new Error("후처리할 영상이 없어요(먼저 동영상 생성)");

  // effect=none → 렌더 없이 해제.
  if (effect === "none") {
    const p2 = await getProject(projectId);
    for (const s of p2.scenes ?? []) {
      if (ids.has(s.id)) {
        delete s.fxUrl;
        delete s.fx;
      }
    }
    await saveProject(p2);
    await log(`후처리 해제 ${targets.length}컷 — 원본 사용`);
    return targets.length;
  }

  const ff = await ffmpegPath();
  const fp = await (async () => {
    try {
      return process.env.FFPROBE_PATH || (await import("ffprobe-static")).default?.path || "ffprobe";
    } catch {
      return "ffprobe";
    }
  })();
  const probe = (file, entry) =>
    new Promise((res) => {
      const pr = spawn(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", entry, "-of", "default=nw=1:nk=1", file]);
      let out = "";
      pr.stdout.on("data", (d) => (out += d));
      pr.on("close", () => res(out.trim().split(/\s+/).map(Number)));
      pr.on("error", () => res([]));
    });
  // 강도별 최대 줌(2.0 초과는 픽셀 뭉개짐 — 상한 고정).
  const ZM = { 1: 1.35, 2: 1.65, 3: 2.0 }[strength];

  let done = 0;
  for (const s of targets) {
    let dir;
    try {
      dir = await mkdtemp(join(tmpdir(), "refx-"));
      const inp = join(dir, "in.mp4");
      const outp = join(dir, "out.mp4");
      await downloadToFile(s.videoUrl, inp); // 스트리밍 — 영상 버퍼를 메모리에 올리지 않는다
      const [W, H] = await probe(inp, "stream=width,height");
      const [T] = await probe(inp, "format=duration");
      if (!W || !H || !T) throw new Error("클립 정보를 읽지 못함");
      // 줌 커브 Z(t) — 프리셋 문법과 동일한 2단 속도 철학. crop 은 짝수 강제(코덱 요구).
      const T1 = Math.max(0.3, T - 0.4).toFixed(3); // 크래시인: 마지막 0.4s 에 스냅
      const PAN = new Set(["pan-left", "pan-right", "pan-up", "pan-down"]);
      let vf;
      if (PAN.has(effect)) {
        // 느린 팬 — 살짝 확대(ZP)해 여백을 만들고, 그 여백을 클립 길이 동안 한 방향으로 천천히 이동.
        //   줌은 고정(카메라 이동만), x/y 가 t 에 따라 선형 이동. 강도=여백(=이동량).
        const ZP = { 1: 1.12, 2: 1.18, 3: 1.25 }[strength];
        const Tf = Math.max(0.3, Number(T)).toFixed(3);
        const xExpr =
          effect === "pan-right" ? `(iw-ow)*min(1,t/${Tf})`
          : effect === "pan-left" ? `(iw-ow)*(1-min(1,t/${Tf}))`
          : `(iw-ow)/2`;
        const yExpr =
          effect === "pan-down" ? `(ih-oh)*min(1,t/${Tf})`
          : effect === "pan-up" ? `(ih-oh)*(1-min(1,t/${Tf}))`
          : `(ih-oh)/2`;
        vf =
          `crop=w='floor(iw/${ZP}/2)*2':h='floor(ih/${ZP}/2)*2':` +
          `x='${xExpr}':y='${yExpr}',scale=${W}:${H},setsar=1`;
      } else {
        const Z = {
          "crash-in": `if(lt(t,${T1}), 1+0.06*t/${T1}, 1.06+(${ZM}-1.06)*pow(min(1,(t-${T1})/0.4),2))`,
          "crash-out": `if(lt(t,0.35), ${ZM}, max(1, ${ZM}-(${ZM}-1)*pow(min(1,(t-0.35)/0.4),2)))`,
          "ramp-in": `1+(${ZM}-1)*pow(t/${T.toFixed(3)},2.5)`,
          punch: `if(lt(t,0.1), 1+(${ZM}-1)*t/0.1, if(lt(t,0.55), ${ZM}-(${ZM}-1.12)*(t-0.1)/0.45, 1.12))`,
        }[effect];
        if (!Z) throw new Error(`알 수 없는 효과: ${effect}`);
        // 펀치는 감쇠 흔들림 추가(수평 0.5s).
        const shake = effect === "punch" ? `+${(0.015 * strength).toFixed(4)}*iw*sin(55*t)*exp(-6*t)` : "";
        vf =
          `crop=w='floor(iw/(${Z})/2)*2':h='floor(ih/(${Z})/2)*2':` +
          `x='(iw-ow)/2${shake}':y='(ih-oh)/2',scale=${W}:${H},setsar=1`;
      }
      await new Promise((res, rej) => {
        const pr = spawn(ff, ["-hide_banner", "-nostats", "-loglevel", "warning", "-y", "-i", inp, "-vf", vf, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", "-threads", "2", "-movflags", "+faststart", outp]);
        let err = "";
        pr.stderr.on("data", (d) => {
          err += d;
          if (err.length > 8000) err = err.slice(-8000);
        });
        pr.on("error", rej);
        pr.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}: ${err.slice(-300)}`))));
      });
      const { url } = await put(`project/${projectId}/fx-${s.order}-${Date.now()}.mp4`, await readFile(outp), {
        access: "public",
        contentType: "video/mp4",
        addRandomSuffix: false,
      });
      // fresh 재읽기 후 해당 씬 필드만 머지(다른 갱신 클로버 방지 — 저장 규약).
      const p2 = await getProject(projectId);
      const t2 = (p2?.scenes ?? []).find((x) => x.id === s.id);
      if (p2 && t2) {
        t2.fxUrl = url;
        t2.fx = { effect, strength };
        await saveProject(p2);
      }
      done++;
      await log(`후처리 ${done}/${targets.length} — 컷 ${s.order + 1} (${effect}·강도${strength})`);
    } catch (e) {
      await log(`컷 ${s.order + 1} 후처리 실패: ${String(e?.message ?? e).slice(0, 120)}`);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  await log(`후처리 완료 ${done}/${targets.length}`);
  return done;
}

// ── 카메라워크(스펙 §2 계층 A) — scene.cameraWork 를 I2V 클립 위에 구워 fxUrl 로 저장 ──
//   수식은 lib/cameraKeyframes.mjs 단일 소스, 렌더는 worker/cameraRender.mjs(sendcmd).
//   기존 runPostfx(effect/strength 프리셋)는 그대로 유지 — 이 잡은 새 cameraWork 경로.
//   skip(정지/orbit/계층B/무cameraWork) → fxUrl 해제(원본 클립 사용). 저장은 fresh 머지.
// 카메라워크 지문 — 이 설정으로 이미 구웠는지 판단용(앱 lib/camSig 와 같은 규칙이어야 한다).
export function camSig(cw) {
  if (!cw || !cw.preset) return "";
  const s = JSON.stringify(cw);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${cw.preset}:${h.toString(36)}`;
}

export async function runCameraFx(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[camerafx]", m);
    await logProgress(projectId, m);
  };
  const ids = new Set(Array.isArray(payload?.sceneIds) ? payload.sceneIds : []);
  // ★★프록시 렌더(스펙 §8②) — "정확 미리보기": 480p 로 빠르게 굽고 fxProxyUrl 에 저장한다.
  //   클라이언트 프리뷰는 '근사'라서 orbit·계층B 는 아예 못 보고, 굽기 결과와도 미세하게 다르다.
  //   본 굽기(fxUrl)를 건드리지 않으므로 미리보기용으로 몇 번이든 돌릴 수 있다.
  const proxy = payload?.proxy === true;
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const targets = (p.scenes ?? []).filter((s) => ids.has(s.id) && s.videoUrl);
  if (!targets.length) throw new Error("카메라워크 적용할 영상이 없어요(먼저 동영상 생성)");

  const ff = await ffmpegPath();
  const fp = await ffprobePath();

  let done = 0;
  for (const s of targets) {
    const cw = s.cut?.cameraWork; // 카메라워크는 cut 에 저장(저장 경로 재사용 — /api/cut 화이트리스트)
    let dir;
    try {
      dir = await mkdtemp(join(tmpdir(), "recam-"));
      const inp = join(dir, "in.mp4");
      const outp = join(dir, "out.mp4");
      const buf = await download(s.videoUrl);
      await writeFile(inp, buf);

      // ★계층 B(버티고·패럴랙스)는 인물 매트가 있어야 굽는다 — 없으면 여기서 만든다.
      //   매트는 컷 이미지에서 한 번만 만들면 되므로 scene.matteUrl 에 저장해 재사용한다
      //   (다시 구울 때마다 돈을 쓰지 않는다). 실패하면 그 컷만 스킵되고 잡은 계속된다.
      let mattePath;
      let platePath;
      let layerBSingle = false; // 인물 없는 컷·매트 불량 → 배경 트랙 단일 레이어(겹침 위험 0)
      if (cw && presetLayer(cw.preset) === "B" && !(s.cut?.characters ?? []).length) {
        // ★인물 없는 컷(풍경·사물·텍스트) — 분리할 인물이 없다. 매트·배경판을 만들지 않고(비용 0)
        //   배경 궤적을 프레임 전체에 적용한다. 예전엔 이런 컷이 통째로 스킵돼 "패럴랙스가 안 된다"였다.
        layerBSingle = true;
        await log(`컷 ${s.order + 1} 인물 없는 컷 — ${cw.preset} 를 단일 레이어(배경 궤적)로 굽습니다`);
      } else if (cw && presetLayer(cw.preset) === "B") {
        try {
          let mUrl = s.matteUrl;
          if (!mUrl) {
            const src = s.generatedImage || s.originalImage;
            await log(`컷 ${s.order + 1} 인물 매트 생성 중…`);
            const { buf: mbuf, cost } = await generateMatte(src, process.env.FAL_KEY, (m) => console.error("[matte]", m));
            const up = await put(`project/${projectId}/matte/${s.id}-${Date.now()}.png`, mbuf, {
              access: "public",
              contentType: "image/png",
              addRandomSuffix: false,
            });
            mUrl = up.url;
            s.matteUrl = mUrl; // 아래 저장 루프가 씬 필드를 그대로 기록한다
            try {
              await recordCost({ projectId, vendor: "fal", model: "matte", costUsd: cost, meta: { kind: "matte", sceneId: s.id } });
            } catch {}
          }
          const mp = join(dir, "matte.png");
          const matteBuf = await download(mUrl);
          // ★매트 sanity — 흰(인물) 비율이 0 에 가까우면 인물 없음, 0.75 초과면 배경 제거 모델이
          //   화면 대부분을 전경으로 오판한 것. 그대로 2레이어를 만들면 배경판·합성이 다 망가진다
          //   → 단일 레이어로 굽는다(비용 추가 0).
          const whiteRatio = await matteWhiteRatio(matteBuf);
          if (whiteRatio < 0.005 || whiteRatio > 0.75) {
            layerBSingle = true;
            await log(`컷 ${s.order + 1} 매트 부적합(인물 비율 ${(whiteRatio * 100).toFixed(0)}%) — 단일 레이어(배경 궤적)로 굽습니다`);
            throw { __single: true }; // 아래 plate 생성 건너뜀(catch 에서 무시)
          }
          await writeFile(mp, matteBuf);
          mattePath = mp;

          // ★클린 플레이트(인물을 지운 배경판) — 계층 B 배경 레이어(사용자 결정 2026-08-03).
          //   원본 프레임을 배경으로 쓰면 인물 복사본이 겹쳐 보이므로(사용자: "배경이 겹쳐 나온다")
          //   인물 자리를 인페인팅으로 지운 판을 컷당 1회 만들어 재사용한다(scene.cleanPlateUrl).
          let plUrl = s.cleanPlateUrl;
          // ★생성 방식이 바뀌면 옛 판은 폐기 — v1(실루엣 Fill)=잔상, v2(박스 Fill)=배경 훼손
          //   (모두 사용자 실측 기각). 경로의 버전(plate-v3/=제거 전용 Erase)으로 구분해 다시 만든다.
          if (plUrl && !plUrl.includes("/plate-v3/")) plUrl = null;
          if (!plUrl) {
            const src = s.generatedImage || s.originalImage;
            await log(`컷 ${s.order + 1} 배경판(클린 플레이트) 생성 중…`);
            const { buf: pbuf, cost } = await generateCleanPlate(src, matteBuf, process.env.FAL_KEY, (m) => console.error("[plate]", m));
            const pup = await put(`project/${projectId}/plate-v3/${s.id}-${Date.now()}.png`, pbuf, {
              access: "public",
              contentType: "image/png",
              addRandomSuffix: false,
            });
            plUrl = pup.url;
            s.cleanPlateUrl = plUrl; // 아래 저장 루프가 씬 필드를 그대로 기록한다
            try {
              await recordCost({ projectId, vendor: "fal", model: "clean-plate", costUsd: cost, meta: { kind: "plate", sceneId: s.id } });
            } catch {}
          }
          const pp2 = join(dir, "plate.png");
          await writeFile(pp2, await download(plUrl));
          platePath = pp2;
        } catch (e) {
          // ★재료(매트·배경판) 실패 = 스킵이 아니라 '단일 레이어로 대체' — 스킵하면 그 컷은
          //   아무 움직임도 없는 원본이 된다(사용자: "심지어 줌도 안 된다"). 시차는 없어도
          //   카메라 무브 자체는 보장하고, 사유를 로그로 남긴다(몰래 낮추지 않는다).
          layerBSingle = true;
          if (!e?.__single) // __single = 매트 부적합 → 단일 레이어 전환(실패 아님, 위에서 로그함)
            await log(`컷 ${s.order + 1} 매트·배경판 실패 → 단일 레이어(시차 없음)로 대체: ${String(e?.message ?? e).slice(0, 140)}`);
        }
      }

      let result = { skipped: true, layer: "-" };
      if (cw && cw.preset) {
        result = await renderCameraFx({
          ff, fp, dir, inPath: inp, outPath: outp, cameraWork: cw, mattePath, platePath, layerBSingle,
          onLog: (m) => console.error("[camerafx]", m),
        });
      }
      // 프록시는 480p 로 줄여 용량·시간을 낮춘다(정확한 궤적은 그대로 — 굽기 결과와 같은 수식).
      let proxyOut = null;
      if (proxy && !result.skipped) {
        proxyOut = join(dir, "proxy.mp4");
        await new Promise((res, rej) => {
          const pr = spawn(ff, [
            "-y", "-i", outp, "-vf", "scale=-2:480", "-an",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
            "-threads", "1", "-tune", "zerolatency", "-bf", "0",
            "-movflags", "+faststart", proxyOut,
          ]);
          let err = "";
          const kill = setTimeout(() => { try { pr.kill("SIGKILL"); } catch {} }, 3 * 60 * 1000);
          pr.stderr.on("data", (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
          pr.on("error", (e) => { clearTimeout(kill); rej(e); });
          pr.on("close", (c) => { clearTimeout(kill); c === 0 ? res() : rej(new Error(`ffmpeg ${c}: ${err.slice(-200)}`)); });
        });
      }

      // fresh 재읽기 후 해당 씬 필드만 머지(저장 규약).
      const p2 = await getProject(projectId);
      const t2 = (p2?.scenes ?? []).find((x) => x.id === s.id);
      if (p2 && t2 && proxy) {
        // 프록시: 본 굽기 결과(fxUrl)는 절대 건드리지 않는다 — 미리보기 전용.
        if (proxyOut) {
          const { url } = await put(`project/${projectId}/camproxy-${s.order}-${Date.now()}.mp4`, createReadStream(proxyOut), {
            access: "public",
            contentType: "video/mp4",
            addRandomSuffix: false,
          });
          t2.fxProxyUrl = url;
        } else {
          delete t2.fxProxyUrl; // 카메라워크 없음 = 프록시도 없음
        }
        if (s.matteUrl) t2.matteUrl = s.matteUrl; // 이번에 만든 매트 보존(다시 만들지 않게)
        if (s.cleanPlateUrl) t2.cleanPlateUrl = s.cleanPlateUrl; // 배경판도 보존(재과금 방지)
        await saveProject(p2);
      } else if (p2 && t2) {
        if (s.matteUrl) t2.matteUrl = s.matteUrl;
        if (s.cleanPlateUrl) t2.cleanPlateUrl = s.cleanPlateUrl;
        // ★어떤 설정으로 구웠는지 지문을 남긴다 — 앱이 '이 컷은 지금 설정대로 구워져 있나'를
        //   판단해 자동으로 다시 굽는다(사용자가 '뭘 굽고 뭘 안 굽는지' 외우지 않게).
        const sig = camSig(cw);
        if (result.skipped) {
          // 후처리 없음 → 원본 클립 사용. 낡은 fxUrl 무효화(안 지우면 미리보기가 옛 fx 를 보여줌).
          delete t2.fxUrl;
          t2.fx = { effect: "cam:none", strength: 0, sig }; // 지문은 남긴다(= 다시 구울 필요 없음)
        } else {
          const { url } = await put(`project/${projectId}/cam-${s.order}-${Date.now()}.mp4`, createReadStream(outp), {
            access: "public",
            contentType: "video/mp4",
            addRandomSuffix: false,
          });
          t2.fxUrl = url;
          t2.fx = { effect: `cam:${cw.preset}`, strength: 0, sig };
        }
        await saveProject(p2);
      }
      done++;
      await log(`${proxy ? "프록시 미리보기" : "카메라워크"} ${done}/${targets.length} — 컷 ${s.order + 1} (${cw?.preset ?? "없음"}${result.skipped ? "·원본" : result.upscale ? "·업스케일" : ""})`);
    } catch (e) {
      await log(`컷 ${s.order + 1} 카메라워크 실패: ${String(e?.message ?? e).slice(0, 120)}`);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  await log(`카메라워크 완료 ${done}/${targets.length}`);
  return done;
}

export async function runDub(projectId, payload) {
  // ★비디오 잡과 '병렬'로 돌 수 있으므로 공유 진행로그(resetProgress/logProgress)·단계 상태를
  //   건드리지 않는다(그러면 동영상 진행 표시가 깨짐).
  // ★단 '콘솔에만' 남기면 사용자는 왜 더빙이 안 됐는지 앱에서 볼 수 없다(=이번 문제).
  //   더빙 전용 로그 키에 남기고 /api/job(dub 잡)이 그대로 화면에 흘린다.
  await resetDubLog(projectId);
  const log = async (m) => {
    console.error("[dub]", m);
    await logDub(projectId, m);
  };
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const cast = p.cast ?? [];
  const narrator = p.narratorVoice || null;
  // ★★언어별 더빙(§10) — payload.lang 이 오면 그 언어로 더빙한다(작업 언어 무시).
  //   예전에는 더빙이 project.workingLanguage 만 봐서, "일본어판 합성"을 눌러도 일본어 오디오가
  //   없으면 원문(중국어) 오디오로 폴백됐다 — 자막만 일본어, 소리는 중국어(사용자 보고).
  //   이제 언어를 직접 받아 그 언어 트랙에 오디오를 채울 수 있다.
  // ★lang 을 안 받았고 작업 언어도 안 정해져 있으면 '대상 언어(🌐) 첫 번째' 로 더빙한다.
  //   앱이 언어를 안 넘기는 경로(옛 배포·다른 버튼)에서도 원어(중국어) 더빙이 생기지 않게.
  //   원어 더빙은 lang="" 을 명시해야 한다('🎙 원어로' 버튼).
  const workingLang =
    payload?.lang != null
      ? String(payload.lang).trim()
      : ((p.workingLanguage || "").trim() || (p.targetLanguages ?? [])[0] || "");
  const speed = Math.max(0.5, Math.min(2, Number(p.dubSpeed) || 1.2)); // 말 속도 배수(기본 1.2배)
  const only =
    Array.isArray(payload?.sceneIds) && payload.sceneIds.length ? new Set(payload.sceneIds) : null;
  // ★특정 컷·선택 더빙(only 있음)이면 강제 재생성(사용자가 바꿔서 다시 하려는 것). 전체 더빙은
  //   이미 더빙된 줄(audioUrl)은 건너뛴다(증분) — 매번 전부 다시 만들어 '반복'되던 것 방지.
  const force = !!only;
  const scenes = (p.scenes ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .filter((s) => !only || only.has(s.id));

  // ★★그 언어 번역이 빠진 줄은 '여기서' 채우고 이어서 더빙한다.
  //   예전에는 "번역이 아직 없어요 — 4단계 'ja로 만들기' 를 누르세요" 라며 사람에게 되던졌다.
  //   그런데 그 버튼도 결국 같은 번역 잡을 부르는 것뿐이라, 사용자는 번역을 몇 번씩 다시
  //   돌리면서도 같은 자리에서 막혔다(빠진 줄이 남아 있으면 더빙이 또 거부).
  //   더빙 잡이 스스로 빠진 줄만 번역하면 이 왕복 자체가 없어진다.
  if (workingLang) {
    const lacks = (b) =>
      b && b.speakerId !== "__sfx__" && (b.text || "").trim() && !((b.tracks?.[workingLang]?.text || "").trim());
    const need = scenes.filter((s) => (s.cut?.bubbles ?? []).some(lacks));
    if (need.length) {
      const n = need.reduce((a, s) => a + (s.cut?.bubbles ?? []).filter(lacks).length, 0);
      await log(`${workingLang} 번역이 빠진 ${n}줄 — 더빙 전에 여기서 채웁니다`);
      try {
        const { translated, errors } = await translateScenesMultilang(need, [workingLang]);
        await log(
          `${workingLang} 번역 ${translated}줄 채움 — 이어서 더빙합니다` +
            (translated === 0 && errors?.length ? ` / ★번역이 0줄인 이유: ${errors.slice(0, 2).join(" | ")}` : "")
        );
        // 번역만이라도 즉시 저장한다(더빙이 뒤에서 실패해도 번역은 남게). 저장 규약: fresh 재읽기 후
        // 인덱스+원문이 일치하는 말풍선의 tracks 만 얹는다.
        if (translated > 0) {
          const pf = await getProject(projectId);
          if (pf) {
            const byId = new Map(need.map((s) => [s.id, s.cut]));
            pf.scenes = (pf.scenes ?? []).map((fresh) => {
              const cut = byId.get(fresh.id);
              if (!cut || !fresh.cut) return fresh;
              const bubbles = (fresh.cut.bubbles ?? []).map((fb, i) => {
                const nb = (cut.bubbles ?? [])[i];
                if (!nb || (nb.text ?? "") !== (fb.text ?? "") || !nb.tracks) return fb;
                return { ...fb, tracks: { ...(fb.tracks || {}), ...nb.tracks } };
              });
              return { ...fresh, cut: { ...fresh.cut, bubbles } };
            });
            await saveProject(pf);
          }
        }
      } catch (e) {
        // 번역이 실패해도 이미 번역된 줄은 더빙한다(전부 막지 않는다).
        await log(`${workingLang} 번역 실패(있는 줄만 더빙): ${String(e?.message ?? e).slice(0, 140)}`);
      }
    }
  }

  // 화자 id → 목소리. charId면 그 캐릭터(voice+provider), null/미지정이면 나레이터.
  const resolve = (speakerId) => {
    if (speakerId) {
      const c = cast.find((x) => x.id === speakerId);
      if (c?.voice) return { provider: c.voiceProvider || "eleven", id: c.voice, name: c.voiceName || c.label };
      return null; // 화자 지정됐지만 목소리 미배정 → 스킵
    }
    return narrator ? { provider: narrator.provider, id: narrator.id, name: narrator.name } : null;
  };

  // 합성 유닛 수집: 말풍선 + 내레이션.
  const units = [];
  let alreadyDone = 0; // 이미 더빙돼 스킵한 줄 수(전체 더빙 증분)
  let sugNoVoice = 0; // 목소리 없어 건너뛴 '오디오 제안'(부가 기능 — 더빙을 막지 않는다)
  let missingLang = 0; // 작업 언어 번역이 없어 원문으로 더빙한 줄 수
  for (const s of scenes) {
    const cut = s.cut;
    if (!cut) continue;
    normalizeNarration(cut); // 레거시 내레이션 문자열 → 내레이터 말풍선(분리 경로 제거)
    normalizeSfx(cut); // 검출 효과음 문자열 → 효과음 말풍선(__sfx__) — 통제·생성 일관
    let bubs = cut.bubbles ?? [];
    // ★말풍선이 없고 dialogue(한 줄 대사)만 있으면 그걸 단일 말풍선으로 승격 — 예전엔 dialogue 를
    //   무시해서 "대사 없음"으로 실패했음. 승격해두면 더빙·미리보기가 말풍선으로 일관된다.
    if (!bubs.length && (cut.dialogue || "").trim()) {
      bubs = [{ text: cut.dialogue.trim(), speakerId: cut.speakerId ?? null }];
      cut.bubbles = bubs;
      cut.dialogue = "";
    }
    for (let i = 0; i < bubs.length; i++) {
      const b = bubs[i];
      // ★작업 언어(§10): 그 언어 번역(tracks[lang].text)이 있으면 원문 대신 그걸 더빙하고 tracks[lang].audioUrl 에 저장.
      //   효과음(__sfx__)은 언어 무관. 미설정·번역 없으면 기존대로 원문(b.text) → b.audioUrl.
      const langText = workingLang && b.speakerId !== "__sfx__" ? (b.tracks?.[workingLang]?.text || "").trim() : "";
      const useLang = !!langText;
      // ★★언어별 더빙(payload.lang)에서 그 언어 번역이 없는 줄은 '건너뛴다' —
      //   예전엔 원문으로 더빙하려 했는데, 그러면 (a) 일본어 더빙인데 원문 소리가 생기고
      //   (b) '이미 더빙됨' 판정이 원문 오디오를 봐서 대부분이 스킵되고, 남은 몇 줄이
      //   화자 미지정이면 "목소리 미배정" 이라는 엉뚱한 에러가 났다(사용자 보고 — 목소리는
      //   멀쩡히 지정돼 있었다). 진짜 원인은 '그 언어 번역이 없음' 이다.
      // ★언어가 정해져 있으면(작업 언어든 payload.lang 이든) 그 언어 번역이 없는 줄은 건너뛴다.
      //   예전엔 payload.lang 일 때만 막아서, 일반 '더빙' 버튼은 작업 언어가 일본어여도 번역이
      //   없으면 원문(중국어)을 더빙했다 — 더빙을 두 번 눌러도 계속 중국어(사용자 보고).
      const langDub = !!workingLang;
      if (langDub && b.speakerId !== "__sfx__" && !useLang) {
        missingLang++;
        continue; // 번역 없는 줄은 이 언어 더빙 대상이 아니다
      }
      if (workingLang && b.speakerId !== "__sfx__" && !useLang) missingLang++;
      const text = useLang ? langText : (b.text || "").trim();
      if (!text) continue;
      const existing = useLang ? (b.tracks?.[workingLang]?.audioUrl || "") : (b.audioUrl || "");
      if (!force && existing.trim()) { alreadyDone++; continue; } // 이미 더빙된 줄 스킵(전체 더빙)
      if (b.speakerId === "__sfx__") {
        units.push({ s, kind: "sfx", idx: i, text, voice: "__sfx__" }); // 효과음 줄 → 소리 생성
      } else {
        // 화자 null = 내레이터. 캐릭터 대사·내레이션 모두 이 한 경로로만 더빙된다. lang 있으면 그 언어 트랙에 저장.
        units.push({ s, kind: "bubble", idx: i, text, voice: resolve(b.speakerId), spk: b.speakerId ?? null, emotion: b.emotion, lang: useLang ? workingLang : "" });
      }
    }
    // ── 오디오 제안(§6) 생성 — enabled 인 것만. sfx=효과음, vocal_reaction/insert_line=배역 발성(TTS). ──
    //   화자는 이 컷의 주 화자 목소리(없으면 내레이터). 이미 생성됐으면(audioUrl) 스킵(증분).
    const cutSpeakerId = (cut.bubbles ?? []).map((b) => b.speakerId).find((id) => id && id !== "__sfx__") ?? cut.speakerId ?? null;
    const sugs = cut.audioSuggestions ?? [];
    for (let si = 0; si < sugs.length; si++) {
      const sg = sugs[si];
      if (!sg || sg.enabled === false || !(sg.text || "").trim()) continue; // 끈 삽입 대사·빈 것 스킵
      // ★이미 오디오가 있으면 다시 만들지 않는다 — 돈이 드는 호출이다.
      //   (언어가 안 맞는 예전 제안 음성은 합성에서 제외되므로 소리로 새어나가지 않는다.
      //    다시 만들고 싶으면 그 컷에서 '이 컷 더빙' 을 누르면 된다 = 사용자가 비용을 결정.)
      if (!force && (sg.audioUrl || "").trim()) { alreadyDone++; continue; }
      // ★vocal_reaction(헐떡임·한숨 같은 비언어 발성)은 '대사' 가 아니다. TTS 로 보내면
      //   "gasp of shock" 같은 영어 설명문을 목소리가 그대로 읽는다 → 효과음 경로로 만든다.
      if (sg.type === "sfx" || sg.type === "vocal_reaction") {
        units.push({ s, kind: "sug_sfx", sugIdx: si, text: sg.text });
        continue;
      }
      // ★오디오 제안(삽입 대사)은 '부가' 기능이다 — 목소리가 없다고 더빙 잡 전체를 막으면 안 된다.
      //   실제로 이것 때문에 일본어 더빙이 통째로 실패했다(사용자 보고: 컷 3·11 "gasp of shock").
      //   게다가 이 항목은 컷 화면의 접힌 '연출·세부' 안에 있어서, 사용자는 그런 줄이 있는지도
      //   알 수 없었다. 목소리가 없으면 조용히 건너뛰고 로그로만 남긴다.
      const sugVoice = resolve(cutSpeakerId);
      if (!sugVoice) {
        sugNoVoice++;
        continue;
      }
      units.push({ s, kind: "sug_voice", sugIdx: si, text: sg.text, voice: sugVoice });
    }
  }
  if (!units.length) {
    // ★언어별 더빙인데 그 언어 번역이 없어서 대상이 0이면, 그걸 정확히 말한다.
    if (workingLang && missingLang > 0) {
      // ★여기까지 왔다는 건 위에서 '빠진 줄 번역' 을 이미 시도했는데도 안 채워졌다는 뜻이다.
      //   그러니 "번역 버튼을 누르세요"(같은 일을 또 시키는 안내) 대신 실제 상태를 말한다.
      throw new Error(
        `${workingLang} 번역이 ${missingLang}줄 비어 있어 더빙할 게 없습니다 — 번역을 자동으로 시도했지만 채우지 못했습니다(위 진행 로그의 번역 실패 사유 확인). 번역 API 키·응답 문제일 수 있습니다`
      );
    }
    if (alreadyDone > 0) {
      await log(`이미 다 더빙됨(${alreadyDone}줄) — 새로 만들 게 없어요. 바꾼 줄은 '이 컷 더빙'으로.`);
      return 0;
    }
    throw new Error("더빙할 대사·내레이션이 없어요");
  }
  if (missingLang > 0 && workingLang)
    await log(`[진단] ${workingLang} 번역 없는 ${missingLang}줄은 건너뜀 — 번역 채우고 다시 더빙하면 포함됩니다`);
  if (sugNoVoice > 0)
    await log(`오디오 제안 ${sugNoVoice}개는 목소리가 없어 건너뜀(더빙에는 영향 없음)`);

  // ★효과음 사전 점검 — 효과음만 ElevenLabs 를 쓴다(대사 TTS 와 별개 키). 키가 없으면
  //   효과음 전 건이 실패하는데, 대사가 성공하면 잡은 '완료'로 끝나 사용자는 이유를 모른다
  //   (실사례: "효과음이 왜 안 나?"). 시작할 때 화면에 먼저 말한다.
  {
    const sfxCount = units.filter((u) => u.kind === "sfx" || u.kind === "sug_sfx").length;
    if (sfxCount > 0 && !process.env.ELEVENLABS_API_KEY)
      await log(`★효과음 ${sfxCount}건 생성 불가 — 워커 env 에 ELEVENLABS_API_KEY 가 없습니다(대사 목소리와 별개). Render 대시보드 → 워커 환경변수에 추가하세요`);
  }
  await log(`더빙 대상 ${units.length}개 — 목소리 생성 시작`);
  const C = Number(process.env.DUB_CONCURRENCY || 2);
  let done = 0;
  let ok = 0;
  let skipped = 0;
  const skippedWho = new Set(); // 목소리 미배정 화자(진단용)
  const fails = []; // ★TTS 실패 사유(줄마다) — 하나도 못 만들면 이걸 그대로 사용자에게 보여준다
  let ttsChars = 0; // 실제로 합성한 글자 수(비용의 근거 — 사용자가 "얼마 쓰는지" 볼 수 있게)
  let sfxGens = 0; // 효과음 생성 건수(글자 수와 과금 방식이 다름)
  for (let i = 0; i < units.length; i += C) {
    const chunk = units.slice(i, i + C);
    await Promise.all(
      chunk.map(async (u) => {
        try {
          let audio;
          if (u.kind === "sfx" || u.kind === "sug_sfx") {
            // 효과음 — 한글 의성어를 영어 사운드 묘사로 바꿔 ElevenLabs Sound Effects.
            const desc = await sfxToEnglish(u.text, process.env.OPENAI_API_KEY);
            audio = await synthSfx(desc);
            sfxGens++;
          } else if (!u.voice) {
            skipped++;
            // ★어느 '줄' 인지까지 남긴다 — 예전엔 "내레이터(나레이터 목소리 미지정)" 라고만 해서,
            //   내레이터가 없는 작품인데 나레이터 목소리를 지정하라는 엉뚱한 안내가 됐다.
            //   실제로는 '화자가 지정되지 않은 대사 줄' 이다(화자 미지정=내레이터로 처리되는 구조).
            //   컷 번호와 대사 앞부분을 주면 사용자가 바로 그 줄로 가서 화자를 고르거나 지울 수 있다.
            const where = `컷 ${u.s.order + 1} “${String(u.text).replace(/\s+/g, " ").slice(0, 14)}”`;
            skippedWho.add(
              u.spk == null
                ? `${where} — 화자 미지정`
                : `${where} — ${cast.find((c) => c.id === u.spk)?.label ?? "캐릭터"} 목소리 미지정`
            );
            return;
          } else {
            audio = await synthesize(u.voice.provider, u.voice.id, u.text, speed, u.emotion, u.lang || "");
            ttsChars += String(u.text || "").length;
          }
          const { buf, ext, contentType } = audio;
          const slot = u.idx ?? u.sugIdx;
          const { url } = await put(
            `project/${projectId}/dub/${u.s.id}-${u.kind}${slot}-${Date.now()}.${ext}`,
            buf,
            { access: "public", contentType, addRandomSuffix: false }
          );
          if (u.kind === "sug_sfx" || u.kind === "sug_voice") {
            // ★어떻게·어느 언어로 만들었는지 남긴다 — 합성이 '일본어판에 영어 음성' 을 안 섞게.
            const sg2 = u.s.cut?.audioSuggestions?.[u.sugIdx];
            if (sg2) {
              sg2.audioUrl = url; // 오디오 제안(§6)
              sg2.gen = u.kind === "sug_sfx" ? "sfx" : "tts";
              sg2.lang = u.kind === "sug_sfx" ? "" : workingLang;
            }
          } else if (u.kind === "bubble" && u.lang && u.s.cut?.bubbles?.[u.idx]) {
            // 작업 언어 더빙 → 그 언어 트랙에 저장(§10). 원문 audioUrl 은 보존.
            const bb = u.s.cut.bubbles[u.idx];
            bb.tracks = bb.tracks || {};
            bb.tracks[u.lang] = { ...(bb.tracks[u.lang] || {}), audioUrl: url, status: "tts" };
          } else if (u.s.cut?.bubbles?.[u.idx]) {
            u.s.cut.bubbles[u.idx].audioUrl = url; // 원문 대사·내레이션·효과음 줄 → 말풍선 audioUrl
          }
          ok++;
        } catch (e) {
          // ★실패를 '삼키지' 않는다 — 예전엔 여기서 로그만 남기고 넘어가, 모든 줄이 실패해도
          //   잡은 성공으로 끝났다(화면엔 "✓ 더빙 완료"만 뜨고 원인은 Render 로그에만).
          //   그게 "일본어 더빙이 안 되는데 이유를 모르겠다" 의 원인이다.
          const why = String(e?.message ?? e).slice(0, 160);
          const who = u.voice ? `${u.voice.provider}/${u.voice.name ?? u.voice.id}` : u.kind;
          fails.push(`컷 ${u.s.order + 1}(${who}): ${why}`);
          await log(`더빙 실패(컷 ${u.s.order + 1}, ${who}): ${why}`);
        }
      })
    );
    done = Math.min(i + C, units.length);
    await log(`더빙 ${done}/${units.length} (${Math.round((done / units.length) * 100)}%)`);
  }

  // 효과음 줄(__sfx__)은 절제해서 사용: 검출된 것만 통제 가능한 줄로 등록되고, 사용자가 남긴 줄만
  // ElevenLabs 효과음으로 생성된다(원치 않으면 편집기에서 삭제). 실패해도 그 줄만 스킵(위 try/catch).

  // 하나도 못 만들었으면 → 조용히 '완료' 로 끝내지 말고, 진짜 이유를 그대로 올린다.
  if (ok === 0) {
    const langTag = workingLang ? `${workingLang} ` : "";
    if (fails.length) {
      // TTS 가 거절한 이유(모델·언어·키·크레딧)를 그대로 보여준다 — 추측하게 만들지 않는다.
      throw new Error(`${langTag}더빙 실패 ${fails.length}줄 — ${fails.slice(0, 2).join(" / ")}`);
    }
    if (skipped > 0) {
      // ★안내를 정확히 — 화자 미지정 줄은 '나레이터 목소리를 지정하라' 가 아니라
      //   '그 줄의 화자를 고르거나 줄을 지워라' 가 맞다(내레이터가 없는 작품이 대부분).
      const noSpeaker = [...skippedWho].some((w) => w.includes("화자 미지정"));
      throw new Error(
        `${langTag}더빙 못 한 ${skipped}줄 — ${[...skippedWho].slice(0, 3).join(" / ")}` +
          (noSpeaker
            ? `. 그 줄의 화자를 지정하거나(대사 줄의 화자 드롭다운) 대사가 아니면 줄을 지우세요. 내레이터가 없는 작품이면 나레이터 목소리는 지정할 필요 없습니다`
            : `. 캐스팅에서 그 목소리를 지정하세요`) +
          (alreadyDone > 0 ? `. (나머지 ${alreadyDone}줄은 이미 더빙돼 있습니다)` : "")
      );
    }
  }
  // 일부만 실패해도 사용자가 알 수 있게 남긴다(잡은 성공 — 만든 것은 유지).
  if (fails.length) await log(`⚠ ${fails.length}줄 실패 — ${fails[0]}`);

  // 저장 — 이번에 만진 씬의 '컷'만 교체(오디오·승격 반영). videoUrl 등 씬의 다른 필드는 최신 것을
  // 유지 → 병렬 비디오 결과를 안 지움. (비디오는 scene.videoUrl 을, 더빙은 scene.cut 을 쓴다.)
  const p2 = (await getProject(projectId)) ?? p;
  const touched = new Map(scenes.map((s) => [s.id, s.cut]));
  p2.scenes = (p2.scenes ?? []).map((fresh) =>
    touched.has(fresh.id) ? { ...fresh, cut: touched.get(fresh.id) } : fresh
  );
  await saveProject(p2);
  try {
    // ★예전엔 costUsd 를 무조건 0 으로 박아, 더빙을 몇 번을 돌려도 화면 '추정 제작비' 가
    //   움직이지 않았다 → 사용자가 얼마를 쓰는지 볼 방법이 없었다.
    //   단가는 요금제마다 달라 내가 지어내지 않는다: env 로 넣으면 금액이 잡히고,
    //   없으면 최소한 '글자 수·건수' 라는 사실을 기록해 남긴다.
    const perK = Number(process.env.TTS_COST_PER_1K_CHARS || 0); // 예: 0.20 (USD/1000자)
    const perSfx = Number(process.env.SFX_COST_PER_GEN || 0); // 예: 0.02 (USD/건)
    const costUsd = (ttsChars / 1000) * perK + sfxGens * perSfx;
    await recordCost({
      projectId,
      vendor: "tts",
      model: `dub${workingLang ? `-${workingLang}` : ""}`,
      costUsd,
      meta: { kind: "dub", ok, skipped, ttsChars, sfxGens, lang: workingLang || "src" },
    });
  } catch {}
  await log(
    `${workingLang ? `${workingLang} ` : ""}더빙 완료: 생성 ${ok}개(음성 ${ttsChars}자` +
      (sfxGens ? `, 효과음 ${sfxGens}건` : "") +
      `)${alreadyDone ? `, 이미 있어 건너뜀 ${alreadyDone}개(비용 0)` : ""}` +
      `${skipped ? `, 목소리 미배정 스킵 ${skipped}개` : ""}` +
      (fails.length ? `, 실패 ${fails.length}개` : "") +
      (missingLang ? `, ${workingLang} 번역 없는 ${missingLang}줄은 건너뜀` : "")
  );
  // 스킵된 줄이 있으면 '어느 줄인지' 까지 남긴다 — 성공한 잡에서도 빠진 줄을 찾을 수 있게.
  if (skipped > 0) await log(`⚠ 목소리 없어 못 만든 ${skipped}줄: ${[...skippedWho].slice(0, 5).join(" / ")}`);
  return ok;
}

// ── splitcut(M3+): 이후 단계에서도 컷 하나를 분할 → 서브컷 추출+글씨읽기까지 →
//    바로 M3 재생성 준비. source 단계는 approved 유지, regen 단계로 진행 표시.
export async function runSplitCut(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[splitcut]", m);
    await logProgress(projectId, m);
  };
  const sceneId = payload?.sceneId;
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  if (!p.virtualCanvas) throw new Error("가상 캔버스가 없어요");
  const canvas = p.virtualCanvas;
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  const target = scenes.find((s) => s.id === sceneId);
  if (!target) throw new Error("분할할 컷을 찾을 수 없어요");

  const cfg = loadSplitConfig();
  const files = sortedFiles(p);
  await log(`소스 ${files.length}개 다운로드…`);
  const buffers = [];
  for (const f of files) buffers.push(await download(f.url));

  // 프로파일 → 대상 구간 재검출 + VLM 강제 분할 + 평탄행 폴백(runResplit 과 동일 로직).
  const global = new Float32Array(canvas.totalHeight);
  let acc = 0;
  for (const buf of buffers) {
    const { profile } = await computeRowProfile(buf, canvas.refWidth);
    const room = global.length - acc;
    if (room <= 0) break;
    global.set(room >= profile.length ? profile : profile.subarray(0, room), acc);
    acc += profile.length;
  }
  const y0 = Math.round(target.sourceRegion.yStart);
  const y1 = Math.round(target.sourceRegion.yEnd);
  const cfg2 = {
    ...cfg,
    minGapPx: Math.max(12, Math.round((cfg.minGapPx ?? 40) / 2)),
    minSceneHeightPx: Math.max(30, Math.round((cfg.minSceneHeightPx ?? 60) / 2)),
  };
  let subs = detectRegions(global.subarray(y0, y1), cfg2).map((r) => ({
    yStart: y0 + r.yStart,
    yEnd: y0 + r.yEnd,
  }));
  if (subs.length === 0) subs = [{ yStart: y0, yEnd: y1 }];
  const key = process.env.OPENAI_API_KEY;
  const VLM_MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o";
  if (key) {
    const out = [];
    for (const s of subs) {
      try {
        out.push(...(await forceSplit(canvas, buffers, s, key, VLM_MODEL, log)));
      } catch {
        out.push(s);
      }
    }
    subs = out;
  }
  if (subs.length === 1 && subs[0].yEnd - subs[0].yStart >= 120) {
    const s = subs[0];
    const lo = s.yStart + Math.round((s.yEnd - s.yStart) * 0.3);
    const hi = s.yStart + Math.round((s.yEnd - s.yStart) * 0.7);
    let bestY = -1;
    let bestStd = Infinity;
    for (let y = lo; y < hi; y++) {
      if (global[y] < bestStd) {
        bestStd = global[y];
        bestY = y;
      }
    }
    if (bestY > s.yStart + 20 && bestY < s.yEnd - 20) {
      subs = [
        { yStart: s.yStart, yEnd: bestY },
        { yStart: bestY, yEnd: s.yEnd },
      ];
    }
  }
  await log(`분할 ${subs.length}개 — 추출·글씨읽기…`);

  // 트림 + 추출 + OCR + 분류 → 새 서브컷(originalImage 까지) 만든다.
  const x0 = target.sourceRegion.xStart ?? 0;
  const x1 = target.sourceRegion.xEnd ?? canvas.refWidth;
  const trimmed = [];
  for (const s of subs) {
    let box = { yStart: s.yStart, yEnd: s.yEnd, xStart: x0, xEnd: x1 };
    try {
      const png = await extractRegion(canvas, buffers, s.yStart, s.yEnd, x0, x1);
      const t = await trimBox(png);
      const ny0 = s.yStart + t.top;
      const ny1 = s.yStart + t.bottom;
      const nx0 = x0 + t.left;
      const nx1 = x0 + t.right;
      if (ny1 - ny0 >= 40 && nx1 - nx0 >= 40) box = { yStart: ny0, yEnd: ny1, xStart: nx0, xEnd: nx1 };
    } catch {}
    trimmed.push(box);
  }
  let cuts = trimmed.map(() => null);
  if (key) {
    try {
      cuts = await classifyScenes(canvas, buffers, trimmed, key, VLM_MODEL, log, projectId);
    } catch {}
  }
  const newScenes = [];
  for (let k = 0; k < trimmed.length; k++) {
    const box = trimmed[k];
    const png = await extractRegion(canvas, buffers, box.yStart, box.yEnd, box.xStart, box.xEnd);
    const { url } = await put(`project/${projectId}/cut-split-${Date.now()}-${k}.png`, png, {
      access: "public",
      contentType: "image/png",
      addRandomSuffix: false,
    });
    const cut = cuts[k] ?? { type: null, dialogue: "", sfx: "" };
    if (key) {
      try {
        const ocr = await readCutTextTiled(png, key, VLM_MODEL);
        cut.bubbles = mergeBubbleSpeakers(ocr.bubbles, cut.bubbles, cut.speakerId);
        cut.dialogue = ocr.dialogue;
        if (ocr.sfx) cut.sfx = ocr.sfx;
        cut.textBoxes = ocr.boxes;
      } catch {}
    }
    newScenes.push({
      id: randomUUID(),
      order: 0,
      sourceRegion: box,
      cut,
      originalImage: url,
      status: "approved",
    });
  }

  const p2 = await getProject(projectId);
  if (!p2) throw new Error("프로젝트가 사라졌어요");
  const kept = (p2.scenes ?? []).filter((s) => s.id !== target.id);
  const merged = [...kept, ...newScenes].sort(
    (a, b) => a.sourceRegion.yStart - b.sourceRegion.yStart
  );
  p2.scenes = absorbTextCuts(merged).map((s, i) => ({ ...s, order: i }));
  p2.steps.regen = {
    ...p2.steps.regen,
    kind: "regen",
    status: "review",
    error: undefined,
    updatedAt: Date.now(),
  };
  await saveProject(p2);
  await log(`분할 완료: ${target.order + 1}번 → ${newScenes.length}개`);
  return newScenes.length;
}

// ── mergecut(M3+): 컷을 앞/뒤 이웃과 합병 → 합친 영역 추출+글씨읽기 → M3 재생성 준비.
export async function runMergeCut(projectId, payload) {
  await resetProgress(projectId);
  const log = async (m) => {
    console.error("[mergecut]", m);
    await logProgress(projectId, m);
  };
  const sceneId = payload?.sceneId;
  const dir = payload?.dir === "prev" ? -1 : 1;
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  if (!p.virtualCanvas) throw new Error("가상 캔버스가 없어요");
  const canvas = p.virtualCanvas;
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order);
  const idx = scenes.findIndex((s) => s.id === sceneId);
  if (idx < 0) throw new Error("합병할 컷을 찾을 수 없어요");
  const j = idx + dir;
  if (j < 0 || j >= scenes.length) throw new Error("합칠 이웃 컷이 없어요");
  const a = scenes[idx];
  const b = scenes[j];

  const region = {
    yStart: Math.min(a.sourceRegion.yStart, b.sourceRegion.yStart),
    yEnd: Math.max(a.sourceRegion.yEnd, b.sourceRegion.yEnd),
    xStart: Math.min(a.sourceRegion.xStart ?? 0, b.sourceRegion.xStart ?? 0),
    xEnd: Math.max(a.sourceRegion.xEnd ?? canvas.refWidth, b.sourceRegion.xEnd ?? canvas.refWidth),
  };

  const files = sortedFiles(p);
  await log(`소스 ${files.length}개 다운로드…`);
  const buffers = [];
  for (const f of files) buffers.push(await download(f.url));

  await log("합친 영역 추출·글씨읽기…");
  const png = await extractRegion(canvas, buffers, region.yStart, region.yEnd, region.xStart, region.xEnd);
  const { url } = await put(`project/${projectId}/cut-merge-${Date.now()}.png`, png, {
    access: "public",
    contentType: "image/png",
    addRandomSuffix: false,
  });
  const key = process.env.OPENAI_API_KEY;
  const VLM_MODEL = process.env.OPENAI_VLM_MODEL || "gpt-4o";
  const cut = { type: a.cut?.type ?? b.cut?.type ?? null, dialogue: "", sfx: "", textBoxes: [] };
  // 대사: 합친 이미지 OCR + 두 컷의 기존 대사(흡수 나레이션 포함) 합쳐 중복 줄 제거.
  let ocr = null;
  if (key) {
    try {
      ocr = await readCutTextTiled(png, key, VLM_MODEL);
    } catch (e) {
      await log(`글씨읽기 실패: ${String(e?.message ?? e).slice(0, 100)}`);
    }
  }
  const lines = [ocr?.dialogue, a.cut?.dialogue, b.cut?.dialogue]
    .flatMap((t) => String(t || "").split("\n"))
    .map((x) => x.trim())
    .filter(Boolean);
  cut.dialogue = [...new Set(lines)].join("\n");
  cut.sfx = ocr?.sfx || a.cut?.sfx || b.cut?.sfx || "";
  cut.textBoxes = ocr?.boxes ?? [];
  // 풍선별 화자: 합친 이미지 OCR 풍선에, 두 원본 컷의 풍선 화자를 글자 매칭으로 보존.
  cut.bubbles = mergeBubbleSpeakers(
    ocr?.bubbles ?? [],
    [...(a.cut?.bubbles ?? []), ...(b.cut?.bubbles ?? [])],
    a.cut?.speakerId ?? b.cut?.speakerId
  );

  const merged = {
    id: randomUUID(),
    order: 0,
    sourceRegion: region,
    cut,
    originalImage: url,
    status: "approved",
  };

  const p2 = await getProject(projectId);
  if (!p2) throw new Error("프로젝트가 사라졌어요");
  const kept = (p2.scenes ?? []).filter((s) => s.id !== a.id && s.id !== b.id);
  p2.scenes = [...kept, merged]
    .sort((x, y) => x.sourceRegion.yStart - y.sourceRegion.yStart)
    .map((s, i) => ({ ...s, order: i }));
  p2.steps.regen = {
    ...p2.steps.regen,
    kind: "regen",
    status: "review",
    error: undefined,
    updatedAt: Date.now(),
  };
  await saveProject(p2);
  await log("합병 완료");
  return 1;
}
