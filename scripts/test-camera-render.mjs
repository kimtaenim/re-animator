// ============================================================================
// 통합 테스트 — worker/cameraRender.mjs (스펙 §2 계층 A, Phase 2)
//   실행: node scripts/test-camera-render.mjs
// 검증: sendcmd 스크립트 매핑(첫=풀프레임·끝=줌인) · 실제 ffmpeg 렌더 유효성
//       (해상도·길이) · 카메라가 실제로 화면을 바꿨는지(psnr≠∞) · 스킵 로직(static/B/C).
// 로컬 ffmpeg-static/ffprobe-static 사용. API 키 불필요.
// ============================================================================
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSendcmdScript, renderCameraFx } from "../worker/cameraRender.mjs";
import { buildKeyframeTable, resolveCameraWork } from "../lib/cameraKeyframes.mjs";

// ffmpeg-static/ffprobe-static 는 worker/node_modules 에 있음 → 명시 경로로 import.
const ff = (await import(new URL("../worker/node_modules/ffmpeg-static/index.js", import.meta.url))).default;
const fp = (await import(new URL("../worker/node_modules/ffprobe-static/index.js", import.meta.url))).default.path;

let pass = 0,
  fail = 0;
const ok = (c, m) => (c ? pass++ : (fail++, console.error("  ✗ FAIL:", m)));

function run(bin, args, cwd) {
  return new Promise((res, rej) => {
    const pr = spawn(bin, args, cwd ? { cwd } : {});
    let err = "";
    pr.stderr.on("data", (d) => (err += d));
    pr.on("error", rej);
    pr.on("close", (c) => (c === 0 ? res() : rej(new Error(`${bin} ${c}: ${err.slice(-400)}`))));
  });
}
function capture(bin, args) {
  return new Promise((res) => {
    const pr = spawn(bin, args);
    let out = "",
      err = "";
    pr.stdout.on("data", (d) => (out += d));
    pr.stderr.on("data", (d) => (err += d));
    pr.on("close", () => res(out + err));
  });
}
const probe = (file, entry) =>
  capture(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", entry, "-of", "default=nw=1:nk=1", file]).then((s) =>
    s.trim().split(/\s+/).filter(Boolean),
  );

console.log("== camera render integration test ==");
const W = 1280,
  H = 720;

// ── 1) sendcmd 스크립트 매핑(순수) ────────────────────────────────────────────
{
  const tb = buildKeyframeTable(resolveCameraWork("push_in", { duration_s: 3, shake_seed: 0 }), { fps: 24, refWidth: W, refHeight: H });
  const { script, first } = buildSendcmdScript(tb, W, H);
  const lines = script.trim().split("\n");
  ok(first.cropW === W && first.cropH === H && first.x === 0 && first.y === 0, "sendcmd 첫 프레임 = 풀프레임 crop");
  const lastMatch = lines[lines.length - 1].match(/crop w (\d+),/);
  ok(lastMatch && Number(lastMatch[1]) < W, `sendcmd 끝 프레임 줌인(cropW ${lastMatch?.[1]} < ${W})`);
  ok(lines.every((l) => /^\d+\.\d{3} crop w \d+, crop h \d+, crop x \d+, crop y \d+;$/.test(l)), "sendcmd 모든 줄 문법 유효");
  ok(lines.length === tb.frames, `sendcmd 줄 수 = 프레임 수(${tb.frames})`);
}

// ── 2) 실제 렌더 유효성 + 화면 변화(psnr) ─────────────────────────────────────
const dir = await mkdtemp(join(tmpdir(), "camtest-"));
try {
  const clip = join(dir, "in.mp4");
  await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=3", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", clip]);

  const out = join(dir, "out.mp4");
  const r = await renderCameraFx({
    ff, fp, dir, inPath: clip, outPath: out,
    cameraWork: resolveCameraWork("push_in", { duration_s: 3, zoom_rate_pct_per_s: 4 }),
    onLog: (m) => console.log("   [render]", m),
  });
  ok(!r.skipped, "push_in: 렌더됨(스킵 아님)");
  const [ow, oh] = await probe(out, "stream=width,height");
  ok(Number(ow) === W && Number(oh) === H, `출력 해상도 ${ow}x${oh} = ${W}x${H}`);
  const [odur] = await probe(out, "format=duration");
  ok(Math.abs(Number(odur) - 3) < 0.3, `출력 길이 ~3s (실제 ${Number(odur).toFixed(2)})`);
  await stat(out); // 존재 확인(없으면 throw)

  // psnr: 입력 vs 출력. 카메라가 화면을 바꿨으면 average ≠ inf.
  const ps = await capture(ff, ["-hide_banner", "-i", out, "-i", clip, "-lavfi", "psnr", "-f", "null", "-"]);
  const avg = ps.match(/average:([0-9.]+|inf)/);
  ok(avg && avg[1] !== "inf", `카메라가 화면을 실제로 변경(psnr average=${avg?.[1]})`);

  // ── 3) 스킵 로직 ────────────────────────────────────────────────────────────
  const rs = await renderCameraFx({ ff, fp, dir, inPath: clip, outPath: join(dir, "s.mp4"), cameraWork: resolveCameraWork("static", { duration_s: 3 }) });
  ok(rs.skipped, "static: 렌더 스킵");
  const rb = await renderCameraFx({ ff, fp, dir, inPath: clip, outPath: join(dir, "b.mp4"), cameraWork: resolveCameraWork("parallax_push", { duration_s: 3 }) });
  ok(rb.skipped && rb.layer === "B", "parallax_push(계층 B): 매트 미구현 스킵");
  const rc = await renderCameraFx({ ff, fp, dir, inPath: clip, outPath: join(dir, "c.mp4"), cameraWork: resolveCameraWork("orbit", { duration_s: 3 }) });
  ok(rc.skipped && rc.layer === "C", "orbit(계층 C): I2V 위임 스킵");
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
