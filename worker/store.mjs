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
    const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
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

// 단계 실패 표시 — 오케스트레이터 밖(타임아웃 등)에서도 상태를 error 로.
export async function failStep(projectId, error) {
  try {
    const p = await getProject(projectId);
    if (!p) return;
    p.steps.source.status = "error";
    p.steps.source.error = String(error);
    p.steps.source.updatedAt = Date.now();
    await saveProject(p);
  } catch {}
}
