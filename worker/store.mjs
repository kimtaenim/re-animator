// Redis 접근 (앱과 같은 키 스킴). 워커는 project 상태 + 잡 큐 + 진행 로그를 본다.
import { Redis } from "@upstash/redis";

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
