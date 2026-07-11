// ============================================================================
// 합성(5단계) — 씬 영상을 이어붙이고(영상=뼈대) 더빙 오디오를 '위에 흘려' 얹는다.
// ----------------------------------------------------------------------------
// ★영상은 자연 길이로 이어붙이고 슬로모션으로 늘리지 않는다. 오디오가 씬보다 길면 다음
//   씬으로 '흘러넘치게'(글로벌 타임라인, 겹치지 않게 밀어서). 자막은 그 오디오 시간구간에
//   순차로 번인. 오디오가 총 영상보다 길면 마지막 프레임을 유지해 커버. (aninews 반대 모델)
// ============================================================================

import { getProject, saveProject, logProgress, resetProgress, recordCost } from "./store.mjs";
import { put } from "@vercel/blob";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickSubtitleBand } from "./subtitle-place.mjs";
import { renderCaptionPng } from "./subtitle-render.mjs";
import { detectFaceHandBoxes } from "./vision-boxes.mjs";
import { stripMarks } from "./emphasis.mjs";

// ffmpeg 바이너리 경로 — 지연 로드(워커 시작 때 import 하면 설치 문제로 워커가 죽는다).
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
const OPENAI_KEY = process.env.OPENAI_API_KEY;

function run(cmd, args, timeoutMs = 300_000) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args);
    let err = "";
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
      rej(new Error(`${cmd} 타임아웃 — ffmpeg 마지막: ${err.slice(-400)}`));
    }, timeoutMs);
    p.stderr.on("data", (d) => (err += d));
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

async function download(url, dest) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`다운로드 실패 ${r.status}`);
  // 스트리밍 저장 — 파일 전체를 메모리(Buffer)에 안 올린다(OOM 방지).
  if (r.body) await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
  else await writeFile(dest, Buffer.from(await r.arrayBuffer()));
}
async function download2(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

function targetDims(project) {
  const ar = project?.aspectRatio;
  if (ar === "9:16") return [720, 1280];
  if (ar === "1:1") return [1024, 1024];
  return [1280, 720]; // 16:9
}

const FADES_OUT = new Set(["fadeout", "black", "dissolve"]);
const FADES_IN = new Set(["fadein", "black", "dissolve"]);

// 이 컷의 '오디오 유닛'(재생 순서) — 말풍선(대사·내레이션·효과음) audioUrl + 그 자막 텍스트.
// 효과음(__sfx__) 은 소리만(자막 없음). 레거시 cut.narration 도 뒤에.
function audioUnits(cut) {
  const units = [];
  for (const b of cut?.bubbles ?? []) {
    if (b.audioUrl) units.push({ audioUrl: b.audioUrl, subText: b.speakerId === "__sfx__" ? "" : (b.text || "").trim() });
  }
  if (cut?.narrationAudioUrl && (cut?.narration || "").trim()) {
    units.push({ audioUrl: cut.narrationAudioUrl, subText: cut.narration.trim() });
  }
  return units;
}

// 자막 없는 컷의 자막 유닛(더빙 오디오가 없을 때 영상 길이에 비례 배치용).
function subtitleUnits(cut) {
  const units = [];
  if (cut?.bubbles?.length) {
    for (const b of cut.bubbles) {
      if (b.speakerId === "__sfx__") continue;
      const t = (b.text || "").trim();
      if (t) units.push(t);
    }
  } else if (cut?.dialogue?.trim()) {
    units.push(cut.dialogue.trim());
  }
  if (cut?.narration?.trim()) {
    for (const seg of cut.narration.split(/\n\s*\n/)) {
      const t = seg.trim();
      if (t) units.push(t);
    }
  }
  return units;
}

// 자막 세로중심 y — 수동(top/middle/bottom) 또는 auto.
// ★auto 는 gpt-4o 얼굴검출을 안 쓴다(씬마다 호출은 느리고 비용). 대신 이미지 자체의 '복잡한
//   영역 회피'(로컬·무료·빠름)로 빈 곳에 놓는다. 정확한 얼굴 회피는 나중에 재생성 때 1회 계산.
async function subtitleCenterY(s, W, H) {
  const pos = s.cut?.subtitlePos;
  if (pos === "top") return Math.round(H * 0.15);
  if (pos === "middle") return Math.round(H * 0.5);
  if (pos === "bottom") return Math.round(H * 0.85);
  let cy = Math.round(H * 0.82);
  if (s.generatedImage) {
    try {
      const genBuf = await download2(s.generatedImage);
      if (genBuf) {
        const band = await pickSubtitleBand(genBuf, { frameW: W, frameH: H, heightFrac: 0.16 });
        cy = Math.round(band.y + (H * 0.16) / 2);
      }
    } catch {}
  }
  return cy;
}

// projectId 의 씬 영상들을 이어붙이고 더빙 오디오/자막을 얹어 project.composedUrl 로.
export async function runCompose(projectId) {
  await resetProgress(projectId);
  await resolveFf();
  const log = async (m) => {
    console.error("[compose]", m);
    await logProgress(projectId, m);
  };

  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const scenes = (p.scenes ?? []).slice().sort((a, b) => a.order - b.order).filter((s) => s.videoUrl);
  if (scenes.length === 0) throw new Error("묶을 영상이 없어요(먼저 동영상 생성)");

  const [W, H] = targetDims(p);
  const dir = await mkdtemp(join(tmpdir(), "recompose-"));
  try {
    // ── 1) 씬별 다운로드(영상+더빙 오디오) + 길이/자막위치 수집 (인코딩은 아직 X) ──
    const sceneData = []; // { raw, vd, units:[{ap,dur,subText}], cy, fadeIn, fadeOut }
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      await log(`씬 다운로드 ${i + 1}/${scenes.length}…`);
      const raw = join(dir, `raw${i}.mp4`);
      await download(s.videoUrl, raw);
      const vd = (await probeDuration(raw)) || 3;
      const units = [];
      for (const au of audioUnits(s.cut)) {
        const ext = au.audioUrl.includes(".wav") ? "wav" : "mp3";
        const ap = join(dir, `a${i}_${units.length}.${ext}`);
        try {
          await download(au.audioUrl, ap);
          const ad = (await probeDuration(ap)) || 0.8;
          units.push({ ap, dur: ad, subText: au.subText });
        } catch {}
      }
      const subUnits = subtitleUnits(s.cut);
      // 자막(대사/내레이션) 있는 씬만 얼굴검출(gpt-4o) — 없으면 건너뛰어 시간·비용 절약.
      const willHaveCaption = units.some((u) => u.subText) || subUnits.length > 0;
      const cy = willHaveCaption ? await subtitleCenterY(s, W, H) : Math.round(H * 0.82);
      sceneData.push({
        raw,
        vd,
        units,
        cy,
        subUnits, // 더빙 없을 때 자막(오디오 없이 영상 길이에 비례)
        fadeIn: FADES_IN.has(scenes[i - 1]?.cut?.transition) || (i === 0 && s.cut?.transition === "fadein"),
        fadeOut: FADES_OUT.has(s.cut?.transition),
      });
    }

    // ── 2) 글로벌 타임라인: 씬 시작 Ti, 오디오 시작 = max(Ti, 이전 오디오 끝)(겹침 없이 다음 씬으로 흘림) ──
    const allAudio = []; // { ap, gstart }
    const capItems = []; // { text, gstart, gend, cy }
    const starts = []; // 씬 시작(비디오 타임라인)
    let prevEnd = 0;
    let Ti = 0;
    for (const sd of sceneData) {
      starts.push(Ti);
      let acc = Math.max(Ti, prevEnd);
      if (sd.units.length) {
        for (const u of sd.units) {
          const gstart = acc;
          acc += u.dur;
          allAudio.push({ ap: u.ap, gstart });
          if (u.subText) capItems.push({ text: u.subText, gstart, gend: acc, cy: sd.cy });
        }
        prevEnd = acc;
      } else if (sd.subUnits.length) {
        // 더빙 없음 → 자막을 이 씬 영상 길이에 글자수 비례로 순차(오디오 없음).
        const weights = sd.subUnits.map((t) => Math.max(1, stripMarks(t).replace(/\s/g, "").length));
        const wSum = weights.reduce((a, b) => a + b, 0) || 1;
        let t0 = Ti;
        sd.subUnits.forEach((txt, j) => {
          const d = Math.max(1.2, (sd.vd * weights[j]) / wSum);
          capItems.push({ text: txt, gstart: t0, gend: t0 + d, cy: sd.cy });
          t0 += d;
        });
        prevEnd = Math.max(prevEnd, Ti);
      } else {
        prevEnd = Math.max(prevEnd, Ti);
      }
      Ti += sd.vd;
    }
    const videoTotal = Ti;
    const D = Math.max(videoTotal, prevEnd, capItems.length ? Math.max(...capItems.map((c) => c.gend)) : 0);
    const extra = Math.max(0, D - videoTotal); // 영상 끝 뒤로 흐르는 오디오/자막 → 마지막 씬 프레임 유지
    if (capItems.length) capItems[capItems.length - 1].gend = D + 0.3;

    // ── 3) 자막 캡션 PNG(각 씬 위치 cy). 중복 없이 유닛마다 하나. ──
    for (let k = 0; k < capItems.length; k++) {
      try {
        const png = await renderCaptionPng(capItems[k].text, { W, H, cy: capItems[k].cy });
        if (png) {
          const cp = join(dir, `cap${k}.png`);
          await writeFile(cp, png);
          capItems[k].path = cp;
        }
      } catch {}
    }

    // ── 4) 씬별 인코딩 — ★메모리 안전★: 이 씬 창에 겹치는 자막만 번인(입력 소수). 슬로모션 X. ──
    const norm = [];
    for (let i = 0; i < sceneData.length; i++) {
      const sd = sceneData[i];
      const isLast = i === sceneData.length - 1;
      const lenI = sd.vd + (isLast ? extra : 0); // 마지막 씬은 흐르는 오디오만큼 프레임 유지
      const T0 = starts[i];
      // 이 씬 창 [T0, T0+lenI] 에 걸치는 자막(경계 걸치면 로컬 시간으로 잘라 번인 → 다음 씬으로 흘러 보임)
      const local = [];
      for (const c of capItems) {
        if (!c.path) continue;
        const ls = Math.max(0, c.gstart - T0);
        const le = Math.min(lenI, c.gend - T0);
        if (le > ls + 0.02) local.push({ path: c.path, ls, le });
      }
      let vfilter =
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
      if (isLast && extra > 0.05) vfilter += `,tpad=stop_mode=clone:stop_duration=${extra.toFixed(2)}`;
      vfilter += `,fps=${FPS}`;
      if (sd.fadeIn) vfilter += `,fade=t=in:st=0:d=${FADE}`;
      if (sd.fadeOut) vfilter += `,fade=t=out:st=${Math.max(0, lenI - FADE).toFixed(2)}:d=${FADE}`;
      vfilter += `[bg]`;
      let prev = "bg";
      local.forEach((lc, k) => {
        // aninews 패턴 그대로 — overlay + enable, 출력 -t 로 종료(shortest·입력-t 안 씀).
        vfilter += `;[${prev}][${1 + k}:v]overlay=0:0:enable='between(t,${lc.ls.toFixed(3)},${lc.le.toFixed(3)})'[cv${k}]`;
        prev = `cv${k}`;
      });
      const args = ["-y", "-i", sd.raw];
      for (const lc of local) args.push("-loop", "1", "-framerate", String(FPS), "-i", lc.path);
      const out = join(dir, `n${i}.mp4`);
      args.push(
        "-filter_complex", vfilter, "-map", `[${prev}]`, "-an",
        "-t", lenI.toFixed(2), "-r", String(FPS),
        // ★aninews 검증 설정: veryfast/crf23. superfast·-threads 조정은 이 워커에서 매달림(hang).
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23",
        "-movflags", "+faststart", out
      );
      await log(`씬 ${i + 1}/${sceneData.length} 인코딩(자막 ${local.length})…`);
      await run(FFMPEG, args);
      norm.push(out);
    }

    // ── 5) 영상 이어붙이기(무손실) ──
    await log("영상 이어붙이는 중…");
    const listFile = join(dir, "list.txt");
    await writeFile(listFile, norm.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    const gv = join(dir, "global.mp4");
    await run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", gv]);

    // ── 6) 글로벌 오디오(별도 1패스, 오디오만 → 가벼움): 각 유닛 지연배치 후 믹스 ──
    let ga = null;
    if (allAudio.length) {
      await log(`오디오 합치는 중(${allAudio.length}개)…`);
      const aArgs = ["-y"];
      for (const a of allAudio) aArgs.push("-i", a.ap);
      let af = "";
      allAudio.forEach((a, j) => {
        af += `[${j}:a]adelay=${Math.round(a.gstart * 1000)}:all=1[ad${j}];`;
      });
      af += `${allAudio.map((_, j) => `[ad${j}]`).join("")}amix=inputs=${allAudio.length}:normalize=0:dropout_transition=0[aout]`;
      ga = join(dir, "ga.m4a");
      aArgs.push("-filter_complex", af, "-map", "[aout]", "-t", D.toFixed(2), "-c:a", "aac", "-b:a", "128k", ga);
      await run(FFMPEG, aArgs);
    }

    // ── 7) 최종 mux(복사 — 재인코딩 X, 가벼움) ──
    await log(`최종 mux(${D.toFixed(1)}s)…`);
    const finalPath = join(dir, "final.mp4");
    if (ga) {
      await run(FFMPEG, [
        "-y", "-i", gv, "-i", ga,
        "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy",
        "-t", D.toFixed(2), "-movflags", "+faststart", finalPath,
      ]);
    } else {
      await run(FFMPEG, ["-y", "-i", gv, "-c", "copy", "-movflags", "+faststart", finalPath]);
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
    try {
      await recordCost({ projectId, vendor: "worker", model: "ffmpeg-compose", costUsd: 0, meta: { kind: "compose", clips: scenes.length } });
    } catch {}
    await log(`합성 완료: 영상 ${scenes.length}개 · ${D.toFixed(1)}s`);
    return scenes.length;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
