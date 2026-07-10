// ============================================================================
// 합성(5단계) — 씬 영상들을 순서대로 이어붙여 하나의 mp4 로. 오디오·자막은 나중.
// ----------------------------------------------------------------------------
// 각 클립을 목표 비율로 정규화(scale+pad+fps) + 컷별 전환(페이드/암전/디졸브≈페이드)
// → concat 데미먹서로 이어붙임 → Blob. ffmpeg 필요(Dockerfile 설치).
// 전환 의미: cut[i].transition = i 와 i+1 사이 경계 효과 → i 클립 fadeOut / i+1 클립 fadeIn.
// ============================================================================

import { getProject, saveProject, logProgress, resetProgress, recordCost } from "./store.mjs";
import { put } from "@vercel/blob";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickSubtitleBand } from "./subtitle-place.mjs";
import { renderSubtitle, renderCaptionPng } from "./subtitle-render.mjs";
import { detectFaceHandBoxes } from "./vision-boxes.mjs";
import { stripMarks } from "./emphasis.mjs";

// ffmpeg 바이너리 경로 — 합성할 때만 '지연' 로드한다(워커 시작 때 import 하면 ffmpeg-static
// 설치 문제가 워커 전체를 죽인다). Render node 런타임엔 시스템 ffmpeg 가 없어 npm 정적
// 바이너리를 쓰되, 실패하면 PATH 폴백. env(FFMPEG_PATH/FFPROBE_PATH) override 우선.
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
    /* PATH 의 ffmpeg/ffprobe 폴백 유지 */
  }
}

const FADE = Number(process.env.COMPOSE_FADE_SEC || 0.5);
const FPS = Number(process.env.COMPOSE_FPS || 24); // 24fps 로 충분(파일 작게). env 로 조정.
const OPENAI_KEY = process.env.OPENAI_API_KEY; // 자막 얼굴/손 회피용(없으면 감지 skip)

function run(cmd, args, timeoutMs = 180_000) {
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
    const p = spawn(FFPROBE, [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1", file,
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => res(parseFloat(out.trim()) || 0));
    p.on("error", () => res(0));
  });
}

async function download(url, dest) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`영상 다운로드 실패 ${r.status}`);
  await writeFile(dest, Buffer.from(await r.arrayBuffer()));
}
// 버퍼로 다운로드(자막 배치 분석용 생성 이미지). 실패 시 null.
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
const SUB_FRAC = Number(process.env.SUBTITLE_HEIGHT_FRAC || 0.18); // 자막 띠 높이(프레임 대비)

// 이 컷의 '오디오 유닛'(재생 순서) — 말풍선(대사·내레이션·효과음) audioUrl + 그 자막 텍스트.
// 효과음(__sfx__) 은 소리만(자막 없음). 레거시 cut.narration 도 뒤에 붙인다.
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

// 자막 세로중심 y — 수동(top/middle/bottom) 또는 auto(얼굴/손 회피).
async function subtitleCenterY(s, W, H, projectId) {
  const pos = s.cut?.subtitlePos;
  if (pos === "top") return Math.round(H * 0.15);
  if (pos === "middle") return Math.round(H * 0.5);
  if (pos === "bottom") return Math.round(H * 0.85);
  let cy = Math.round(H * 0.82); // auto 기본: 하단
  if (s.generatedImage) {
    try {
      const genBuf = await download2(s.generatedImage);
      if (genBuf) {
        const fh = await detectFaceHandBoxes(genBuf, OPENAI_KEY);
        if (fh.cost) {
          try {
            await recordCost({ projectId, vendor: "openai", model: "gpt-4o", costUsd: fh.cost, meta: { kind: "subtitle-faces" } });
          } catch {}
        }
        const band = await pickSubtitleBand(genBuf, { frameW: W, frameH: H, heightFrac: 0.16, faces: fh.faces, hands: fh.hands });
        cy = Math.round(band.y + (H * 0.16) / 2);
      }
    } catch {}
  }
  return cy;
}

// 이 컷 자막 '유닛' 배열 — 각 말풍선/내레이션 조각이 별개 박스. 겹치지 않게 세로로 쌓인다.
function subtitleUnits(cut) {
  const units = [];
  if (cut?.bubbles?.length) {
    for (const b of cut.bubbles) {
      if (b.speakerId === "__sfx__") continue; // 효과음 줄은 자막 아님(소리)
      const t = (b.text || "").trim();
      if (t) units.push(t);
    }
  } else if (cut?.dialogue?.trim()) {
    units.push(cut.dialogue.trim());
  }
  // 내레이션: 빈 줄로 나뉜 별개 조각을 각각 박스로.
  if (cut?.narration?.trim()) {
    for (const seg of cut.narration.split(/\n\s*\n/)) {
      const t = seg.trim();
      if (t) units.push(t);
    }
  }
  return units;
}

// projectId 의 씬 영상들을 이어붙여 project.composedUrl 로. compose 단계 진행 표시.
export async function runCompose(projectId) {
  await resetProgress(projectId);
  await resolveFf(); // ffmpeg 바이너리 경로 확정(지연 로드)
  const log = async (m) => {
    console.error("[compose]", m);
    await logProgress(projectId, m);
  };

  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  const scenes = (p.scenes ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .filter((s) => s.videoUrl);
  if (scenes.length === 0) throw new Error("묶을 영상이 없어요(먼저 동영상 생성)");

  const [W, H] = targetDims(p);
  const dir = await mkdtemp(join(tmpdir(), "recompose-"));
  try {
    const norm = [];
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      await log(
        `영상 정규화 ${i + 1}/${scenes.length}… (${Math.round((i / scenes.length) * 100)}%)`
      );
      const raw = join(dir, `raw${i}.mp4`);
      await download(s.videoUrl, raw);
      const vd = (await probeDuration(raw)) || 3;
      const fadeOut = FADES_OUT.has(s.cut?.transition);
      const fadeIn =
        FADES_IN.has(scenes[i - 1]?.cut?.transition) ||
        (i === 0 && s.cut?.transition === "fadein");

      // ── 더빙 오디오 유닛 다운로드 + 자막 캡션 타이밍 ──
      const aus = audioUnits(s.cut);
      const aPaths = [];
      const captions = []; // [{ text, start, end }] — 순차 표시
      let audioLen = 0;
      if (aus.length) {
        let acc = 0;
        for (let j = 0; j < aus.length; j++) {
          const ext = aus[j].audioUrl.includes(".wav") ? "wav" : "mp3";
          const ap = join(dir, `a${i}_${j}.${ext}`);
          try {
            await download(aus[j].audioUrl, ap);
            const ad = (await probeDuration(ap)) || 0.8;
            aPaths.push(ap);
            const start = acc;
            acc += ad;
            if (aus[j].subText) captions.push({ text: aus[j].subText, start, end: acc });
          } catch (e) {
            await log(`씬 ${i + 1}: 오디오 스킵: ${String(e?.message ?? e).slice(0, 80)}`);
          }
        }
        audioLen = acc;
      } else {
        // 더빙 없음 → 자막을 영상 길이에 글자수 비례로 순차 배치.
        const subUnits = subtitleUnits(s.cut);
        if (subUnits.length) {
          const weights = subUnits.map((t) => Math.max(1, stripMarks(t).replace(/\s/g, "").length));
          const wSum = weights.reduce((a, b) => a + b, 0) || 1;
          let acc = 0;
          subUnits.forEach((t, j) => {
            const d = Math.max(1.2, (vd * weights[j]) / wSum);
            const start = acc;
            acc += d;
            captions.push({ text: t, start, end: acc });
          });
        }
      }
      const capTotal = captions.length ? captions[captions.length - 1].end : 0;
      const duration = Math.max(audioLen, capTotal, vd);
      if (captions.length) captions[captions.length - 1].end = duration + 0.5;
      const speed = vd > 0 && duration > vd ? duration / vd : 1; // 오디오/자막 길면 영상 슬로모션

      // 자막 캡션 PNG(전체프레임, 순차) — 위치는 씬당 한 번(수동 or 얼굴 회피).
      const capPaths = [];
      if (captions.length) {
        const cy = await subtitleCenterY(s, W, H, projectId);
        for (let k = 0; k < captions.length; k++) {
          try {
            const png = await renderCaptionPng(captions[k].text, { W, H, cy });
            if (png) {
              const cp = join(dir, `cap${i}_${k}.png`);
              await writeFile(cp, png);
              capPaths.push({ path: cp, span: captions[k] });
            }
          } catch {}
        }
      }

      // ── ffmpeg: 영상(슬로모션+페이드) + 자막(시간구간 순차 overlay) + 더빙 오디오 mux ──
      const A = aPaths.length;
      const C = capPaths.length;
      let vfilter =
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
        `setpts=${speed.toFixed(4)}*PTS,fps=${FPS}`;
      if (fadeIn) vfilter += `,fade=t=in:st=0:d=${FADE}`;
      if (fadeOut) vfilter += `,fade=t=out:st=${Math.max(0, duration - FADE).toFixed(2)}:d=${FADE}`;
      vfilter += `[bg]`;
      let prev = "bg";
      capPaths.forEach((c, k) => {
        const inIdx = 1 + A + k;
        const label = `cv${k}`;
        vfilter += `;[${prev}][${inIdx}:v]overlay=0:0:enable='between(t,${c.span.start.toFixed(3)},${c.span.end.toFixed(3)})'[${label}]`;
        prev = label;
      });

      const out = join(dir, `n${i}.mp4`);
      const args = ["-y", "-i", raw];
      for (const ap of aPaths) args.push("-i", ap);
      for (const c of capPaths) args.push("-loop", "1", "-framerate", String(FPS), "-i", c.path);
      let audioMap;
      if (A === 0) {
        args.push("-f", "lavfi", "-t", duration.toFixed(2), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
        audioMap = `${1 + C}:a`;
      } else if (A === 1) {
        audioMap = "1:a";
      } else {
        vfilter += `;${aPaths.map((_, j) => `[${1 + j}:a]`).join("")}concat=n=${A}:v=0:a=1[aout]`;
        audioMap = "[aout]";
      }
      args.push(
        "-filter_complex", vfilter,
        "-map", `[${prev}]`,
        "-map", audioMap,
        "-t", duration.toFixed(2),
        "-r", String(FPS),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "21",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", out
      );
      await log(`씬 ${i + 1}/${scenes.length}: 인코딩(자막 ${C}·오디오 ${A}·${duration.toFixed(1)}s)…`);
      await run(FFMPEG, args);
      norm.push(out);
    }

    await log("이어붙이는 중…");
    const listFile = join(dir, "list.txt");
    await writeFile(listFile, norm.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    const finalPath = join(dir, "final.mp4");
    await run(FFMPEG, [
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c", "copy", "-movflags", "+faststart", finalPath,
    ]);

    await log("업로드 중…");
    const { url } = await put(
      `project/${projectId}/composed-${Date.now()}.mp4`,
      createReadStream(finalPath),
      { access: "public", contentType: "video/mp4", addRandomSuffix: false }
    );

    const pp = (await getProject(projectId)) ?? p;
    pp.composedUrl = url;
    pp.steps.compose = {
      ...pp.steps.compose,
      kind: "compose",
      status: "review",
      error: undefined,
      updatedAt: Date.now(),
    };
    await saveProject(pp);
    try {
      await recordCost({ projectId, vendor: "worker", model: "ffmpeg-compose", costUsd: 0, meta: { kind: "compose", clips: scenes.length } });
    } catch {}
    await log(`합성 완료: 영상 ${scenes.length}개 → 1개`);
    return scenes.length;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
