// ============================================================================
// MiniMax(Hailuo) image-to-video 프로바이더 — 일반 컷용(액션은 Kling). kling.mjs 와
// 같은 인터페이스(minimaxVideoFromImage). 교체·병행 가능.
// ----------------------------------------------------------------------------
// ★공식 MiniMax API (platform.minimax.io/docs/guides/video-generation, 문서 확인):
//   Create: POST https://api.minimax.io/v1/video_generation
//     header: Authorization: Bearer <MINIMAX_API_KEY>
//     body: { model, prompt, first_frame_image(URL 허용), duration, resolution }
//     → { task_id, base_resp:{ status_code, status_msg } }
//   Query:  GET https://api.minimax.io/v1/query/video_generation?task_id={id}
//     → { status: Queueing|Preparing|Processing|Success|Fail, file_id, base_resp }
//   File:   GET https://api.minimax.io/v1/files/retrieve?file_id={id}
//     → { file:{ download_url } }
//   ★3단계(task→file_id→download_url). first_frame_image 는 공개 URL 그대로 가능.
//   ★MiniMax 는 first+last 프레임 보간이 별도 모델이라, 여기선 first_frame 만(보간=Kling 담당).
// 필요 env(Render 워커): MINIMAX_API_KEY, MINIMAX_VIDEO_MODEL(선택, 기본 MiniMax-Hailuo-2.3).
// ★워커 자기완결 — ../lib import 금지.
// ============================================================================

const BASE = process.env.MINIMAX_API_BASE || "https://api.minimax.io";
const TIMEOUT_MS = 60_000;
const MINIMAX_MODEL = process.env.MINIMAX_VIDEO_MODEL || "MiniMax-Hailuo-2.3";
const MINIMAX_RESOLUTION = process.env.MINIMAX_VIDEO_RESOLUTION || "1080P"; // 768P|1080P. 합성서 프로젝트 비율로 재크롭.
// 초당 단가(USD, 대략). env 로 조정.
export const MINIMAX_VIDEO_COST = Number(process.env.MINIMAX_VIDEO_COST || 0.045);

export function hasMinimax() {
  return !!process.env.MINIMAX_API_KEY;
}

function apiKey() {
  const k = process.env.MINIMAX_API_KEY;
  if (!k) throw new Error("MINIMAX_API_KEY 없음(Render 워커 환경변수에 넣어주세요)");
  return k;
}

function minimaxError(status, bodyText) {
  let detail = bodyText;
  try {
    const j = JSON.parse(bodyText);
    detail = String(j.base_resp?.status_msg ?? j.status_msg ?? j.message ?? bodyText);
  } catch {
    /* keep raw */
  }
  if (status === 401 || status === 403 || /auth|token|unauthor|api key|invalid.*key/i.test(detail))
    return "MiniMax 인증 실패 — MINIMAX_API_KEY 확인.";
  if (status === 429 || /rate limit|too many|concurren|qps/i.test(detail))
    return "MiniMax 동시 한도/레이트리밋 — 잠시 후 재시도.";
  if (/moderation|risk|sensitive|policy|safety|illegal/i.test(detail))
    return `콘텐츠 정책 거부: ${detail.slice(0, 120)}`;
  return `MiniMax ${status}: ${String(detail).slice(0, 160)}`;
}

// MiniMax duration 은 모델별 정수(Hailuo-2.3 = 6 또는 10). 목표 길이를 그 셋 중 가까운 값으로.
function minimaxDuration(seconds) {
  const s = Number(seconds) || 6;
  return s <= 8 ? 6 : 10;
}

async function submit({ imageUrl, prompt, duration }) {
  const body = {
    model: MINIMAX_MODEL,
    prompt: String(prompt || "").slice(0, 2000),
    first_frame_image: imageUrl, // 공개 URL 그대로
    duration: minimaxDuration(duration),
    resolution: MINIMAX_RESOLUTION,
  };
  const r = await fetch(`${BASE}/v1/video_generation`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(minimaxError(r.status, await r.text().catch(() => "")));
  const d = await r.json().catch(() => ({}));
  const code = d.base_resp?.status_code;
  if (typeof code === "number" && code !== 0)
    throw new Error(minimaxError(200, JSON.stringify(d)));
  const id = d.task_id;
  if (!id) throw new Error("MiniMax 제출 실패 — task_id 없음");
  return String(id);
}

async function poll(taskId) {
  const r = await fetch(`${BASE}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`, {
    headers: { authorization: `Bearer ${apiKey()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) return { status: "failed", error: minimaxError(r.status, await r.text().catch(() => "")) };
  const d = await r.json().catch(() => ({}));
  const st = String(d.status ?? "").toLowerCase();
  if (st === "success") {
    if (!d.file_id) return { status: "failed", error: "MiniMax 성공했으나 file_id 없음" };
    return { status: "completed", fileId: String(d.file_id) };
  }
  if (st === "fail") return { status: "failed", error: minimaxError(200, JSON.stringify(d)) };
  return { status: "running" }; // Queueing|Preparing|Processing
}

// file_id → 다운로드 URL(3단계).
async function retrieve(fileId) {
  const r = await fetch(`${BASE}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`, {
    headers: { authorization: `Bearer ${apiKey()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(minimaxError(r.status, await r.text().catch(() => "")));
  const d = await r.json().catch(() => ({}));
  const url = d.file?.download_url ?? d.file?.url ?? null;
  if (!url) throw new Error("MiniMax 파일 조회 실패 — download_url 없음");
  return String(url);
}

// 제출 → 완료까지 폴링(최대 10분) → 비디오 URL. klingVideoFromImage 와 같은 시그니처.
//   imageTailUrl 은 MiniMax 기본 I2V 미지원이라 무시(보간 컷은 Kling 라우팅).
export async function minimaxVideoFromImage({ imageUrl, prompt, duration }, onTick) {
  const id = await submit({ imageUrl, prompt, duration });
  const started = Date.now();
  const maxMs = 10 * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000)); // 문서 권장 10초 간격
    const s = await poll(id);
    if (s.status === "completed") return await retrieve(s.fileId);
    if (s.status === "failed") throw new Error(s.error || "MiniMax 실패");
    if (Date.now() - started > maxMs) throw new Error("MiniMax 타임아웃(10분)");
    if (onTick) await onTick().catch(() => {});
  }
}
