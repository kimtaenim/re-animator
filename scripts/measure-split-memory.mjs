// 분할 파이프라인 메모리 측정 — 실제 imaging.mjs/ocr.mjs 를 실행해 피크 RSS 를 잰다.
// OOM 의 '이유'를 숫자로 잡기 위한 도구: 같은 총 높이를 (A) 통짜 파일 2개 (B) 잘게 8개로
// 나눠 돌려, 파일 모양이 메모리를 얼마나 바꾸는지 + 단계별 어디서 피크가 오는지 본다.
// API 키 불필요(픽셀 경로만). 사용:
//   node scripts/measure-split-memory.mjs <파일수> <파일높이px> [컷수]
// env: RAW_CACHE_MB(캐시 예산, 기본 160), OCR 준비 보유는 실제와 동일(48MB·4개).
import sharp from "../worker/node_modules/sharp/lib/index.js";
import { computeRowProfile, extractRegion, trimBox, rawCacheStats } from "../worker/imaging.mjs";
import { prepareOcrImage } from "../worker/ocr.mjs";

if (process.env.SHARP_NOCACHE) sharp.cache(false); // libvips 연산 캐시 영향 측정용
if (process.env.SHARP_CONC) sharp.concurrency(Number(process.env.SHARP_CONC)); // 스레드 수 영향 측정용

const NFILES = Number(process.argv[2] || 2);
const FILE_H = Number(process.argv[3] || 20000);
const NCUTS = Number(process.argv[4] || 15);
const SRC_W = 1600;
const REF_W = 1500;

let peak = 0;
let peakStage = "";
let stage = "init";
const stagePeak = {};
const tick = () => {
  const rss = process.memoryUsage.rss();
  if (rss > peak) { peak = rss; peakStage = stage; }
  stagePeak[stage] = Math.max(stagePeak[stage] ?? 0, rss);
};
const iv = setInterval(tick, 25);
const MB = (b) => Math.round(b / 1048576);
const say = (m) => console.log(`  [${MB(process.memoryUsage.rss())}MB rss] ${m}`);

// 1) 합성 원고 생성 — 노이즈+수평 밴드(거터 흉내). 실제 웹툰 raw 와 같은 크기의 디코드를 유발.
stage = "원고생성";
const files = [];
for (let i = 0; i < NFILES; i++) {
  const raw = Buffer.alloc(SRC_W * FILE_H * 3);
  for (let j = 0; j < raw.length; j += 3) {
    const y = Math.floor(j / 3 / SRC_W);
    const gutter = y % 1400 < 60; // 주기적 거터(단색)
    const v = gutter ? 250 : 40 + ((j * 2654435761) % 160); // 노이즈(압축 안 되게)
    raw[j] = v; raw[j + 1] = v; raw[j + 2] = v;
  }
  files.push(await sharp(raw, { raw: { width: SRC_W, height: FILE_H, channels: 3 } }).png().toBuffer());
}
const filesPngMB = MB(files.reduce((n, b) => n + b.length, 0));
say(`파일 ${NFILES}개 × ${FILE_H}px 생성(PNG 합 ${filesPngMB}MB)`);

// 2) 캔버스(runSplit 과 동일 구조)
const normH = Math.round(FILE_H * (REF_W / SRC_W));
const canvas = {
  refWidth: REF_W,
  totalHeight: normH * NFILES,
  offsets: files.map((_, i) => i * normH),
};

// 3) 행 프로파일(파일별 순차) — runSplit 1단계와 동일
stage = "프로파일";
for (let i = 0; i < NFILES; i++) await computeRowProfile(files[i], REF_W);
say("행 프로파일 완료");

// 4) 컷 경계(합성: 총높이를 균등 분할 — 실제 15컷과 유사 크기)
const cutH = Math.floor(canvas.totalHeight / NCUTS);
const regions = Array.from({ length: NCUTS }, (_, i) => ({
  yStart: i * cutH, yEnd: (i + 1) * cutH, xStart: 0, xEnd: REF_W,
}));

// 5) 여백 트림 — extractRegion + trimBox (runSplit 3단계와 동일)
stage = "여백트림";
for (const r of regions) {
  const png = await extractRegion(canvas, files, r.yStart, r.yEnd, r.xStart, r.xEnd);
  await trimBox(png);
}
say(`여백 트림 ${NCUTS}컷 완료 · raw캐시 ${rawCacheStats().mb}MB(${rawCacheStats().files}개)`);

// 6) OCR 준비/보유 — runSplit 대사읽기와 동일 semantics(준비 순차, 보유 48MB·4개, 응답 대기 흉내)
stage = "OCR보유";
const NET = 4;
const BUDGET = 48 * 1024 * 1024;
const inflight = new Set();
let held = 0;
for (const r of regions) {
  while (inflight.size >= NET || held >= BUDGET) await Promise.race(inflight);
  const png = await extractRegion(canvas, files, r.yStart, r.yEnd, r.xStart, r.xEnd);
  const img = await prepareOcrImage(png);
  held += img.length;
  const p = new Promise((res) => setTimeout(res, 400)) // VLM 응답 대기 흉내(이미지 보유 시간)
    .finally(() => { held -= img.length; inflight.delete(p); });
  inflight.add(p);
}
await Promise.all([...inflight]);
say(`OCR 준비/보유 ${NCUTS}컷 완료 · raw캐시 ${rawCacheStats().mb}MB(${rawCacheStats().files}개)`);

clearInterval(iv);
tick();
console.log(`\n== 파일 ${NFILES}개×${FILE_H}px · 컷 ${NCUTS} · RAW_CACHE_MB=${process.env.RAW_CACHE_MB ?? "(기본160)"} ==`);
for (const [s, v] of Object.entries(stagePeak)) console.log(`  ${s.padEnd(6)} 피크 ${MB(v)}MB`);
console.log(`  ★전체 피크 ${MB(peak)}MB (${peakStage} 단계)`);
