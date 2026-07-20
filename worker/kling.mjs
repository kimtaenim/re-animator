// ============================================================================
// Kling(클링) image-to-video 프로바이더 — Grok 대안 I2V. 스펙 §4 동작 보간(first/last
// frame)과 더 나은 품질 때문에 채택. grok.mjs 와 같은 인터페이스(교체 가능).
// ----------------------------------------------------------------------------
// ★공식 Kling API 2.0 (문서 확인, kling.ai/document-api). 구형과 계약이 다르다:
//   Create:  POST https://api-singapore.klingai.com/image-to-video/{model}   (모델=경로)
//     header: Authorization: Bearer <API_KEY>
//     body: { contents:[{type:"prompt",text}, {type:"first_frame",url}, {type:"last_frame",url?}],
//             settings:{ resolution, duration(3~15 정수), audio:"off", multi_shot:false } }
//     → { code, data:{ id, status: submitted|processing|succeeded|failed } }
//   Query:   GET  https://api-singapore.klingai.com/tasks?task_ids={id}
//     → { code, data:[{ id, status, message, outputs:[{type:"video", url, duration}] }] }
//   ★last_frame = 끝 프레임 → 첫+끝 프레임 동작 보간(Grok 미지원이라 Kling 채택 이유).
//   ★duration 은 3~15 정수. 더 짧은 티어는 다운스트림에서 트림(스펙 §5).
// 인증: 단일 API Key(Bearer). (AK/SK→JWT 는 legacy 폴백.)
// 필요 env(Render 워커): KLING_API_KEY, KLING_VIDEO_MODEL(선택, 기본 kling-3.0).
// ============================================================================
import { createHmac } from "node:crypto";

const BASE = process.env.KLING_API_BASE || "https://api-singapore.klingai.com";
const TIMEOUT_MS = 60_000;
// 모델은 경로 세그먼트. 유효값(문서 사이드바): kling-3.0(HOT)·kling-3.0-turbo·kling-o1·kling-2.6·kling-2.5-turbo.
const KLING_VIDEO_MODEL = process.env.KLING_VIDEO_MODEL || "kling-3.0";
const KLING_RESOLUTION = process.env.KLING_VIDEO_RESOLUTION || "720p"; // 720p|1080p|4k. 합성서 프로젝트 비율로 재크롭.
// 초당 단가(USD, 대략). 모델·해상도로 다름. env 로 조정.
export const KLING_VIDEO_COST = Number(process.env.KLING_VIDEO_COST || 0.075);

// Authorization Bearer 토큰. 신형=단일 API Key 그대로. 레거시=AK/SK→JWT.
function authToken() {
  const apiKey = process.env.KLING_API_KEY;
  if (apiKey) return apiKey; // ★신형(권장): Authorization: Bearer <API_KEY>
  const ak = process.env.KLING_ACCESS_KEY;
  const sk = process.env.KLING_SECRET_KEY;
  if (ak && sk) return klingJwt(ak, sk); // 레거시: AK/SK→JWT
  throw new Error("KLING_API_KEY 없음(Render 워커 환경변수에 넣어주세요) — 또는 레거시 KLING_ACCESS_KEY/SECRET_KEY");
}
// (레거시) AK/SK → JWT(HS256). payload: iss=AK, exp=+30분, nbf=-5초. 무의존(node:crypto).
function klingJwt(ak, sk) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({ iss: ak, exp: now + 1800, nbf: now - 5 });
  const data = `${head}.${payload}`;
  const sig = createHmac("sha256", sk).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function klingError(status, bodyText) {
  let detail = bodyText;
  try {
    const j = JSON.parse(bodyText);
    detail = String(j.message ?? j.error ?? j.msg ?? bodyText);
  } catch {
    /* keep raw */
  }
  if (status === 401 || status === 403 || /auth|token|jwt|signature|unauthor|api key/i.test(detail))
    return "Kling 인증 실패 — KLING_API_KEY 확인(콘솔 발급 키·Bearer).";
  if (status === 429 || /rate limit|too many|concurren|qps/i.test(detail))
    return "Kling 요청 한도 초과 — 동시 생성 수를 줄이세요(VIDEO_CONCURRENCY 낮추기).";
  if (/balance|credit|quota|insufficient|resource pack|arrears/i.test(detail))
    return "Kling 잔액/크레딧 부족 — 콘솔에서 결제·리소스팩 확인.";
  if (/moderation|risk|sensitive|content|policy|safety|illegal/i.test(detail))
    return "콘텐츠 정책 거부(영상). 이 컷 이미지/프롬프트를 더 순화해 보세요.";
  return `Kling ${status}: ${String(detail).slice(0, 200)}`;
}

// ── 레이트 게이트(동시성 제한 대비) ────────────────────────────────────────────
const MIN_INTERVAL_MS = Number(process.env.KLING_MIN_INTERVAL_MS || 400);
let lastReqAt = 0;
let gateChain = Promise.resolve();
function rateGate() {
  const p = gateChain.then(async () => {
    const wait = lastReqAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastReqAt = Date.now();
  });
  gateChain = p.catch(() => {});
  return p;
}
async function fetchRetry(url, opts, tries = 4) {
  for (let i = 0; ; i++) {
    await rateGate();
    const r = await fetch(url, opts);
    if ((r.status === 429 || r.status === 503) && i < tries) {
      const ra = Number(r.headers.get("retry-after"));
      const waitMs = (ra > 0 ? ra : Math.min(8, 2 ** (i + 1))) * 1000;
      await new Promise((res) => setTimeout(res, waitMs));
      continue;
    }
    return r;
  }
}

// Kling API 2.0 duration 은 3~15 정수. 목표 길이를 그 범위로 반올림·클램프.
function klingDuration(seconds) {
  const s = Math.round(Number(seconds) || 5);
  return Math.max(3, Math.min(15, s));
}

async function submit({ imageUrl, imageTailUrl, prompt, duration }) {
  const contents = [];
  if (prompt) contents.push({ type: "prompt", text: String(prompt).slice(0, 2500) });
  contents.push({ type: "first_frame", url: imageUrl }); // 필수
  if (imageTailUrl) contents.push({ type: "last_frame", url: imageTailUrl }); // ★끝 프레임(동작 보간)
  const body = {
    contents,
    settings: { resolution: KLING_RESOLUTION, duration: klingDuration(duration), audio: "off", multi_shot: false },
  };
  const r = await fetchRetry(`${BASE}/image-to-video/${KLING_VIDEO_MODEL}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(klingError(r.status, await r.text().catch(() => "")));
  const d = await r.json().catch(() => ({}));
  if (typeof d.code === "number" && d.code !== 0) throw new Error(klingError(200, JSON.stringify(d)));
  const id = d.data?.id ?? d.data?.task_id ?? d.data?.[0]?.id;
  if (!id) throw new Error("Kling 제출 실패 — task id 없음");
  return String(id);
}

async function poll(taskId) {
  const r = await fetchRetry(`${BASE}/tasks?task_ids=${encodeURIComponent(taskId)}`, {
    headers: { authorization: `Bearer ${authToken()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) return { status: "failed", error: klingError(r.status, await r.text().catch(() => "")) };
  const d = await r.json().catch(() => ({}));
  // data 는 배열(By task ID) 또는 {result:[...]}(By cursor). 방어적으로 첫 태스크 추출.
  const task = Array.isArray(d.data) ? d.data[0] : (d.data?.result?.[0] ?? d.data);
  const st = String(task?.status ?? "").toLowerCase();
  if (st === "succeeded" || st === "succeed" || st === "success" || st === "completed") {
    const outs = task.outputs ?? [];
    const vid = outs.find((o) => o.type === "video" && o.url) ?? outs.find((o) => o.url);
    const url = vid?.url ?? null;
    if (!url) return { status: "failed", error: "Kling 결과에 비디오 URL 없음" };
    return { status: "completed", videoUrl: url };
  }
  if (st === "failed" || st === "error")
    return { status: "failed", error: klingError(200, task?.message || "Kling 생성 실패") };
  return { status: "running" };
}

// 제출 → 완료까지 폴링(최대 10분) → 비디오 URL. grokVideoFromImage 와 같은 시그니처(+imageTailUrl).
export async function klingVideoFromImage({ imageUrl, imageTailUrl, prompt, duration }, onTick) {
  const id = await submit({ imageUrl, imageTailUrl, prompt, duration });
  const started = Date.now();
  const maxMs = 10 * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 6000));
    const s = await poll(id);
    if (s.status === "completed") return s.videoUrl;
    if (s.status === "failed") throw new Error(s.error || "Kling 실패");
    if (Date.now() - started > maxMs) throw new Error("Kling 타임아웃(10분)");
    if (onTick) await onTick().catch(() => {});
  }
}
