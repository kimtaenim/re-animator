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
import { renderSubtitle } from "./subtitle-render.mjs";

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
const FPS = Number(process.env.COMPOSE_FPS || 30);

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

// 이 컷 자막 텍스트 = 대사(말풍선 합침) + 나레이션. 씬마다 이걸 얹는다.
function subtitleText(cut) {
  const parts = [];
  if (cut?.bubbles?.length) {
    for (const b of cut.bubbles) {
      const t = (b.text || "").trim();
      if (t) parts.push(t);
    }
  } else if (cut?.dialogue) {
    parts.push(cut.dialogue.trim());
  }
  if (cut?.narration?.trim()) parts.push(cut.narration.trim());
  return parts.filter(Boolean).join("  ").trim();
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
      await log(`영상 정규화 ${i + 1}/${scenes.length}…`);
      const raw = join(dir, `raw${i}.mp4`);
      await download(s.videoUrl, raw);
      const dur = (await probeDuration(raw)) || 3;
      const fadeOut = FADES_OUT.has(s.cut?.transition); // 이 컷 끝 전환
      // 이 컷 시작 페이드인: 앞 컷의 전환이 인/암전/디졸브면. 첫 컷은 자기 전환이 페이드인이면(인트로).
      const fadeIn =
        FADES_IN.has(scenes[i - 1]?.cut?.transition) ||
        (i === 0 && s.cut?.transition === "fadein");

      const vf = [
        `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
        "setsar=1",
        `fps=${FPS}`,
      ];
      if (fadeIn) vf.push(`fade=t=in:st=0:d=${FADE}`);
      if (fadeOut) vf.push(`fade=t=out:st=${Math.max(0, dur - FADE).toFixed(2)}:d=${FADE}`);

      // 자막 — 씬마다 대사+나레이션을 '빈 곳'에 얹는다(폰트/canvas 없으면 자막만 skip).
      const subText = subtitleText(s.cut);
      let subPath = null;
      let bandY = H - Math.round(H * SUB_FRAC); // 기본 하단
      const bandH = Math.round(H * SUB_FRAC);
      if (subText) {
        try {
          if (s.generatedImage) {
            const genBuf = await download2(s.generatedImage);
            if (genBuf) {
              const band = await pickSubtitleBand(genBuf, {
                frameW: W,
                frameH: H,
                heightFrac: SUB_FRAC,
              });
              bandY = band.y;
            }
          }
          const png = await renderSubtitle(subText, { frameW: W, bandH });
          if (png) {
            subPath = join(dir, `sub${i}.png`);
            await writeFile(subPath, png);
          }
        } catch {
          /* 자막 실패 → 자막 없이 진행 */
        }
      }

      const out = join(dir, `n${i}.mp4`);
      if (subPath) {
        await run(FFMPEG, [
          "-y", "-i", raw, "-loop", "1", "-i", subPath,
          "-filter_complex",
          `[0:v]${vf.join(",")}[base];[base][1:v]overlay=0:${bandY}:shortest=1[v]`,
          "-map", "[v]",
          "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
          "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
        ]);
      } else {
        await run(FFMPEG, [
          "-y", "-i", raw,
          "-vf", vf.join(","),
          "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
          "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
        ]);
      }
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
