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

// ★호스트 failover — MiniMax 는 같은 API 를 여러 도메인으로 서비스한다(전부 동일 응답 확인).
//   Render 리전에서 한 도메인이 막히면 "fetch failed" 로 컷이 통째로 날아가므로, 순서대로
//   시도하고 성공한 호스트를 기억해 이후 호출은 바로 그걸 쓴다.
const BASES = [
  process.env.MINIMAX_API_BASE,
  "https://api.minimax.io",
  "https://api.minimaxi.com",
  "https://api.minimaxi.chat",
].filter(Boolean);
let _goodBase = null; // 마지막으로 성공한 호스트(있으면 우선)
const TIMEOUT_MS = 60_000;
const MINIMAX_MODEL = process.env.MINIMAX_VIDEO_MODEL || "MiniMax-Hailuo-2.3";
// ★768P — 최종 출력이 720p 급(targetDims)이라 1080P 는 디코딩 비용만 내고 버려진다.
//   1080P 로 두었다가 워커 OOM 반복. 필요 시 env MINIMAX_VIDEO_RESOLUTION=1080P.
const MINIMAX_RESOLUTION = process.env.MINIMAX_VIDEO_RESOLUTION || "768P"; // 768P|1080P
// 초당 단가(USD, 대략). env 로 조정.
export const MINIMAX_VIDEO_COST = Number(process.env.MINIMAX_VIDEO_COST || 0.045);

// ★env 이름 흔들림 흡수 — 키를 넣었는데도 '없음'으로 잡혀 Kling 으로 폴백되는 사고를 막는다.
//   MINIMAX_API_KEY 를 표준으로 두고, 흔한 변형들도 인정한다(대시보드에서 이름이 조금 달라도 동작).
const MM_KEY_NAMES = [
  "MINIMAX_API_KEY",
  "MINIMAX_KEY",
  "MINIMAX_API_TOKEN",
  "MINIMAX_TOKEN",
  "MINIMAXI_API_KEY",
  "MINI_MAX_API_KEY",
];
function findKey() {
  for (const n of MM_KEY_NAMES) {
    const v = (process.env[n] || "").trim();
    if (v) return v;
  }
  return "";
}

export function hasMinimax() {
  return !!findKey();
}

function apiKey() {
  const k = findKey();
  if (!k) throw new Error("MINIMAX_API_KEY 없음(Render 워커 환경변수에 넣어주세요)");
  return k;
}

// ★네트워크 오류 재시도 + 원인 노출.
//   Node fetch 는 연결 실패를 전부 "fetch failed" 로 뭉개고 진짜 이유(ENOTFOUND·ECONNRESET·
//   ENETUNREACH·인증서 등)를 err.cause 에 숨긴다 → 로그만 봐선 고칠 수가 없다(실제 사고).
//   여기서 cause 코드를 메시지에 담고, 일시적 오류는 지수 백오프로 재시도한다.
//   path = "/v1/..." 형태. 성공한 호스트를 _goodBase 에 캐시한다.
async function mmFetch(path, opts, tries = 2) {
  const order = _goodBase ? [_goodBase, ...BASES.filter((b) => b !== _goodBase)] : BASES;
  const errs = [];
  for (const base of order) {
    for (let i = 0; i <= tries; i++) {
      try {
        const r = await fetch(`${base}${path}`, opts);
        // 5xx 는 그 호스트 문제일 수 있으니 재시도 후 다음 호스트로.
        if ((r.status === 429 || r.status === 503) && i < tries) {
          await new Promise((res) => setTimeout(res, Math.min(8, 2 ** (i + 1)) * 1000));
          continue;
        }
        if (r.status >= 500 && i >= tries) {
          errs.push(`${new URL(base).host}:HTTP${r.status}`);
          break; // 다음 호스트 시도
        }
        _goodBase = base; // 응답 받았으면 이 호스트는 살아있음
        return r;
      } catch (e) {
        const code = e?.cause?.code || e?.cause?.errno || e?.code || e?.message || "unknown";
        errs.push(`${new URL(base).host}:${code}`);
        // 주소·인증서 오류는 이 호스트에선 재시도 무의미 → 즉시 다음 호스트로.
        if (/ENOTFOUND|EAI_AGAIN|CERT|DEPTH_ZERO|ERR_TLS/i.test(String(code))) break;
        if (i >= tries) break;
        await new Promise((res) => setTimeout(res, Math.min(8, 2 ** (i + 1)) * 1000));
      }
    }
  }
  // 모든 호스트 실패 — 어디서 왜 막혔는지 메시지에 담는다(Node 의 "fetch failed" 는 원인을 숨긴다).
  throw new Error(`MiniMax 연결 실패 — ${errs.join(", ")}`);
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

// ★끝 프레임 모델 — first+last 프레임은 Hailuo-02 만 지원(2.3 은 미지원, 문서 확인).
const MINIMAX_TAIL_MODEL = process.env.MINIMAX_TAIL_MODEL || "MiniMax-Hailuo-02";

async function submit({ imageUrl, imageTailUrl, prompt, duration }) {
  // 끝 프레임이 있으면 그걸 지원하는 모델로 바꿔 보낸다.
  const model = imageTailUrl ? MINIMAX_TAIL_MODEL : MINIMAX_MODEL;
  const body = {
    model,
    prompt: String(prompt || "").slice(0, 2000),
    first_frame_image: imageUrl, // 공개 URL 그대로
    ...(imageTailUrl ? { last_frame_image: imageTailUrl } : {}),
    duration: minimaxDuration(duration),
    resolution: MINIMAX_RESOLUTION,
  };
  const r = await mmFetch(`/v1/video_generation`, {
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
  const r = await mmFetch(`/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`, {
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
  const r = await mmFetch(`/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`, {
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
//   ★imageTailUrl 지원 — 끝 프레임을 '첫 프레임과 같은 이미지'로 주면 클립이 원본 얼굴로
//   돌아와야 하므로 얼굴 표류가 구조적으로 묶인다(잔잔한 컷용). 다음 컷 이미지를 주면 동작 보간.
export async function minimaxVideoFromImage({ imageUrl, imageTailUrl, prompt, duration }, onTick) {
  const id = await submit({ imageUrl, imageTailUrl, prompt, duration });
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
