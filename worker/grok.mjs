// ============================================================================
// xAI(Grok) image-to-video 프로바이더 — 재생성 컷(generatedImage) → 영상(I2V).
// ----------------------------------------------------------------------------
// API(aninews lib/grok.ts 와 동일 계약):
//   POST https://api.x.ai/v1/videos/generations { model, image:{url}, prompt?, duration? }
//        → { request_id }
//   GET  https://api.x.ai/v1/videos/{request_id} → { status, video:{url} | url | video_url }
// submit→poll 패턴. 워커 잡 안에서 완료까지 동기 대기(단일 스레드라 그 동안 점유).
// 필요: XAI_API_KEY (Render 워커 환경변수). 모델·단가·동시성은 env 로 조정.
// ============================================================================

const API = "https://api.x.ai/v1";
const TIMEOUT_MS = 60_000;
const GROK_VIDEO_MODEL = process.env.XAI_VIDEO_MODEL || "grok-imagine-video";
export const GROK_VIDEO_COST = Number(process.env.XAI_VIDEO_COST || 0.1);

function key() {
  const k = process.env.XAI_API_KEY;
  if (!k) throw new Error("XAI_API_KEY 없음(Render 워커 환경변수에 넣어주세요)");
  return k;
}

function grokError(status, bodyText) {
  let detail = bodyText;
  try {
    const j = JSON.parse(bodyText);
    detail = String(j.error ?? j.detail ?? j.message ?? bodyText);
  } catch {
    /* keep raw */
  }
  if (/balance|credit|quota|insufficient/i.test(detail))
    return "Grok(xAI) 잔액/크레딧 부족 — console.x.ai 결제 확인.";
  if (/moderation|rejected|content|policy|safety|flag/i.test(detail))
    return "콘텐츠 정책 거부(영상). 이 컷 이미지/프롬프트를 더 순화해 보세요.";
  return `Grok ${status}: ${String(detail).slice(0, 200)}`;
}

async function submit({ imageUrl, prompt, duration }) {
  const body = { model: GROK_VIDEO_MODEL, image: { url: imageUrl } };
  if (prompt) body.prompt = prompt;
  if (typeof duration === "number") body.duration = duration;
  const r = await fetch(`${API}/videos/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(grokError(r.status, await r.text().catch(() => "")));
  const d = await r.json();
  const id = d.request_id ?? d.id;
  if (!id) throw new Error("Grok 제출 실패 — request_id 없음");
  return String(id);
}

async function poll(requestId) {
  const r = await fetch(`${API}/videos/${requestId}`, {
    headers: { authorization: `Bearer ${key()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) return { status: "failed", error: grokError(r.status, await r.text().catch(() => "")) };
  const d = await r.json();
  const status = String(d.status ?? "").toLowerCase();
  if (status === "done" || status === "completed" || status === "succeeded") {
    const url = d.video?.url ?? d.url ?? d.video_url ?? null;
    if (!url) return { status: "failed", error: "Grok 결과에 비디오 URL 없음" };
    return { status: "completed", videoUrl: url };
  }
  if (status === "failed" || status === "error")
    return { status: "failed", error: d.error ?? "Grok 생성 실패" };
  return { status: "running" };
}

// 제출 → 완료까지 폴링(최대 8분) → 비디오 URL. onTick 으로 진행 로그를 찍을 수 있다.
export async function grokVideoFromImage({ imageUrl, prompt, duration }, onTick) {
  const id = await submit({ imageUrl, prompt, duration });
  const started = Date.now();
  const maxMs = 8 * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await poll(id);
    if (s.status === "completed") return s.videoUrl;
    if (s.status === "failed") throw new Error(s.error || "Grok 실패");
    if (Date.now() - started > maxMs) throw new Error("Grok 타임아웃(8분)");
    if (onTick) await onTick().catch(() => {});
  }
}
