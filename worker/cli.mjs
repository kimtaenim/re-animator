// ============================================================================
// 로컬 검증 CLI — 샘플 웹툰으로 컷 분할을 앱·Redis·Blob 없이 바로 확인.
// ----------------------------------------------------------------------------
// 사용:  node cli.mjs <이미지파일 또는 폴더> ...
//   - 인자로 준 이미지들을 업로드 순서로 보고 프로파일→경계 검출.
//   - 검출된 컷 개수·경계 y 를 출력.
//   - ./scratch/ 에 (1) 경계 오버레이 미리보기, (2) 추출된 컷 PNG 들을 쓴다.
//   - config/split.json 값을 바꿔가며 눈으로 튜닝하는 용도(스펙 §16 M1 선검증).
// ============================================================================

import { readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname, basename } from "node:path";
import sharp from "sharp";
import { computeWhiteProfile, extractRegion } from "./imaging.mjs";
import { buildCanvas, pickRefWidth } from "./canvas.mjs";
import { detectRegions } from "./detect.mjs";
import { loadSplitConfig } from "./config.mjs";

const IMG = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

function collectImages(args) {
  const out = [];
  for (const a of args) {
    const st = statSync(a);
    if (st.isDirectory()) {
      for (const f of readdirSync(a).sort())
        if (IMG.has(extname(f).toLowerCase())) out.push(join(a, f));
    } else if (IMG.has(extname(a).toLowerCase())) {
      out.push(a);
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("사용: node cli.mjs <이미지파일|폴더> ...");
    process.exit(1);
  }
  const paths = collectImages(args);
  if (paths.length === 0) {
    console.error("이미지를 못 찾았어요.");
    process.exit(1);
  }
  console.log(`이미지 ${paths.length}개:`, paths.map((p) => basename(p)).join(", "));

  const cfg = loadSplitConfig();
  console.log("config:", cfg);

  // 폭 수집
  const widths = [];
  const buffers = [];
  for (const p of paths) {
    const buf = sharp(p);
    const meta = await buf.metadata();
    widths.push(meta.width);
    buffers.push(await sharp(p).toBuffer());
  }
  const refWidth = pickRefWidth(widths, cfg.refWidthMode);
  console.log(`기준폭 ${refWidth}px`);

  const profiles = [];
  const normHeights = [];
  for (let i = 0; i < buffers.length; i++) {
    const { profile, normHeight } = await computeWhiteProfile(buffers[i], refWidth, cfg);
    profiles.push(profile);
    normHeights.push(normHeight);
  }
  const canvas = buildCanvas(refWidth, normHeights);
  const global = new Float32Array(canvas.totalHeight);
  let acc = 0;
  for (const pr of profiles) {
    global.set(pr, acc);
    acc += pr.length;
  }

  const regions = detectRegions(global, cfg);
  console.log(`\n검출된 컷 ${regions.length}개:`);
  regions.forEach((r, i) =>
    console.log(`  #${i}  y ${r.yStart}–${r.yEnd}  (높이 ${r.yEnd - r.yStart})`)
  );

  const outDir = join(process.cwd(), "scratch");
  mkdirSync(outDir, { recursive: true });

  // 경계 오버레이 미리보기 — 전체를 refWidth/4 로 축소, 경계에 빨간 선.
  const previewW = Math.round(refWidth / 4);
  const scale = previewW / refWidth;
  const previewH = Math.max(1, Math.round(canvas.totalHeight * scale));
  const full = await extractRegion(canvas, buffers, 0, canvas.totalHeight);
  const lines = regions
    .slice(1)
    .map(
      (r) =>
        `<rect x="0" y="${Math.round(r.yStart * scale)}" width="${previewW}" height="2" fill="red"/>`
    )
    .join("");
  const svg = Buffer.from(
    `<svg width="${previewW}" height="${previewH}" xmlns="http://www.w3.org/2000/svg">${lines}</svg>`
  );
  const preview = await sharp(full)
    .resize({ width: previewW })
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toBuffer();
  writeFileSync(join(outDir, "boundaries.png"), preview);
  console.log(`\n경계 미리보기 → scratch/boundaries.png`);

  // 컷별 추출
  for (let i = 0; i < regions.length; i++) {
    const png = await extractRegion(canvas, buffers, regions[i].yStart, regions[i].yEnd);
    writeFileSync(join(outDir, `cut-${String(i).padStart(2, "0")}.png`), png);
  }
  console.log(`컷 ${regions.length}개 → scratch/cut-*.png`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
