// ============================================================================
// 합성(compose) 스모크 테스트 — push 전에 '터지는지' 를 실제로 확인한다.
// ----------------------------------------------------------------------------
// 왜: 내(어시스턴트) 실수 중 OOM 3회·ffmpeg 필터 오류가 전부 "실행해보지 않고 push" 때문에
// 사용자 프로덕션에서 처음 터졌다. 이 스크립트는 API 키 없이, 더미 영상·오디오로
// compose 의 오디오 조립·효과음 믹싱·자막·인코딩 경로를 그대로 돌려 다음을 확인한다:
//   1) ffmpeg 필터 문자열이 실제로 유효한가(문법·라벨 정합성)
//   2) 피크 메모리(RSS)가 얼마인가 — Render 워커 한도(512MB급) 대비 여유 확인
//   3) 출력 길이가 의도대로인가(트림·자막 길이)
//
// ★품질(번역·효과음 적절성·UI)은 이 테스트로 판단할 수 없다 — 그건 사람이 써봐야 안다.
//   이 테스트의 역할은 '사람이 알려준 걸 고치다 다른 게 터지는' 왕복을 없애는 것뿐이다.
//
// 사용: node scripts/smoke-compose.mjs
// ============================================================================

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// worker 모듈 import 용 더미 env — 실제 통신은 하지 않는다(모듈 로드만).
process.env.UPSTASH_REDIS_REST_URL ||= "https://dummy.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN ||= "dummy";
process.env.BLOB_READ_WRITE_TOKEN ||= "vercel_blob_rw_dummy_dummy";

const require = createRequire(join(process.cwd(), "worker", "package.json"));
const FFMPEG = process.env.FFMPEG_PATH || require("ffmpeg-static");
const FFPROBE = require("ffprobe-static").path;

const run = (bin, args) =>
  new Promise((res, rej) => {
    const p = spawn(bin, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", rej);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(`${bin} exit ${c}: ${err.slice(-400)}`))));
  });

const probe = (f) =>
  new Promise((res) => {
    const p = spawn(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => res(parseFloat(out.trim()) || 0));
  });

let peakRss = 0;
const rssTimer = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 100);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  OK  " : " FAIL "} ${name}${detail ? " — " + detail : ""}`);
};

const dir = await mkdtemp(join(tmpdir(), "smoke-compose-"));
try {
  console.log("합성 스모크 테스트 — 더미 소재 생성…");
  // 더미 영상 3개(1080p, 3초) + 대사 오디오 2개 + 효과음 2개
  for (let i = 0; i < 3; i++) {
    await run(FFMPEG, [
      "-y", "-f", "lavfi", "-i", `testsrc=size=1920x1080:rate=24:duration=3`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", join(dir, `v${i}.mp4`),
    ]);
  }
  for (let i = 0; i < 2; i++) {
    await run(FFMPEG, ["-y", "-f", "lavfi", "-i", `sine=frequency=${300 + i * 200}:duration=${1.5 + i}`, "-c:a", "aac", join(dir, `d${i}.m4a`)]);
  }
  for (let i = 0; i < 2; i++) {
    await run(FFMPEG, ["-y", "-f", "lavfi", "-i", `sine=frequency=${900 + i * 300}:duration=0.5`, "-c:a", "aac", join(dir, `s${i}.m4a`)]);
  }

  // ── ① 오디오 조립 = compose.mjs 와 동일한 필터 조립 로직(대사 concat + 효과음 겹치기) ──
  //    compose.mjs 를 바꿀 때 이 블록도 같이 맞춰야 한다(의도적 중복 — 워커를 import 하면
  //    Redis/Blob env 가 필요해 스모크가 무거워진다).
  const buildAudioArgs = (dlg, sfx, audioLen, vd, out) => {
    const args = ["-y"];
    for (const p of dlg) args.push("-i", p);
    for (const p of sfx) args.push("-i", p.path);
    const chains = [];
    const mix = [];
    if (dlg.length === 1) mix.push("[0:a]");
    else if (dlg.length > 1) {
      chains.push(`${dlg.map((_, j) => `[${j}:a]`).join("")}concat=n=${dlg.length}:v=0:a=1[dlg]`);
      mix.push("[dlg]");
    }
    const refLen = audioLen > 0 ? audioLen : vd || 3;
    sfx.forEach((sx, k) => {
      const at = sx.timing === "end" ? Math.max(0, refLen - 0.4) : sx.timing === "mid" ? refLen / 2 : 0;
      const ms = Math.round(at * 1000);
      chains.push(`[${dlg.length + k}:a]adelay=${ms}:all=1,volume=0.8[x${k}]`);
      mix.push(`[x${k}]`);
    });
    let label = mix[0];
    if (mix.length > 1) {
      chains.push(`${mix.join("")}amix=inputs=${mix.length}:duration=longest:dropout_transition=0,volume=1.3[mx]`);
      label = "[mx]";
    }
    args.push("-filter_complex", chains.join(";"), "-map", label, "-c:a", "aac", "-b:a", "128k", out);
    return args;
  };

  const cases = [
    { name: "대사2 + 효과음1", dlg: ["d0.m4a", "d1.m4a"], sfx: [{ f: "s0.m4a", timing: "start" }] },
    { name: "대사1 + 효과음1(end)", dlg: ["d0.m4a"], sfx: [{ f: "s1.m4a", timing: "end" }] },
    { name: "대사0 + 효과음2", dlg: [], sfx: [{ f: "s0.m4a", timing: "start" }, { f: "s1.m4a", timing: "mid" }] },
    { name: "대사3 + 효과음0(예전 동작)", dlg: ["d0.m4a", "d1.m4a", "d0.m4a"], sfx: [] },
  ];
  for (const [ci, c] of cases.entries()) {
    const out = join(dir, `a_${ci}.m4a`);
    try {
      await run(FFMPEG, buildAudioArgs(c.dlg.map((f) => join(dir, f)), c.sfx.map((x) => ({ path: join(dir, x.f), timing: x.timing })), 2.5, 3, out));
      const d = await probe(out);
      check(`오디오 조립: ${c.name}`, d > 0.2, `길이 ${d.toFixed(2)}s`);
    } catch (e) {
      check(`오디오 조립: ${c.name}`, false, String(e.message).slice(0, 200));
    }
  }

  // ── ② 자막 오버레이 + 트림 인코딩(compose 의 마지막 인코딩과 같은 형태) ──
  try {
    const capPng = join(dir, "cap.png");
    const sharp = require("sharp");
    await sharp({ create: { width: 900, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.55 } } }).png().toFile(capPng);
    const out = join(dir, "scene.mp4");
    const finalDur = 2.0; // 트림 대상(원본 3초 → 2초)
    await run(FFMPEG, [
      "-y", "-i", join(dir, "v0.mp4"), "-i", capPng, "-i", join(dir, "a_0.m4a"),
      "-filter_complex", "[0:v]scale=1280:720,setsar=1[bg];[bg][1:v]overlay=x=190:y=520:enable='between(t,0,2)'[v]",
      "-map", "[v]", "-map", "2:a", "-t", finalDur.toFixed(2), "-r", "24",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-shortest", out,
    ]);
    const d = await probe(out);
    check("자막 오버레이 + 트림 인코딩", Math.abs(d - finalDur) < 0.35, `요청 ${finalDur}s → 실제 ${d.toFixed(2)}s`);
  } catch (e) {
    check("자막 오버레이 + 트림 인코딩", false, String(e.message).slice(0, 200));
  }

  // ── ③ concat(씬 이어붙이기) ──
  try {
    const list = join(dir, "list.txt");
    await writeFile(list, [0, 1, 2].map((i) => `file '${join(dir, `v${i}.mp4`).replace(/\\/g, "/")}'`).join("\n"));
    const out = join(dir, "joined.mp4");
    await run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
    const d = await probe(out);
    check("씬 이어붙이기(concat -c copy)", d > 8, `길이 ${d.toFixed(2)}s (기대 ~9s)`);
  } catch (e) {
    check("씬 이어붙이기(concat -c copy)", false, String(e.message).slice(0, 200));
  }

  // ── ④ 영상 프롬프트 길이 — 엔진 상한 초과로 지시가 잘리지 않는지 ──
  try {
    const { buildVideoPrompt } = await import("../worker/jobs.mjs");
    const cast = [{ id: "c1", label: "캐릭터1", description: "young man, black hair, dark uniform", sceneIds: ["s1"] }];
    const story = "비극. 주인공은 칼에 찔려 죽어가는 중. 어둡고 무거운 톤.";
    const specs = [
      ["Kling/action", { type: "action", motionTier: "action", bubbles: [], promptDraft: "A kick lands.", motionPromptHint: "one kick" }, 2400],
      ["MiniMax/talk", { type: "person", motionTier: "talk", bubbles: [{ text: "끝이야", speakerId: "c1" }], promptDraft: "Rooftop face-off.", motionPromptHint: "subtle mouth" }, 1900],
      ["MiniMax/idle", { type: "background_crowd", motionTier: "idle", bubbles: [], promptDraft: "Empty street at dusk." }, 1900],
    ];
    for (const [nm, cut, budget] of specs) {
      const p = buildVideoPrompt(cut, ["c1"], story, cast, { budget });
      const fits = p.length <= budget;
      const hasNoRepeat = /NO REPETITION|exactly ONCE/i.test(p);
      const hasMouth = /mouth|speaking/i.test(p);
      check(`프롬프트 ${nm}`, fits && hasNoRepeat && hasMouth, `${p.length}/${budget}자 · 반복금지 ${hasNoRepeat ? "O" : "X"} · 입 ${hasMouth ? "O" : "X"}`);
    }
  } catch (e) {
    check("프롬프트 길이/필수지시", false, String(e.message).slice(0, 200));
  }
} finally {
  clearInterval(rssTimer);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
const mb = (n) => (n / 1024 / 1024).toFixed(0);
console.log("\n─────────────────────────────────────────");
console.log(`피크 메모리(RSS): ${mb(peakRss)}MB  ← Render 워커 한도(512MB급) 대비 여유 확인`);
console.log(`결과: ${results.length - failed.length}/${results.length} 통과`);
if (failed.length) {
  console.log("실패:");
  for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log("전부 통과 — 이 경로는 실제 ffmpeg 로 돌려 확인했습니다.");
