// ============================================================================
// 합성(5단계) — ★aninews 검증 per-scene 방식 그대로.★ 씬마다: 영상 + 더빙 오디오 + 자막(시간
// 구간 순차 번인) 을 한 번에 인코딩 → 이어붙이기. 오디오가 영상보다 길면 영상을 슬로모션(setpts)
// 으로 늘림(루프 X). aninews 와 다른 점은 최소화(pad 레터박스, 씬당 오디오 유닛 여러 개 concat).
// ============================================================================

import { getProject, saveProject, logProgress, resetProgress, recordCost } from "./store.mjs";
import { buildAss, assFilterPath } from "./ass.mjs";
import { put } from "@vercel/blob";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { renderCaptionBox, renderIntertitleFrame, ensureSubtitleFontPath } from "./subtitle-render.mjs";
import { stripMarks } from "./emphasis.mjs";

let FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
let FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
let ffResolved = false;
async function resolveFf() {
  if (ffResolved) return;
  ffResolved = true;
  try {
    const ff = (await import("ffmpeg-static")).default;
    const fp = (await import("ffprobe-static")).default;
    if (!process.env.FFMPEG_PATH && ff) FFMPEG = ff;
    if (!process.env.FFPROBE_PATH && fp?.path) FFPROBE = fp.path;
  } catch {
    /* PATH 폴백 */
  }
}

const FADE = Number(process.env.COMPOSE_FADE_SEC || 0.5);
const FPS = Number(process.env.COMPOSE_FPS || 24);

function run(cmd, args, timeoutMs = 600_000) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args);
    let err = "";
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
      rej(new Error(`${cmd} 타임아웃(${Math.round(timeoutMs / 1000)}초) — ffmpeg 마지막: ${err.slice(-400)}`));
    }, timeoutMs);
    // ★stderr 를 무한정 쌓으면(자막 많은 씬은 프레임마다 경고 폭증) Node 메모리가 터진다(OOM).
    //   마지막 부분만 보관 — 에러 진단엔 충분.
    p.stderr.on("data", (d) => {
      err += d;
      if (err.length > 16000) err = err.slice(-16000);
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    p.on("close", (c) => {
      clearTimeout(timer);
      c === 0 ? res() : rej(new Error(`${cmd} exit ${c}: ${err.slice(-500)}`));
    });
  });
}

function probeDuration(file) {
  return new Promise((res) => {
    const p = spawn(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => res(parseFloat(out.trim()) || 0));
    p.on("error", () => res(0));
  });
}

// 스트리밍 저장 — 파일 전체를 메모리에 안 올린다(OOM 방지).
async function download(url, dest) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`다운로드 실패 ${r.status}`);
  if (r.body) await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
  else await writeFile(dest, Buffer.from(await r.arrayBuffer()));
}
function targetDims(project) {
  const ar = project?.aspectRatio;
  if (ar === "9:16") return [720, 1280];
  if (ar === "1:1") return [1024, 1024];
  return [1280, 720];
}

const FADES_OUT = new Set(["fadeout", "black", "dissolve"]);
const FADES_IN = new Set(["fadein", "black", "dissolve"]);

// ★내레이션은 화자=내레이터인 말풍선일 뿐. 레거시 cut.narration 문자열을 말풍선으로 흡수해
//   합성이 bubbles 한 경로로만 자막·오디오를 만들게 한다(별도 내레이션 분기 제거).
function normalizeNarration(cut) {
  if (!cut) return;
  const nar = (cut.narration || "").trim();
  if (!nar) return;
  cut.bubbles = cut.bubbles ?? [];
  const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
  if (!cut.bubbles.some((b) => b.speakerId == null && norm(b.text) === norm(nar))) {
    cut.bubbles.push({ text: nar, speakerId: cut.narrationSpeakerId ?? null, ...(cut.narrationAudioUrl ? { audioUrl: cut.narrationAudioUrl } : {}) });
  }
  cut.narration = "";
}

// 이 컷의 '오디오 유닛'(재생 순서) — 말풍선(대사·내레이션·효과음) audioUrl + 그 자막 텍스트.
// sx/sy = 이 줄의 자막 위치(0~1 중심). 화자가 번갈아 말하면 줄마다 다르게 지정됨.
// ★export = 테스트용(scripts/test-language-tracks.mjs). 이 함수의 언어 규칙이 몇 번이나
//   되돌아가 "일본어판인데 중국어 소리" 를 냈다 → 규칙을 테스트로 못박는다.
export function audioUnits(cut, workingLang) {
  normalizeNarration(cut);
  const units = [];
  for (const b of cut?.bubbles ?? []) {
    // ★작업 언어(§10): 그 언어 트랙의 오디오·텍스트 우선(원문 대신). 효과음은 언어 무관.
    const isSfx = b.speakerId === "__sfx__";
    const tr = workingLang && !isSfx ? b.tracks?.[workingLang] : null;
    // ★★소리와 자막은 '같은 줄에서 반드시 같은 언어'여야 한다.
    //   예전엔 자막은 번역문(tr.text), 소리는 원문 오디오(b.audioUrl)로 갈려서 — 번역만 채우고
    //   재더빙을 안 한 줄에서 자막 일본어 + 소리 중국어가 됐다(사용자: 더빙·자막 언어 에러).
    //   → 번역 오디오가 있으면 번역 자막을, 없으면(원문 오디오를 쓰므로) 원문 자막을 쓴다.
    const useTrack = !!tr?.audioUrl;
    // ★★언어판(workingLang 지정)에서는 원어 오디오·원문 자막으로 폴백하지 않는다.
    //   예전에는 그 언어 음성이 없으면 원문(중국어) 음성과 원문 자막을 대신 넣었다 —
    //   그래서 "일본어판인데 대사 더빙도 영상 자막도 중국어" 가 나왔다(사용자 반복 보고).
    //   번역은 있는데 음성만 없는 줄: 그 언어 자막을 유지하고 소리는 '무음' 으로 둔다
    //   (중국어 소리를 섞느니 그 줄만 조용한 게 낫다 — 더빙을 다시 돌리면 채워진다).
    if (workingLang && !isSfx && !useTrack) {
      const t2 = (tr?.text || "").trim();
      if (t2 && !b.noSubtitle)
        units.push({ audioUrl: null, silent: true, subText: t2, sx: b.subtitleX, sy: b.subtitleY });
      continue; // 번역조차 없으면 그 줄은 이 언어판에 넣지 않는다(원문 유출 금지)
    }
    const audioUrl = useTrack ? tr.audioUrl : b.audioUrl;
    const pairedText = useTrack ? (tr.text || b.text || "") : (b.text || "");
    if (audioUrl)
      units.push({
        audioUrl,
        subText: isSfx || b.noSubtitle ? "" : pairedText.trim(), // 효과음·자막제외 줄은 캡션 없음(소리만)
        sx: b.subtitleX,
        sy: b.subtitleY,
        vol: b.volume,
        far: b.distant,
      });
  }
  return units;
}

// 이 오디오 유닛에 적용할 ffmpeg 오디오 필터 문자열(없으면 ""). 볼륨 배수 + 거리감(멀리서).
//   far=멀리서: 로우패스로 먹먹하게 + 약한 반향(aecho) + 감쇠. vol 과 합쳐 최종 게인 계산.
function audioFx(au) {
  const vol = typeof au.vol === "number" && au.vol > 0 ? au.vol : 1;
  const far = !!au.far;
  const parts = [];
  if (far) parts.push("lowpass=f=2200", "aecho=0.8:0.5:55:0.3");
  const gain = far ? vol * 0.55 : vol;
  if (far || Math.abs(gain - 1) > 0.02) parts.push(`volume=${gain.toFixed(2)}`);
  return parts.join(",");
}

// 더빙 없는 컷의 자막 유닛(영상 길이에 비례 배치용) — { text, sx, sy }.
function subtitleUnits(cut, workingLang) {
  normalizeNarration(cut);
  const units = [];
  if (cut?.bubbles?.length) {
    for (const b of cut.bubbles) {
      if (b.speakerId === "__sfx__" || b.noSubtitle) continue; // 효과음·자막제외 줄은 캡션 안 함
      const tr = workingLang ? b.tracks?.[workingLang] : null; // 작업 언어(§10) 번역 우선
      const t = ((tr?.text || b.text) || "").trim();
      if (t) units.push({ text: t, sx: b.subtitleX, sy: b.subtitleY });
    }
  } else if (cut?.dialogue?.trim()) {
    units.push({ text: cut.dialogue.trim() });
  }
  return units;
}

// 자막 세로중심 y — 수동(top/middle/bottom)만, auto 는 고정 밴드(하단 3/4).
// ★compose 루프 안에서 생성 이미지를 다운로드·디코딩(sharp)하면, 그 네이티브 메모리가
//   바로 뒤따르는 ffmpeg 인코딩과 겹쳐 512MB 워커가 OOM 으로 죽는다. aninews 는 compose 에서
//   이미지를 아예 안 건드려서(위치 고정) 안 죽는다 — 그 방식에 맞춘다. 얼굴회피 자동배치는
//   생성 단계에서 미리 계산해 cut.subtitlePos 로 저장하는 게 맞다(메모리 안전한 지점).
function subtitleCenterY(cut, H) {
  const y = cut?.subtitleY; // 컷별 수동 미세조정(0~1 중심 비율) — 있으면 최우선
  if (typeof y === "number" && isFinite(y)) return Math.round(H * Math.max(0.05, Math.min(0.95, y)));
  const pos = cut?.subtitlePos; // 레거시 프리셋
  if (pos === "top") return Math.round(H * 0.15);
  if (pos === "middle") return Math.round(H * 0.5);
  if (pos === "bottom") return Math.round(H * 0.85);
  return Math.round(H * 0.72); // 기본: 하단 3/4(바닥엔 안 붙임) — aninews 검증 위치
}
// 자막 가로 중심 x — 컷별 9분할 수동(subtitleX). 없으면 중앙.
function subtitleCenterX(cut, W) {
  const x = cut?.subtitleX;
  if (typeof x === "number" && isFinite(x)) return Math.round(W * Math.max(0.05, Math.min(0.95, x)));
  return Math.round(W * 0.5);
}

export async function runCompose(projectId, payload) {
  await resetProgress(projectId);
  await resolveFf();
  // ★섹션 부분 합성(방향 B) — payload.sceneIds 면 그 컷들만, payload.sectionKey 면 결과를
  //   sectionVideos[key] 로 저장(전체 composedUrl 안 건드림). 한 잡=섹션치 → 임시폴더 디스크 고정.
  const onlyIds = Array.isArray(payload?.sceneIds) && payload.sceneIds.length ? new Set(payload.sceneIds) : null;
  const sectionKey = payload?.sectionKey != null ? String(payload.sectionKey) : null;
  const log = async (m) => {
    console.error("[compose]", m);
    await logProgress(projectId, m);
  };

  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  // ★★언어별 출력(스펙 §10) — payload.lang 이 오면 그 언어로 합성한다(작업 언어 무시).
  //   같은 비주얼 트랙에 언어별 오디오·자막만 갈아 끼워 ep01_ja.mp4 / ep01_en.mp4 를 따로 만든다.
  //   비주얼(영상·카메라워크)은 언어 무관 공유 자산이라 재생성 비용이 0 — 스펙이 말한 비용 이점.
  //   payload.lang 없으면 기존대로 project.workingLanguage 사용(회귀 0).
  const outLang = payload?.lang != null ? String(payload.lang).trim() : null;
  // ★언어를 안 넘겼고 작업 언어도 안 정해져 있으면 '대상 언어(🌐)의 첫 번째' 로 합성한다.
  //   예전엔 그대로 원어(중국어)로 합성해서, 일본어 더빙을 다 해놓고 합성하면
  //   "중국어 자막 + 중국어 음성" 파일이 나왔다(사용자 반복 보고).
  //   앱 배포가 늦어도 워커가 스스로 맞추도록 여기(워커)에 둔다. 원어판은 lang="" 을 명시.
  const workingLang = (outLang ?? p.workingLanguage ?? "").trim() || (outLang === "" ? "" : (p.targetLanguages ?? [])[0] || "");
  // ★★언어판을 요청했는데 그 언어 번역이 하나도 없으면 '전부 원문' 인 파일이 만들어진다 —
  //   사용자는 일본어판인 줄 알고 받는데 자막·소리가 중국어다(실제 보고). 조용한 폴백을 막는다.
  // ★게이트는 '실제 출력 언어(workingLang)' 기준 — 예전엔 명시 lang(outLang)일 때만 검사해서,
  //   lang 없이 오는 섹션 합성이 targetLanguages[0] 기본값으로 언어판을 만들면서 게이트를
  //   우회했다. 그 언어 번역이 없으면 대사 줄이 자막도 소리도 없이 통째로 빠진 영상이
  //   sectionVideos 에 조용히 저장됐다(사전 검출). 언어판이면 경로 불문 검사한다.
  if (workingLang) {
    const has = (p.scenes ?? []).some((sc) =>
      (sc.cut?.bubbles ?? []).some((b) => b.speakerId !== "__sfx__" && (b.tracks?.[workingLang]?.text || "").trim())
    );
    if (!has)
      throw new Error(
        `${workingLang} 번역이 아직 없어요 — '더빙 일괄(${workingLang})' 을 누르면 번역·더빙이 한 번에 됩니다`
      );
    const hasAudio = (p.scenes ?? []).some((sc) =>
      (sc.cut?.bubbles ?? []).some((b) => (b.tracks?.[workingLang]?.audioUrl || "").trim())
    );
    // ★예전엔 여기서 "소리는 원문으로 나갑니다" 라고 경고만 하고 중국어 음성을 실어 보냈다.
    //   이제 원어 폴백이 없으므로, 그 언어 음성이 하나도 없으면 무음 영상이 나온다 —
    //   그런 걸 납품물로 만들어 주지 않는다. 무엇이 없는지 말하고 멈춘다.
    if (!hasAudio)
      throw new Error(
        `${workingLang} 더빙 음성이 하나도 없습니다 — 지금 합성하면 소리 없는 영상이 됩니다. ` +
          `'더빙 일괄' 을 먼저 돌려주세요(원어 음성은 언어판에 넣지 않습니다).`
      );
  }
  // 자막 씬(무성영화 카드, text 컷)은 영상 없이도 합성 대상 — 검은 배경+카드로 직접 렌더.
  const isCardScene = (s) => !s.videoUrl && s.cut?.type === "text" && subtitleUnits(s.cut, workingLang).length > 0;
  const scenes = (p.scenes ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .filter((s) => s.videoUrl || isCardScene(s))
    .filter((s) => !onlyIds || onlyIds.has(s.id)); // 섹션 부분 합성이면 그 섹션 컷만
  if (scenes.length === 0) throw new Error(sectionKey ? "이 섹션에 묶을 영상이 없어요" : "묶을 영상이 없어요(먼저 동영상 생성)");

  const [W, H] = targetDims(p);
  const dir = await mkdtemp(join(tmpdir(), "recompose-"));
  try {
    const sceneFiles = [];
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      const isCard = isCardScene(s); // 무성영화 자막 씬 — 영상 없음, 카드로 렌더
      let vPath = null;
      let vd = 0;
      if (!isCard) {
        await log(`씬 ${i + 1}/${scenes.length}: 다운로드…`);
        vPath = join(dir, `v${i}.mp4`);
        // 후처리본(fxUrl — 줌 커브 구운 클립)이 있으면 그걸 사용: 미리보기 = 최종 픽셀.
        await download(s.fxUrl || s.videoUrl, vPath);
        vd = (await probeDuration(vPath)) || 3;
      }

      // 더빙 오디오 유닛 다운로드 + 자막 시간구간(유닛 실제 길이 기준)
      const aPaths = [];
      const caps = []; // { text, start, end }
      let acc = 0;
      for (const au of audioUnits(s.cut, workingLang)) {
        // ★음성이 없는 줄(그 언어 더빙 미완) — 원어 소리를 섞지 않고 그 길이만큼 무음을 넣는다.
        //   자막은 그대로 나가고 타이밍도 유지된다. 픽셀 연산 없음(오디오 전용, OOM 무관).
        if (au.silent) {
          const chars = String(au.subText || "").replace(/\s/g, "").length;
          const sd = Math.max(1.2, Math.min(8, chars * 0.14));
          const sp2 = join(dir, `sil${i}_${aPaths.length}.m4a`);
          try {
            await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
              "-t", sd.toFixed(2), "-c:a", "aac", "-b:a", "64k", sp2]);
            aPaths.push(sp2);
            const start = acc;
            acc += sd;
            if (au.subText) caps.push({ text: au.subText, start, end: acc, sx: au.sx, sy: au.sy });
          } catch {}
          continue;
        }
        const ext = au.audioUrl.includes(".wav") ? "wav" : "mp3";
        const ap = join(dir, `a${i}_${aPaths.length}.${ext}`);
        try {
          await download(au.audioUrl, ap);
          // 볼륨·거리감 필터 — 필요할 때만 재인코딩(m4a). 실패해도 원본으로 진행.
          let usePath = ap;
          const af = audioFx(au);
          if (af) {
            const fp = join(dir, `af${i}_${aPaths.length}.m4a`);
            try {
              await run(FFMPEG, ["-y", "-i", ap, "-af", af, "-c:a", "aac", "-b:a", "128k", fp]);
              usePath = fp;
            } catch {}
          }
          const ad = (await probeDuration(usePath)) || 0.8;
          aPaths.push(usePath);
          const start = acc;
          acc += ad;
          if (au.subText) caps.push({ text: au.subText, start, end: acc, sx: au.sx, sy: au.sy });
        } catch {}
      }
      let audioLen = acc;

      // ★효과음(오디오 제안·검출 sfx) 경로 수집 — 대사와 '같은 ffmpeg 패스'에서 겹쳐 넣는다.
      //   ★★별도 믹싱 패스를 추가했다가 compose(OOM 경계 경로)에서 워커가 터졌다 → ffmpeg
      //   호출 수를 늘리지 않는다. 오디오 전용 필터라 픽셀 연산도 없다. 컷당 2개까지만.
      const sfxPaths = []; // { path, timing }
      if (!isCard) {
        // ★오디오 제안 중 '목소리로 읽은 것' 은 언어가 맞을 때만 섞는다.
        //   예전에는 vocal_reaction("gasp of shock" 같은 영어 서술)을 TTS 로 읽혀 저장했고,
        //   그게 언어와 무관하게 최종 영상에 섞였다 → 일본어판에서 영어·원어 음성이 튀어나온다.
        //   효과음(sfx)과 '효과음으로 만든 발성'(gen==="sfx")은 언어 무관이라 그대로 사용.
        const sugOk = (g) =>
          g.type === "sfx" || g.gen === "sfx" || (g.lang ?? "") === workingLang;
        const cand = [
          ...(s.cut?.audioSuggestions ?? []).filter((g) => g && g.enabled !== false && g.audioUrl && sugOk(g)).map((g) => ({ url: g.audioUrl, timing: g.timing })),
          ...((s.cut?.sfxAudioUrl || "").trim() ? [{ url: s.cut.sfxAudioUrl, timing: "start" }] : []),
        ].slice(0, 2);
        for (const it of cand) {
          const sp = join(dir, `sx${i}_${sfxPaths.length}.${String(it.url).includes(".wav") ? "wav" : "mp3"}`);
          try {
            await download(it.url, sp);
            sfxPaths.push({ path: sp, timing: it.timing || "start" });
          } catch {}
        }
      }

      // 오디오 유닛 → 하나로 합침. 대사 concat + 효과음 겹치기를 '한 번의' ffmpeg 로 처리한다.
      //   효과음이 없으면 예전과 완전히 동일(1개면 그대로, 여러 개면 concat 1패스, 없으면 무음).
      let aPath = null;
      if (aPaths.length === 1 && !sfxPaths.length) {
        aPath = aPaths[0]; // 그대로 — ffmpeg 호출 0
      } else if (aPaths.length + sfxPaths.length > 0 && (aPaths.length > 1 || sfxPaths.length > 0)) {
        aPath = join(dir, `sa${i}.m4a`);
        const cc = ["-y"];
        for (const ap of aPaths) cc.push("-i", ap);
        for (const sx of sfxPaths) cc.push("-i", sx.path);
        const chains = [];
        const mixLabels = [];
        if (aPaths.length === 1) {
          mixLabels.push("[0:a]");
        } else if (aPaths.length > 1) {
          chains.push(`${aPaths.map((_, j) => `[${j}:a]`).join("")}concat=n=${aPaths.length}:v=0:a=1[dlg]`);
          mixLabels.push("[dlg]");
        }
        // 효과음은 대사 길이(audioLen) 기준 timing 으로 지연 후 겹침. 대사가 없으면 클립 길이 기준.
        const refLen = audioLen > 0 ? audioLen : vd || 3;
        sfxPaths.forEach((sx, k) => {
          const at = sx.timing === "end" ? Math.max(0, refLen - 0.4) : sx.timing === "mid" ? refLen / 2 : 0;
          const ms = Math.round(at * 1000);
          chains.push(`[${aPaths.length + k}:a]adelay=${ms}:all=1,volume=0.8[x${k}]`);
          mixLabels.push(`[x${k}]`);
        });
        let outLabel = mixLabels[0];
        if (mixLabels.length > 1) {
          chains.push(`${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0,volume=1.3[mx]`);
          outLabel = "[mx]";
        }
        cc.push("-filter_complex", chains.join(";"), "-map", outLabel, "-c:a", "aac", "-b:a", "128k", aPath);
        try {
          await run(FFMPEG, cc);
        } catch (e) {
          // 실패하면 대사만이라도 살린다(효과음 포기) — 합성이 깨지지 않게.
          await log(`씬 ${i + 1} 오디오 합치기 실패(효과음 제외 재시도): ${String(e?.message ?? e).slice(0, 80)}`);
          aPath = aPaths.length === 1 ? aPaths[0] : null;
          if (aPaths.length > 1) {
            const cc2 = ["-y"];
            for (const ap of aPaths) cc2.push("-i", ap);
            cc2.push("-filter_complex", `${aPaths.map((_, j) => `[${j}:a]`).join("")}concat=n=${aPaths.length}:v=0:a=1[a]`, "-map", "[a]", "-c:a", "aac", "-b:a", "128k", join(dir, `sa2_${i}.m4a`));
            try { await run(FFMPEG, cc2); aPath = join(dir, `sa2_${i}.m4a`); } catch { aPath = null; }
          }
        }
      }

      // 더빙 없으면 자막을 영상 길이에 글자수 비례로 순차. (카드 씬은 글자수 기반 길이)
      if (!aPaths.length) {
        const subs = subtitleUnits(s.cut, workingLang);
        if (subs.length) {
          const textLen = subs.reduce((n, u) => n + stripMarks(u.text).replace(/\s/g, "").length, 0);
          const baseDur = isCard
            ? Math.max(2.5, Math.min(10, Number(s.cut?.durationSec) || textLen * 0.14))
            : vd;
          const weights = subs.map((u) => Math.max(1, stripMarks(u.text).replace(/\s/g, "").length));
          const wSum = weights.reduce((a, b) => a + b, 0) || 1;
          let a2 = 0;
          subs.forEach((u, j) => {
            const d = Math.max(1.2, (baseDur * weights[j]) / wSum);
            caps.push({ text: u.text, start: a2, end: a2 + d, sx: u.sx, sy: u.sy });
            a2 += d;
          });
        }
      }

      const capTotal = caps.length ? caps[caps.length - 1].end : 0;
      const finalDur = Math.max(audioLen, capTotal) || (isCard ? 2.5 : vd);
      if (caps.length) caps[caps.length - 1].end = finalDur + 0.5; // 마지막 자막 끝까지
      // ★★길이 부족 보정(스펙 §5) — 예전엔 오디오가 길면 '전 티어'를 슬로모션했다.
      //   스펙: "idle/emote 는 0.6-0.8배 슬로우 허용, ★talk 는 슬로우 금지, 루프는 전 티어 금지.
      //          final > 클립이면 마지막 프레임 홀드 + 카메라워크 지속."
      //   talk 를 늘리면 입 움직임이 대사와 어긋나 어색해진다 → talk/action 은 슬로우 없이
      //   '마지막 프레임 홀드'(tpad)로 채운다. idle/emote 만 0.8배까지 슬로우하고 남는 건 홀드.
      const tier = s.cut?.motionTier;
      const slowAllowed = tier === "idle" || tier === "emote"; // 스펙 §5
      const MAX_SLOW = 1 / 0.8; // 0.8배 슬로우 = 1.25배 길이까지만
      let speed = 1;
      let holdSec = 0;
      if (vd > 0 && finalDur > vd) {
        const need = finalDur / vd;
        speed = slowAllowed ? Math.min(need, MAX_SLOW) : 1;
        holdSec = Math.max(0, finalDur - vd * speed); // 슬로우로 못 채운 나머지는 마지막 프레임 홀드
      }

      // 자막 캡션 PNG(캔버스 재사용). 위치는 자막 있을 때만 계산.
      // 위치 해석: 대사(말풍선)별 지정 > 컷 기본 > 디폴트. 카드 씬 기본은 정중앙(무성영화).
      const cyDef =
        isCard && !s.cut?.subtitlePos && s.cut?.subtitleY == null
          ? Math.round(H * 0.5)
          : subtitleCenterY(s.cut, H);
      const cxDef = subtitleCenterX(s.cut, W);
      const frac = (v) => (typeof v === "number" && isFinite(v) ? Math.max(0.05, Math.min(0.95, v)) : null);
      // ★★자막을 ASS 로 굽는다(스펙 §7). PNG 오버레이는 캡션마다 sharp/canvas 로 이미지를
      //   만들어 compose(OOM 경계 경로)에 네이티브 이미지 메모리를 얹었다 — 반복된 OOM 의 알려진
      //   원인. ASS 는 텍스트 파일 하나라 이미지 메모리 0, ffmpeg 입력도 늘지 않는다.
      //   AI 가 정한 줄별 자막 위치(bubble.subtitleY — 연출기가 '얼굴·입 안 가리는 위치'로 결정)는
      //   caps[].sy 로 그대로 전달돼 ASS \pos 로 반영된다. 없으면 스펙 기본(하단 93%).
      //   ASS_DISABLE=1 이면 옛 PNG 경로로 되돌릴 수 있다(폰트 문제 등 비상용).
      // ★ASS 는 기본 OFF(opt-in: ASS_ENABLE=1) —
      //   스펙 §7 이 ASS 를 지정했고 구현·검증했지만, libass 가 우리 자막 폰트(Noto Sans KR
      //   가변폰트)를 패밀리명으로 못 찾아 실측에서 '자막이 아예 안 그려졌다'(검정 배경 밝은
      //   픽셀 4개). PNG 경로는 같은 폰트를 직접 등록해 잘 그린다.
      //   자막이 사라지는 회귀를 만들 수 없으므로 기본은 PNG, ASS 는 env 로 켠다.
      //   (남은 일: 고정 굵기 TTF 를 번들해 fontsdir 로 물리면 ASS 를 기본으로 승격 가능.)
      const useAss = (process.env.ASS_ENABLE ?? "0") === "1";
      let assPath = null;
      // ★한글 폰트 파일을 못 구하면 ASS 는 빈 화면이 된다(libass 가 대체 폰트를 못 찾음).
      //   그 경우 조용히 PNG 경로로 되돌린다 — 자막이 사라지는 것보다 낫다.
      const assFontPath = useAss && caps.length ? await ensureSubtitleFontPath().catch(() => null) : null;
      const capPaths = [];
      if (useAss && caps.length && assFontPath) {
        try {
          const ass = buildAss(caps, {
            W,
            H,
            defaultYFrac: cyDef / H, // 컷 기본 자막 높이(수동 지정·카드 씬 중앙 반영)
            defaultXFrac: cxDef / W,
          });
          assPath = join(dir, `sub${i}.ass`);
          await writeFile(assPath, ass, "utf8");
        } catch (e) {
          assPath = null;
          await log(`ASS 자막 생성 실패(PNG 경로로) : ${String(e?.message ?? e).slice(0, 80)}`);
        }
      }
      if (!assPath) {
        for (const c of caps) {
          const ccy = frac(c.sy) != null ? Math.round(H * frac(c.sy)) : cyDef;
          const ccx = frac(c.sx) != null ? Math.round(W * frac(c.sx)) : cxDef;
          // 박스 크기 PNG + 프레임 내 좌표 — 전체화면 PNG 대비 ffmpeg 피크 실측 ~100MB↓.
          const box = await renderCaptionBox(c.text, { W, H, cy: ccy, cx: ccx });
          if (box) {
            const cp = join(dir, `cap${i}_${capPaths.length}.png`);
            await writeFile(cp, box.buf);
            capPaths.push({ path: cp, span: c, x: box.x, y: box.y });
          }
        }
      }

      const fadeOut = FADES_OUT.has(s.cut?.transition);
      const fadeIn = FADES_IN.has(scenes[i - 1]?.cut?.transition) || (i === 0 && s.cut?.transition === "fadein");

      // ── ffmpeg (aninews 패턴): 입력 0=영상(카드 씬은 검정+테두리 프레임), 1=오디오, 2..=자막 PNG ──
      // -nostats/-loglevel warning: 프레임마다 진행 로그를 stderr 에 쏟지 않게(메모리 폭증 방지).
      const args = ["-hide_banner", "-nostats", "-loglevel", "warning", "-y"];
      let cardNative = false; // 카드 배경을 ffmpeg 로 직접 그렸는지(canvas 폴백)
      if (isCard) {
        const frame = await renderIntertitleFrame({ W, H });
        if (frame) {
          const fp = join(dir, `frame${i}.png`);
          await writeFile(fp, frame);
          args.push("-loop", "1", "-framerate", String(FPS), "-i", fp);
        } else {
          // ★예전엔 여기서 합성 '전체' 를 실패시켰다 — canvas 는 optionalDependency 라
          //   설치가 안 되면(플랫폼·네트워크) 무성영화 카드 씬이 하나만 있어도 최종 합성이
          //   통째로 죽었다. 카드 배경은 검정+이중 테두리뿐이라 ffmpeg 로 그대로 그릴 수 있다.
          //   → 부품 하나가 없다고 납품물 전체를 막지 않는다.
          await log("자막 씬 배경: canvas 없이 ffmpeg 로 직접 렌더(동일한 검정+테두리)");
          args.push("-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${FPS}`);
          cardNative = true;
        }
      } else {
        args.push("-i", vPath);
      }
      if (aPath) args.push("-i", aPath);
      else args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
      for (const c of capPaths) args.push("-loop", "1", "-framerate", String(FPS), "-i", c.path);
      // canvas 폴백일 때만 테두리를 ffmpeg 로 그린다(미리보기와 같은 인셋 4%/5.2%, 아이보리).
      const cardBorders = (() => {
        const bx = Math.round(W * 0.04), by = Math.round(H * 0.04);
        const ix = Math.round(W * 0.052), iy = Math.round(H * 0.052);
        return (
          `,drawbox=x=${bx}:y=${by}:w=${W - bx * 2}:h=${H - by * 2}:color=0xf4efe4@0.8:t=2` +
          `,drawbox=x=${ix}:y=${iy}:w=${W - ix * 2}:h=${H - iy * 2}:color=0xf4efe4@0.6:t=1`
        );
      })();
      let filter = isCard
        ? `[0:v]${cardNative ? `${cardBorders.slice(1)},` : ""}setsar=1,fps=${FPS}` // 프레임이 이미 W×H 정확 — 스케일·슬로모션 불필요
        : `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
          `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,setpts=${speed.toFixed(4)}*PTS,fps=${FPS}`;
      // 마지막 프레임 홀드(스펙 §5) — tpad 로 클립 끝을 늘린다. 루프가 아니라 정지 홀드.
      if (holdSec > 0.05 && !isCard) filter += `,tpad=stop_mode=clone:stop_duration=${holdSec.toFixed(2)}`;
      if (fadeIn) filter += `,fade=t=in:st=0:d=${FADE}`;
      if (fadeOut) filter += `,fade=t=out:st=${Math.max(0, finalDur - FADE).toFixed(2)}:d=${FADE}`;
      // ★whip(스펙 §2) — 씬 전환 속성. 컷 경계에서 짧고 강한 모션블러 whoosh(≈12프레임).
      //   whip 씬의 끝 0.15s 를 블러 아웃, 그 다음 씬의 시작 0.15s 를 블러 인(하드컷+블러=휩 느낌).
      const WHIP = 0.15;
      const whipR = Math.max(4, Math.round(Math.min(W, H) / 12)); // 블러 반경(px)
      const whipOut = s.cut?.transition === "whip";
      const whipIn = scenes[i - 1]?.cut?.transition === "whip";
      if (whipIn) filter += `,boxblur=luma_radius=${whipR}:luma_power=1:enable='lt(t,${WHIP})'`;
      if (whipOut) filter += `,boxblur=luma_radius=${whipR}:luma_power=1:enable='gte(t,${Math.max(0, finalDur - WHIP).toFixed(2)})'`;
      // ★ASS 자막 번인(스펙 §7) — subtitles 필터. 텍스트라 이미지 메모리 0.
      if (assPath) {
        // fontsdir = 그 폰트 파일이 있는 폴더. libass 가 시스템 폰트 없이도 한글을 그린다.
        const fdir = assFontPath ? `:fontsdir='${assFilterPath(dirname(assFontPath))}'` : "";
        filter += `,subtitles='${assFilterPath(assPath)}'${fdir}`;
      }
      filter += `[bg]`;
      let prev = "bg";
      capPaths.forEach((c, k) => {
        filter += `;[${prev}][${2 + k}:v]overlay=${c.x}:${c.y}:enable='between(t,${c.span.start.toFixed(3)},${c.span.end.toFixed(3)})'[o${k}]`;
        prev = `o${k}`;
      });
      const out = join(dir, `scene${i}.mp4`);
      args.push(
        "-filter_complex", filter,
        "-map", `[${prev}]`, "-map", "1:a",
        "-t", finalDur.toFixed(2), "-r", String(FPS),
        // -threads 2: x264 가 호스트 코어 수만큼 스레드·프레임버퍼를 잡아 피크가 커짐(실측
        // 596→404MB). 과거 문제였던 -threads 1+ultrafast 와 달리 2+veryfast 는 로컬 검증 통과.
        // ★메모리 절약(OOM 반복) — 스레드 1 + 룩어헤드/B프레임 제거로 libx264 버퍼를 줄인다.
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23",
        "-threads", "1", "-tune", "zerolatency", "-bf", "0", "-g", "48", "-max_muxing_queue_size", "256",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out
      );
      await log(`씬 ${i + 1}/${scenes.length} 인코딩(자막 ${capPaths.length}·${finalDur.toFixed(1)}s)…`);
      await run(FFMPEG, args);
      sceneFiles.push(out);
    }

    // 이어붙이기(무손실 copy — 모두 동일 코덱).
    await log("이어붙이는 중…");
    const listFile = join(dir, "list.txt");
    await writeFile(listFile, sceneFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    const finalPath = join(dir, "final.mp4");
    await run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", finalPath]);

    await log("업로드 중…");
    // 파일명에 언어 코드 — 스펙 §10(ep01_ja.mp4). 언어 미지정이면 기존 이름 유지.
    const langTag = workingLang ? `-${workingLang}` : "";
    const { url } = await put(`project/${projectId}/composed${langTag}-${Date.now()}.mp4`, createReadStream(finalPath), {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
    });

    const pp = (await getProject(projectId)) ?? p;
    if (sectionKey != null) {
      // 섹션 부분 합성 — sectionVideos[key] 에만 저장(전체 composedUrl·compose 스텝 안 건드림).
      pp.sectionVideos = { ...(pp.sectionVideos ?? {}), [sectionKey]: url };
    } else {
      pp.composedUrl = url;
      // 언어별 결과 보관 — 일본어판·영어판을 각각 유지해야 언어별 납품이 된다(§10).
      if (workingLang) pp.composedByLang = { ...(pp.composedByLang ?? {}), [workingLang]: url };
      pp.steps.compose = { ...pp.steps.compose, kind: "compose", status: "review", error: undefined, updatedAt: Date.now() };
    }
    await saveProject(pp);
    try {
      await recordCost({ projectId, vendor: "worker", model: "ffmpeg-compose", costUsd: 0, meta: { kind: sectionKey != null ? "compose-section" : "compose", clips: scenes.length } });
    } catch {}
    await log(`${sectionKey != null ? `섹션 합성 완료(컷 ${scenes.length}개)` : `합성 완료: 영상 ${scenes.length}개 → 1개`}`);
    return scenes.length;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── join(방향 B): 섹션별 합성본(sectionVideos)을 순서대로 이어붙여 최종 composedUrl. ──
//   파일 몇 개만 concat(-c copy·무손실·무인코딩)이라 가볍다 — 섹션 부분 합성이 무거운 인코딩을
//   섹션치로 이미 나눠 처리했으므로, 최종은 사실상 붙이기만. 경계 전환은 하드컷(페이드는 후속).
export async function runJoin(projectId) {
  await resetProgress(projectId);
  await resolveFf();
  const log = async (m) => {
    console.error("[join]", m);
    await logProgress(projectId, m);
  };
  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const n = (p.scenes ?? []).length;
  const raw = (p.sectionStarts ?? []).filter((s) => s > 0 && s < n);
  const starts = [...new Set([0, ...raw])].sort((a, b) => a - b);
  if (starts.length <= 1) throw new Error("섹션이 없어요 — 먼저 섹션으로 나누고 섹션별로 합성하세요");
  const vids = p.sectionVideos ?? {};
  const missing = starts.filter((st) => !vids[String(st)]);
  if (missing.length) {
    const nums = missing.map((s) => starts.indexOf(s) + 1).join(", ");
    throw new Error(`아직 합성 안 된 섹션이 있어요(섹션 ${nums}) — 그 섹션부터 합성하세요`);
  }
  const dir = await mkdtemp(join(tmpdir(), "join-"));
  try {
    const files = [];
    for (let i = 0; i < starts.length; i++) {
      await log(`섹션 ${i + 1}/${starts.length} 다운로드…`);
      const fp = join(dir, `sec-${i}.mp4`);
      await download(vids[String(starts[i])], fp);
      files.push(fp);
    }
    await log("최종 이어붙이는 중…");
    const listFile = join(dir, "list.txt");
    await writeFile(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    let finalPath = join(dir, "final.mp4");
    await run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", finalPath]);

    // ★★BGM 트랙 + 대사 구간 덕킹(스펙 §6: 오디오 3트랙, 대사·발성 구간 BGM -6dB).
    //   씬마다 얹으면 경계에서 음악이 끊기므로 '최종 이어붙인 뒤' 한 번만 얹는다.
    //   sidechaincompress 로 대사(사이드체인)가 있을 때 BGM 을 자동으로 눌러준다 → 수동 구간
    //   계산 없이 스펙의 덕킹이 성립한다. BGM 이 없으면 이 블록 자체를 건너뛴다(기존 동작).
    if ((p.bgmUrl || "").trim()) {
      try {
        await log("BGM 얹는 중(대사 구간 자동 덕킹)…");
        const bgmPath = join(dir, "bgm.m4a");
        await download(p.bgmUrl, bgmPath);
        const gain = Math.max(0, Math.min(1, Number(p.bgmGain) || 0.35));
        const withBgm = join(dir, "final-bgm.mp4");
        // [1:a] BGM 을 영상 길이에 맞춰 루프(-stream_loop) → 볼륨 → 대사([0:a])로 사이드체인 덕킹 → 합침.
        await run(FFMPEG, [
          "-y", "-i", finalPath, "-stream_loop", "-1", "-i", bgmPath,
          "-filter_complex",
          `[1:a]volume=${gain.toFixed(2)}[bg];` +
            `[bg][0:a]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[bgduck];` +
            `[0:a][bgduck]amix=inputs=2:duration=first:dropout_transition=0,volume=1.1[a]`,
          "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
          "-shortest", "-movflags", "+faststart", withBgm,
        ]);
        finalPath = withBgm;
      } catch (e) {
        // ★실패해도 BGM 없는 최종본으로 진행한다 — 합성이 깨지지 않게.
        await log(`BGM 얹기 실패(BGM 없이 진행): ${String(e?.message ?? e).slice(0, 100)}`);
      }
    }
    await log("업로드 중…");
    const { url } = await put(`project/${projectId}/composed-${Date.now()}.mp4`, createReadStream(finalPath), {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
    });
    const pp = (await getProject(projectId)) ?? p;
    pp.composedUrl = url;
    pp.steps.compose = { ...pp.steps.compose, kind: "compose", status: "review", error: undefined, updatedAt: Date.now() };
    await saveProject(pp);
    await log(`최종 완성: 섹션 ${starts.length}개 이어붙임`);
    return starts.length;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
