// ============================================================================
// 합성(5단계) — ★aninews 검증 per-scene 방식 그대로.★ 씬마다: 영상 + 더빙 오디오 + 자막(시간
// 구간 순차 번인) 을 한 번에 인코딩 → 이어붙이기. 오디오가 영상보다 길면 영상을 슬로모션(setpts)
// 으로 늘림(루프 X). aninews 와 다른 점은 최소화(pad 레터박스, 씬당 오디오 유닛 여러 개 concat).
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
import { renderCaptionBox, renderIntertitleFrame } from "./subtitle-render.mjs";
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

// 이 컷의 '오디오 유닛'(재생 순서) — 말풍선(대사·내레이션·효과음) audioUrl + 그 자막 텍스트.
// sx/sy = 이 줄의 자막 위치(0~1 중심). 화자가 번갈아 말하면 줄마다 다르게 지정됨.
function audioUnits(cut) {
  const units = [];
  for (const b of cut?.bubbles ?? []) {
    if (b.audioUrl)
      units.push({
        audioUrl: b.audioUrl,
        subText: b.speakerId === "__sfx__" ? "" : (b.text || "").trim(),
        sx: b.subtitleX,
        sy: b.subtitleY,
      });
  }
  if (cut?.narrationAudioUrl && (cut?.narration || "").trim()) {
    units.push({ audioUrl: cut.narrationAudioUrl, subText: cut.narration.trim() });
  }
  return units;
}

// 더빙 없는 컷의 자막 유닛(영상 길이에 비례 배치용) — { text, sx, sy }.
function subtitleUnits(cut) {
  const units = [];
  if (cut?.bubbles?.length) {
    for (const b of cut.bubbles) {
      if (b.speakerId === "__sfx__") continue;
      const t = (b.text || "").trim();
      if (t) units.push({ text: t, sx: b.subtitleX, sy: b.subtitleY });
    }
  } else if (cut?.dialogue?.trim()) {
    units.push({ text: cut.dialogue.trim() });
  }
  if (cut?.narration?.trim()) {
    for (const seg of cut.narration.split(/\n\s*\n/)) {
      const t = seg.trim();
      if (t) units.push({ text: t });
    }
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

export async function runCompose(projectId) {
  await resetProgress(projectId);
  await resolveFf();
  const log = async (m) => {
    console.error("[compose]", m);
    await logProgress(projectId, m);
  };

  const p = await getProject(projectId);
  if (!p) throw new Error("프로젝트를 찾을 수 없어요");
  // 자막 씬(무성영화 카드, text 컷)은 영상 없이도 합성 대상 — 검은 배경+카드로 직접 렌더.
  const isCardScene = (s) => !s.videoUrl && s.cut?.type === "text" && subtitleUnits(s.cut).length > 0;
  const scenes = (p.scenes ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .filter((s) => s.videoUrl || isCardScene(s));
  if (scenes.length === 0) throw new Error("묶을 영상이 없어요(먼저 동영상 생성)");

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
        await download(s.videoUrl, vPath);
        vd = (await probeDuration(vPath)) || 3;
      }

      // 더빙 오디오 유닛 다운로드 + 자막 시간구간(유닛 실제 길이 기준)
      const aPaths = [];
      const caps = []; // { text, start, end }
      let acc = 0;
      for (const au of audioUnits(s.cut)) {
        const ext = au.audioUrl.includes(".wav") ? "wav" : "mp3";
        const ap = join(dir, `a${i}_${aPaths.length}.${ext}`);
        try {
          await download(au.audioUrl, ap);
          const ad = (await probeDuration(ap)) || 0.8;
          aPaths.push(ap);
          const start = acc;
          acc += ad;
          if (au.subText) caps.push({ text: au.subText, start, end: acc, sx: au.sx, sy: au.sy });
        } catch {}
      }
      let audioLen = acc;

      // 오디오 유닛 여러 개 → 하나로 concat(가벼운 오디오 패스). 하나면 그대로. 없으면 무음.
      let aPath = null;
      if (aPaths.length === 1) {
        aPath = aPaths[0];
      } else if (aPaths.length > 1) {
        aPath = join(dir, `sa${i}.m4a`);
        const cc = ["-y"];
        for (const ap of aPaths) cc.push("-i", ap);
        cc.push(
          "-filter_complex",
          `${aPaths.map((_, j) => `[${j}:a]`).join("")}concat=n=${aPaths.length}:v=0:a=1[a]`,
          "-map", "[a]", "-c:a", "aac", "-b:a", "128k", aPath
        );
        await run(FFMPEG, cc);
      }

      // 더빙 없으면 자막을 영상 길이에 글자수 비례로 순차. (카드 씬은 글자수 기반 길이)
      if (!aPaths.length) {
        const subs = subtitleUnits(s.cut);
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
      const speed = vd > 0 && finalDur > vd ? finalDur / vd : 1; // 오디오/자막 길면 영상 슬로모션

      // 자막 캡션 PNG(캔버스 재사용). 위치는 자막 있을 때만 계산.
      // 위치 해석: 대사(말풍선)별 지정 > 컷 기본 > 디폴트. 카드 씬 기본은 정중앙(무성영화).
      const cyDef =
        isCard && !s.cut?.subtitlePos && s.cut?.subtitleY == null
          ? Math.round(H * 0.5)
          : subtitleCenterY(s.cut, H);
      const cxDef = subtitleCenterX(s.cut, W);
      const frac = (v) => (typeof v === "number" && isFinite(v) ? Math.max(0.05, Math.min(0.95, v)) : null);
      const capPaths = [];
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

      const fadeOut = FADES_OUT.has(s.cut?.transition);
      const fadeIn = FADES_IN.has(scenes[i - 1]?.cut?.transition) || (i === 0 && s.cut?.transition === "fadein");

      // ── ffmpeg (aninews 패턴): 입력 0=영상(카드 씬은 검정+테두리 프레임), 1=오디오, 2..=자막 PNG ──
      // -nostats/-loglevel warning: 프레임마다 진행 로그를 stderr 에 쏟지 않게(메모리 폭증 방지).
      const args = ["-hide_banner", "-nostats", "-loglevel", "warning", "-y"];
      if (isCard) {
        const frame = await renderIntertitleFrame({ W, H });
        if (!frame) throw new Error("자막 씬 배경 렌더 실패(canvas 미설치?)");
        const fp = join(dir, `frame${i}.png`);
        await writeFile(fp, frame);
        args.push("-loop", "1", "-framerate", String(FPS), "-i", fp);
      } else {
        args.push("-i", vPath);
      }
      if (aPath) args.push("-i", aPath);
      else args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
      for (const c of capPaths) args.push("-loop", "1", "-framerate", String(FPS), "-i", c.path);
      let filter = isCard
        ? `[0:v]setsar=1,fps=${FPS}` // 프레임이 이미 W×H 정확 — 스케일·슬로모션 불필요
        : `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
          `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,setpts=${speed.toFixed(4)}*PTS,fps=${FPS}`;
      if (fadeIn) filter += `,fade=t=in:st=0:d=${FADE}`;
      if (fadeOut) filter += `,fade=t=out:st=${Math.max(0, finalDur - FADE).toFixed(2)}:d=${FADE}`;
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
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "23", "-threads", "2",
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
    await log(`합성 완료: 영상 ${scenes.length}개 → 1개`);
    return scenes.length;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
