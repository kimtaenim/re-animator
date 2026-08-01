// Redis 접근 (앱과 같은 키 스킴). 워커는 project 상태 + 잡 큐 + 진행 로그를 본다.
import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 필요");
  process.exit(1);
}
export const redis = new Redis({ url, token });

const projectKey = (id) => `project:${id}`;

export async function getProject(id) {
  return (await redis.get(projectKey(id))) ?? null;
}
export async function saveProject(p) {
  p.updatedAt = Date.now();
  await redis.set(projectKey(p.id), p);
}

// 큐: 앱이 lpush(jobq:<type>, id) + set(job:id). 워커는 rpop 으로 FIFO 소비.
export async function popJob(type) {
  const id = await redis.rpop(`jobq:${type}`);
  if (!id) return null;
  const job = await redis.get(`job:${id}`);
  return job ?? null;
}
// 워커가 스스로 후속 잡을 적재한다(앱과 같은 형식: set(job:id) + lpush(jobq:type)).
// ★긴 작업을 12분 잡 캡 안에 쪼개 '이어달리기'시키는 데 쓴다 — 캡을 넘기면 잡은 실패로
//   찍히는데 실제 작업은 계속 돌아 다음 잡과 겹치고, 메모리 빡빡한 워커가 OOM 난다.
export async function enqueueJob(type, projectId, payload = {}) {
  const id = randomUUID();
  const now = Date.now();
  await redis.set(`job:${id}`, {
    id,
    type,
    projectId,
    payload,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  });
  await redis.lpush(`jobq:${type}`, id);
  return id;
}

export async function updateJob(id, patch) {
  const cur = await redis.get(`job:${id}`);
  if (!cur) return;
  await redis.set(`job:${id}`, { ...cur, ...patch, updatedAt: Date.now() });
}

// 진행 로그 — 원격에서 lrange 로 추적(어느 파일/컷에서 멈췄는지).
const progKey = (projectId) => `split:progress:${projectId}`;
export async function resetProgress(projectId) {
  try {
    await redis.del(progKey(projectId));
  } catch {}
}
export async function logProgress(projectId, msg) {
  try {
    // 한국표준시(KST=UTC+9, DST 없음) — 워커 서버(UTC)라 +9h 시프트 후 HH:MM:SS.mmm.
    const line = `${new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(11, 23)} ${msg}`;
    await redis.rpush(progKey(projectId), line);
    await redis.expire(progKey(projectId), 3600);
  } catch {}
}
export async function getProgress(projectId) {
  try {
    return await redis.lrange(progKey(projectId), 0, -1);
  } catch {
    return [];
  }
}

// ── 더빙 전용 진행/진단 로그 ────────────────────────────────────────────────
// ★왜 별도 키인가: 더빙은 영상 잡과 '병렬'로 걸 수 있어서 공유 진행로그(split:progress)에
//   쓰면 동영상 진행 표시를 덮어쓴다. 그렇다고 콘솔(Render)에만 남기면 사용자는 왜 안 됐는지
//   앱에서 볼 방법이 없다 — "일본어 더빙이 안 된다"의 원인을 화면에서 못 본 게 이 때문이다.
//   → 더빙 잡 전용 리스트에 남기고, /api/job 이 dub 잡일 때 이걸 돌려준다.
const dubKey = (projectId) => `dub:progress:${projectId}`;
export async function resetDubLog(projectId) {
  try {
    await redis.del(dubKey(projectId));
  } catch {}
}
export async function logDub(projectId, msg) {
  try {
    const line = `${new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(11, 23)} ${msg}`;
    await redis.rpush(dubKey(projectId), line);
    await redis.expire(dubKey(projectId), 3600);
  } catch {}
}

// 행 프로파일 저장(base64 Float32) — 앱이 '그 컷만 분할'을 워커 없이 즉시 계산하게.
export async function saveRowProfile(projectId, base64) {
  try {
    await redis.set(`rowprofile:${projectId}`, base64);
    await redis.expire(`rowprofile:${projectId}`, 60 * 60 * 24 * 7);
  } catch {}
}

// 비용 기록 — API 호출 후 USD 를 Redis 리스트에 적재. 앱이 합산해 ₩로 표시(§15).
export async function recordCost(entry) {
  try {
    const e = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      ...entry,
    };
    await redis.lpush("cost:entries", e);
    await redis.ltrim("cost:entries", 0, 4999); // 폭주 방지
  } catch {}
}

// 단계 실패 표시 — 오케스트레이터 밖(타임아웃 등)에서도 상태를 error 로.
export async function failStep(projectId, error, step = "source") {
  try {
    const p = await getProject(projectId);
    if (!p || !p.steps?.[step]) return;
    p.steps[step].status = "error";
    p.steps[step].error = String(error);
    p.steps[step].updatedAt = Date.now();
    await saveProject(p);
  } catch {}
}
