// ============================================================================
// Kling(클링) image-to-video 프로바이더 — Grok 대안 I2V. 스펙 §4 동작 보간(first/last
// frame)과 더 나은 품질 때문에 채택. grok.mjs 와 같은 인터페이스(교체 가능).
// ----------------------------------------------------------------------------
// 공식 API (klingai.com, 직접 가입 AK/SK):
//   POST https://api-singapore.klingai.com/v1/videos/image2video
//        { model_name, image, image_tail?, prompt?, negative_prompt?, cfg_scale?, mode, duration }
//        → { code, message, data: { task_id, task_status } }
//   GET  https://.../v1/videos/image2video/{task_id}
//        → { data: { task_status: submitted|processing|succeed|failed, task_result:{ videos:[{url}] } } }
//   ★image_tail = 끝 프레임 → 첫+끝 프레임 동작 보간(Grok 은 미지원이라 Kling 채택 이유).
//   ★duration 은 "5" 또는 "10"(초)만. 짧은 티어는 다운스트림에서 트림(스펙 §5).
// 인증(공식 Kling API 2.0, 문서 확인): **단일 API Key** 를 `Authorization: Bearer <KEY>` 로.
//   (AK/SK→JWT 는 legacy — 있으면 폴백 지원.) 필요 env: KLING_API_KEY (또는 레거시 AK/SK).
// 필요 env(Render 워커): KLING_API_KEY, KLING_VIDEO_MODEL(선택).
// ============================================================================
import { createHmac } from "node:crypto";

const BASE = process.env.KLING_API_BASE || "https://api-singapore.klingai.com";
const PATH = "/v1/videos/image2video";
const TIMEOUT_MS = 60_000;
const KLING_VIDEO_MODEL = process.env.KLING_VIDEO_MODEL || "kling-v2-1";
const KLING_MODE = process.env.KLING_VIDEO_MODE || "pro"; // std | pro
// 초당 단가(USD, 대략). pro ~$0.075/s. 길이 × 이 값이 대략 비용. env 로 조정.
export const KLING_VIDEO_COST = Number(process.env.KLING_VIDEO_COST || 0.075);

// Authorization 에 넣을 Bearer 토큰. 신형=단일 API Key 그대로. 레거시=AK/SK→JWT.
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
  if (status === 401 || status === 403 || /auth|token|jwt|signature|unauthor/i.test(detail))
    return "Kling 인증 실패 — KLING_ACCESS_KEY/SECRET_KEY 확인(JWT 서명·만료).";
  if (status === 429 || /rate limit|too many|concurren|qps/i.test(detail))
    return "Kling 요청 한도 초과 — 동시 생성 수를 줄이세요(VIDEO_CONCURRENCY 낮추기).";
  if (/balance|credit|quota|insufficient|resource pack/i.test(detail))
    return "Kling 잔액/크레딧 부족 — 콘솔에서 결제·리소스팩 확인.";
  if (/moderation|risk|sensitive|content|policy|safety|illegal/i.test(detail))
    return "콘텐츠 정책 거부(영상). 이 컷 이미지/프롬프트를 더 순화해 보세요.";
  return `Kling ${status}: ${String(detail).slice(0, 200)}`;
}

// ── 레이트 게이트(동시성 제한 대비, grok 과 동일 철학) ─────────────────────────
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

// Kling duration 은 5|10 초만. 목표 길이를 그 중 가까운(올림) 값으로.
function klingDuration(seconds) {
  const s = Number(seconds) || 5;
  return s > 5 ? "10" : "5";
}

async function submit({ imageUrl, imageTailUrl, prompt, duration }) {
  const body = {
    model_name: KLING_VIDEO_MODEL,
    image: imageUrl,
    mode: KLING_MODE,
    duration: klingDuration(duration),
  };
  if (imageTailUrl) body.image_tail = imageTailUrl; // ★끝 프레임(동작 보간)
  if (prompt) body.prompt = String(prompt).slice(0, 2500);
  const r = await fetchRetry(`${BASE}${PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(klingError(r.status, await r.text().catch(() => "")));
  const d = await r.json().catch(() => ({}));
  if (typeof d.code === "number" && d.code !== 0) throw new Error(klingError(200, JSON.stringify(d)));
  const id = d.data?.task_id ?? d.task_id ?? d.data?.id;
  if (!id) throw new Error("Kling 제출 실패 — task_id 없음");
  return String(id);
}

async function poll(taskId) {
  const r = await fetchRetry(`${BASE}${PATH}/${taskId}`, {
    headers: { authorization: `Bearer ${authToken()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) return { status: "failed", error: klingError(r.status, await r.text().catch(() => "")) };
  const d = await r.json().catch(() => ({}));
  const data = d.data ?? d;
  const st = String(data.task_status ?? "").toLowerCase();
  if (st === "succeed" || st === "completed" || st === "success") {
    const vids = data.task_result?.videos ?? data.videos ?? [];
    const url = vids[0]?.url ?? data.task_result?.url ?? null;
    if (!url) return { status: "failed", error: "Kling 결과에 비디오 URL 없음" };
    return { status: "completed", videoUrl: url };
  }
  if (st === "failed" || st === "error")
    return { status: "failed", error: klingError(200, data.task_status_msg || data.message || "Kling 생성 실패") };
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
