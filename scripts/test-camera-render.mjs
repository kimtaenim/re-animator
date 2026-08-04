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
  ok(rc.skipped && rc.layer === "C", "orbit(계층 C): 후처리 성분 없으면 스킵(궤도는 I2V)");

  // ── 4) ★오빗 + 줌 동시 적용(사용자 지정) — 궤도는 I2V, 줌은 후처리로 실제로 구워져야 한다 ──
  const orbitZoom = { ...resolveCameraWork("orbit", { duration_s: 3 }), zoom_rate_pct_per_s: 12, zoom_accel: 3 };
  const oz = join(dir, "oz.mp4");
  const rz = await renderCameraFx({ ff, fp, dir, inPath: clip, outPath: oz, cameraWork: orbitZoom });
  ok(!rz.skipped, "orbit+줌: 스킵하지 않고 굽는다");
  await stat(oz);
  const [ozd] = await probe(oz, "format=duration");
  ok(Math.abs(Number(ozd) - 3) < 0.3, `orbit+줌 출력 길이 ~3s (실제 ${Number(ozd).toFixed(2)})`);
  const psz = await capture(ff, ["-hide_banner", "-i", oz, "-i", clip, "-lavfi", "psnr", "-f", "null", "-"]);
  const avgz = psz.match(/average:([0-9.]+|inf)/);
  ok(avgz && avgz[1] !== "inf", `orbit+줌이 화면을 실제로 변경(psnr average=${avgz?.[1]})`);

  // ── 5) ★계층 B(버티고·패럴랙스) 2레이어 — 인물 매트로 인물/배경을 따로 움직인다 ──
  //   매트가 없으면 스킵(무엇이 없는지 알려줘야 함), 있으면 실제로 구워져야 한다.
  const rbNo = await renderCameraFx({ ff, fp, dir, inPath: clip, outPath: join(dir, "bn.mp4"), cameraWork: resolveCameraWork("vertigo", { duration_s: 3 }) });
  ok(rbNo.skipped && rbNo.needsMatte, "계층 B: 매트 없으면 스킵 + '매트 필요' 표시");

  // 합성 매트(가운데 흰 사각형 = 인물, 나머지 검정 = 배경).
  const matte = join(dir, "matte.png");
  await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}`,
    "-vf", `drawbox=x=${Math.round(W * 0.35)}:y=${Math.round(H * 0.2)}:w=${Math.round(W * 0.3)}:h=${Math.round(H * 0.7)}:color=white:t=fill`,
    "-frames:v", "1", matte]);

  // ★매트만 있고 클린 플레이트(배경판)가 없으면 스킵 — 원본 프레임을 배경으로 쓰면
  //   인물 복사본이 겹쳐 보이는 구조 결함(사용자 보고)이라, 겹친 결과물을 만들지 않는다.
  const rbMatteOnly = await renderCameraFx({ ff, fp, dir, inPath: clip, outPath: join(dir, "bm.mp4"), mattePath: matte, cameraWork: resolveCameraWork("vertigo", { duration_s: 3 }) });
  ok(rbMatteOnly.skipped && rbMatteOnly.needsMatte, "계층 B: 배경판 없으면 스킵(겹침 방지 — 원본 프레임을 배경으로 안 씀)");

  // 클린 플레이트 = 초록 단색(식별용) — 출력 배경이 '판'에서 왔는지 픽셀로 검증할 수 있다.
  const plate = join(dir, "plate.png");
  await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=green:s=${W}x${H}`, "-frames:v", "1", plate]);
  const bOut = join(dir, "b2.mp4");
  const rbYes = await renderCameraFx({ ff, fp, dir, inPath: clip, outPath: bOut, mattePath: matte, platePath: plate, cameraWork: resolveCameraWork("vertigo", { duration_s: 3 }) });
  ok(!rbYes.skipped && rbYes.layer === "B", "계층 B: 매트+배경판이 있으면 2레이어로 굽는다");
  await stat(bOut);
  const [bdur] = await probe(bOut, "format=duration");
  ok(Math.abs(Number(bdur) - 3) < 0.5, `계층 B 출력 길이 ~3s (실제 ${Number(bdur).toFixed(2)})`);
  const [bw, bh] = await probe(bOut, "stream=width,height");
  ok(Number(bw) === W && Number(bh) === H, `계층 B 출력 해상도 ${bw}x${bh}`);
  const psb = await capture(ff, ["-hide_banner", "-i", bOut, "-i", clip, "-lavfi", "psnr", "-f", "null", "-"]);
  const avgb = psb.match(/average:([0-9.]+|inf)/);
  ok(avgb && avgb[1] !== "inf", `계층 B 가 화면을 실제로 변경(psnr average=${avgb?.[1]})`);
  // ★겹침 원천 차단 검증 — 화면 구석(인물 밖)은 '초록 배경판'이어야 한다.
  //   예전 구조(배경=원본 프레임)라면 여기 testsrc 색 막대가 보인다(= 인물·배경 이중 겹침의 근원).
  const cs = await capture(ff, ["-hide_banner", "-ss", "1", "-i", bOut, "-frames:v", "1",
    "-vf", "crop=32:32:4:4,signalstats,metadata=print", "-f", "null", "-"]);
  const uavg = Number((cs.match(/signalstats\.UAVG=([0-9.]+)/) || [])[1]);
  const vavg = Number((cs.match(/signalstats\.VAVG=([0-9.]+)/) || [])[1]);
  // green(#008000) 의 YUV ≈ U86·V74 (원본 testsrc 구석은 백색 계열 ≈ U128·V128) — 105 를 경계로 판별.
  ok(isFinite(uavg) && isFinite(vavg) && uavg < 105 && vavg < 105,
    `계층 B 배경이 클린 플레이트에서 옴(구석 UAVG=${uavg}·VAVG=${vavg} — 초록, 원본 프레임 아님)`);
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
