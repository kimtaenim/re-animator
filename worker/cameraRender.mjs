// ============================================================================
// re-animator — 워커 카메라 렌더러 (스펙 §2 계층 A · Phase 2)
// ----------------------------------------------------------------------------
// 카메라워크를 I2V 클립 위에 후처리로 굽는다. ★수식은 lib/cameraKeyframes.mjs
// (단일 소스)에만 있고, 여기선 그 테이블이 준 **리터럴 픽셀 crop 값**을 ffmpeg
// sendcmd 로 프레임마다 재생만 한다. → "zoompan 수식 직접 기술 금지"(스펙 §2) 준수.
// 단일 패스 스트리밍이라 프레임별 sharp 디코딩이 없다(합성 OOM 회피 — 메모리 메모 참조).
//
// crop 필터의 w/h/x/y 는 모두 런타임 command(T 플래그) 지원 → sendcmd 로 갱신 가능.
// 계층 B(2레이어)는 인물/배경 매트가 생기면 이 파일에 background/character 별도 crop
// 후 overlay 합성으로 확장(현재 미구현 — 온디맨드 매트 확보 후, 스펙 v0.2 참조).
// ============================================================================
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { buildKeyframeTable, sampleTrack, toPixelCrop, presetLayer, needsUpscale } from "../lib/cameraKeyframes.mjs";

/**
 * 계층 A 테이블 → ffmpeg sendcmd 스크립트 문자열.
 * 각 프레임 시각에 crop w/h/x/y 를 리터럴 짝수 픽셀로 설정한다.
 * @param {import("../lib/cameraKeyframes.mjs").KeyframeTable} table
 * @param {number} W @param {number} H
 * @returns {{ script: string, first: {cropW:number,cropH:number,x:number,y:number} }}
 */
export function buildSendcmdScript(table, W, H) {
  const tr = table.tracks.main;
  if (!tr || !tr.keys.length) throw new Error("계층 A main 트랙이 비어있음");
  const lines = [];
  let first = null;
  for (const k of tr.keys) {
    const c = toPixelCrop({ scale: k.scale, cx: k.cx, cy: k.cy }, W, H, { even: true });
    if (!first) first = c;
    // sendcmd 문법: "TS target command arg, target command arg, ...;"
    lines.push(`${k.t.toFixed(3)} crop w ${c.cropW}, crop h ${c.cropH}, crop x ${c.x}, crop y ${c.y};`);
  }
  return { script: lines.join("\n") + "\n", first };
}

/**
 * 클립에 카메라워크(계층 A)를 구워 outPath 에 쓴다.
 * @param {object} o
 * @param {string} o.ff  ffmpeg 경로
 * @param {string} o.fp  ffprobe 경로
 * @param {string} o.dir 작업 디렉터리(sendcmd 스크립트를 여기 쓰고 cwd 로 실행 — 경로 이스케이프 회피)
 * @param {string} o.inPath  입력 클립(절대경로)
 * @param {string} o.outPath 출력(절대경로)
 * @param {import("../lib/cameraKeyframes.mjs").CameraWork} o.cameraWork
 * @param {number} [o.outHeight] 출력 높이(업스케일 판단용, 기본 클립 높이)
 * @param {(m:string)=>void} [o.onLog]
 * @returns {Promise<{ skipped?: boolean, layer: string, upscale: boolean, maxScale: number }>}
 */
export async function renderCameraFx(o) {
  const { ff, fp, dir, inPath, outPath, cameraWork, onLog } = o;
  const log = (m) => onLog?.(m);
  const layer = presetLayer(cameraWork.preset);

  // 계층 C(orbit): 후처리 없음 — 카메라는 I2V 프롬프트가 담당.
  if (layer === "C") {
    log?.(`orbit(계층 C) — 후처리 카메라 없음(I2V 위임)`);
    return { skipped: true, layer, upscale: false, maxScale: 1 };
  }
  // 계층 B: 인물/배경 매트 미구현 → 현재는 미지원(온디맨드 매트 후). 안전하게 스킵.
  if (layer === "B") {
    log?.(`${cameraWork.preset}(계층 B) — 인물/배경 매트 필요, 현재 미구현으로 스킵`);
    return { skipped: true, layer, upscale: false, maxScale: 1 };
  }

  const [W, H] = await probe(fp, inPath, "stream=width,height");
  const [durProbed] = await probe(fp, inPath, "format=duration");
  const [fpsRaw] = await probeRaw(fp, inPath, "stream=r_frame_rate");
  const fps = parseFps(fpsRaw) || 24;
  if (!W || !H) throw new Error("클립 해상도를 읽지 못함");
  const dur = Number(cameraWork.duration_s) || durProbed || 3;

  // ★crash_zoom(스펙 §2): 카메라 이동이 아니라 와이드/바스트/익스트림클로즈업 3장 하드컷 클러스터.
  //   3장 재생성 대신, 클립을 3단 크롭(1.0/1.6/2.4배)으로 각 ~0.5초 하드컷(단일 ffmpeg 패스).
  if (cameraWork.preset === "crash_zoom") {
    await renderCrashZoom({ ff, dir, inPath, outPath, W, H, clipDur: durProbed || dur, onLog: log });
    return { skipped: false, layer, upscale: false, maxScale: 2.4 };
  }

  const table = buildKeyframeTable(cameraWork, { fps, refWidth: W, refHeight: H });

  // 사실상 정지(줌·드리프트·셰이크 없음) → 렌더 스킵(원본 그대로 사용).
  if (isIdentity(table)) {
    log?.(`static/무모션 — 렌더 스킵(원본 사용)`);
    return { skipped: true, layer, upscale: false, maxScale: 1 };
  }

  const { script, first } = buildSendcmdScript(table, W, H);
  const scriptName = "camcmd.txt";
  await writeFile(join(dir, scriptName), script, "utf8");

  const upscale = needsUpscale(table, o.outHeight ?? H);
  // 업스케일 트리거(스펙 §1): 줌>20% 또는 1080p. Real-ESRGAN 실제 패스는 후속 —
  // 현재는 스케일 단계 flags 를 lanczos 로 올려 열화 최소화 + 로그로 가시화.
  const scaleFlags = upscale ? "lanczos" : "bicubic";
  if (upscale) log?.(`업스케일 트리거(줌 ${(table.maxScale * 100 - 100).toFixed(0)}%·${o.outHeight ?? H}p) — lanczos 폴백(ESRGAN 후속)`);

  // crop 초기값 = 프레임0 값(sendcmd 첫 명령 타이밍 어긋나도 첫 프레임 정확).
  const vf =
    `sendcmd=f=${scriptName},` +
    `crop=w=${first.cropW}:h=${first.cropH}:x=${first.x}:y=${first.y}:exact=1,` +
    `scale=${W}:${H}:flags=${scaleFlags},setsar=1`;

  await run(ff, ["-hide_banner", "-nostats", "-loglevel", "warning", "-y", "-i", inPath, "-vf", vf, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", "-threads", "2", "-movflags", "+faststart", outPath], dir);

  return { skipped: false, layer, upscale, maxScale: table.maxScale };
}

// crash_zoom(§2) — 클립을 와이드→바스트→ECU 3단 크롭 하드컷으로 굽는다(단일 filter_complex).
async function renderCrashZoom({ ff, dir, inPath, outPath, W, H, clipDur, onLog }) {
  const seg = 0.5; // 각 프레이밍 길이(0.4~0.8 범위 중앙)
  const zs = [1.0, 1.6, 2.4]; // 와이드 / 바스트 / 익스트림클로즈업
  const avail = Math.max(seg, Number(clipDur) || seg * 3);
  const starts = [0, seg, seg * 2].map((v) => Math.max(0, Math.min(v, avail - seg)));
  const parts = zs.map((z, i) => {
    const cw = Math.max(2, Math.round(W / z / 2) * 2);
    const ch = Math.max(2, Math.round(H / z / 2) * 2);
    const yBias = z > 2 ? 0.35 : 0.5; // ECU 는 얼굴 쪽(살짝 위)
    const x = Math.round((W - cw) / 2 / 2) * 2;
    const y = Math.round(((H - ch) * yBias) / 2) * 2;
    return `[0:v]trim=${starts[i].toFixed(3)}:${(starts[i] + seg).toFixed(3)},setpts=PTS-STARTPTS,crop=${cw}:${ch}:${x}:${y},scale=${W}:${H}:flags=bicubic,setsar=1[v${i}]`;
  });
  const filter = parts.join(";") + `;[v0][v1][v2]concat=n=3:v=1:a=0[out]`;
  await run(ff, ["-hide_banner", "-nostats", "-loglevel", "warning", "-y", "-i", inPath, "-filter_complex", filter, "-map", "[out]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", "-threads", "2", "-movflags", "+faststart", outPath], dir);
  onLog?.(`crash_zoom 3프레이밍(와이드·바스트·ECU 하드컷 ${seg}s×3)`);
}

// 테이블이 모든 프레임에서 원본(scale≈1, 중심 0.5)인지 → 렌더 불필요.
function isIdentity(table) {
  const tr = table.tracks.main;
  if (!tr) return true;
  return tr.keys.every((k) => Math.abs(k.scale - 1) < 1e-4 && Math.abs(k.cx - 0.5) < 1e-4 && Math.abs(k.cy - 0.5) < 1e-4);
}

function parseFps(s) {
  if (!s) return 0;
  const m = String(s).trim().match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  return Number(s) || 0;
}

function probe(fp, file, entry) {
  return probeRaw(fp, file, entry).then((a) => a.map(Number));
}
function probeRaw(fp, file, entry) {
  return new Promise((res) => {
    const pr = spawn(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", entry, "-of", "default=nw=1:nk=1", file]);
    let out = "";
    pr.stdout.on("data", (d) => (out += d));
    pr.on("close", () => res(out.trim().split(/\s+/).filter(Boolean)));
    pr.on("error", () => res([]));
  });
}
function run(ff, args, cwd) {
  return new Promise((res, rej) => {
    const pr = spawn(ff, args, { cwd });
    let err = "";
    pr.stderr.on("data", (d) => {
      err += d;
      if (err.length > 8000) err = err.slice(-8000);
    });
    pr.on("error", rej);
    pr.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}: ${err.slice(-400)}`))));
  });
}
