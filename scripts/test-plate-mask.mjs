// ============================================================================
// 클린 플레이트 마스크 골든 테스트 — "인페인팅했는데 실루엣이 그대로 남는다" 재발 방지.
// ----------------------------------------------------------------------------
// 원인: 실루엣 모양 마스크는 인페인팅 모델에 '사람 형태' 힌트를 줘서 실루엣을 다시 그린다.
// 규칙(확정): 마스크는 인물 바운딩 박스 + 여유(각 변 10%·최소 16px)의 '사각형' — 모양 힌트 0.
// 실행: node scripts/test-plate-mask.mjs  (실제 sharp 실행 — fal 호출 없음·키 불필요)
// ============================================================================
process.env.UPSTASH_REDIS_REST_URL ||= "http://dummy";
process.env.UPSTASH_REDIS_REST_TOKEN ||= "dummy";
const { matteToBoxMask } = await import("../worker/matte.mjs");
import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(join(process.cwd(), "worker", "package.json"));
const sharp = require("sharp");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => (c ? (pass++, console.log("  OK   " + n)) : (fail++, console.log(" FAIL  " + n + (d ? " — " + d : ""))));

// 합성 매트 640x360 — 인물(흰) 사각형이 (200,80)~(360,320) 에 있다고 가정.
const W = 640, H = 360;
const person = { left: 200, top: 80, width: 160, height: 240 };
const white = await sharp({ create: { width: person.width, height: person.height, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
const matte = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
  .composite([{ input: white, left: person.left, top: person.top }]).png().toBuffer();

const { maskBuf, box } = await matteToBoxMask(matte);

console.log(`[박스] left=${box.left} top=${box.top} w=${box.width} h=${box.height} (인물 ${JSON.stringify(person)})`);
ok("박스가 인물 영역을 전부 덮음(여유 포함)",
  box.left <= person.left && box.top <= person.top &&
  box.left + box.width >= person.left + person.width && box.top + box.height >= person.top + person.height);
ok("여유가 과하지 않음(각 변 ≤ 25%)",
  person.left - box.left <= person.width * 0.25 + 4 && person.top - box.top <= person.height * 0.25 + 4);

// 마스크 픽셀 검증: 인물 중심 = 흰(지울 영역), 먼 구석 = 검정(보존).
const { data, info } = await sharp(maskBuf).toColourspace("b-w").raw().toBuffer({ resolveWithObject: true });
const at = (x, y) => data[(y * info.width + x) * info.channels];
ok("마스크 크기 = 매트 크기", info.width === W && info.height === H);
ok("인물 중심은 흰(지울 영역)", at(person.left + 80, person.top + 120) > 200);
ok("먼 구석은 검정(배경 보존)", at(4, 4) < 50 && at(W - 5, H - 5) < 50);
// ★실루엣 힌트 0 검증 — 박스 안은 '전부' 흰이어야 한다(인물 모양 경계가 남으면 안 됨).
ok("박스 내부가 균일한 사각형(실루엣 모양 아님)",
  at(box.left + 2, box.top + 2) > 200 && at(box.left + box.width - 3, box.top + box.height - 3) > 200 &&
  at(box.left + 2, box.top + box.height - 3) > 200 && at(box.left + box.width - 3, box.top + 2) > 200);

// 빈 매트 → 명시적 에러(조용한 실패 금지).
let threw = false;
try { await matteToBoxMask(await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer()); }
catch { threw = true; }
ok("빈 매트는 명시적 에러", threw);

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
