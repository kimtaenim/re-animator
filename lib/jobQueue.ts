// ============================================================================
// 잡 큐 (aninews 계승, M1 잡 타입) — 앱은 enqueue·조회, 워커가 소비
// ----------------------------------------------------------------------------
// M1 잡: split(컷 분할), extract(경계 확정 후 컷 이미지 추출).
// 워커는 store.mjs 에서 rpop 으로 소비(FIFO). 이후 엔진별 워커풀은 §13 에서 확장.
// ============================================================================

import { getRedis } from "./redis";

export type JobType =
  | "split"
  | "extract"
  | "cast"
  | "resplit"
  | "regen"
  | "splitcut"
  | "mergecut"
  | "video"
  | "compose"
  | "portrait"
  | "dub"
  | "postfx"
  | "camerafx"
  | "sequence"
  | "join";
export type JobStatus = "queued" | "running" | "done" | "error";

export interface Job {
  id: string;
  type: JobType;
  projectId: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const QUEUE = (type: JobType) => `jobq:${type}`;
const JOB = (id: string) => `job:${id}`;

export async function enqueueJob(job: Job): Promise<void> {
  const redis = getRedis();
  await redis.set(JOB(job.id), job);
  await redis.lpush(QUEUE(job.type), job.id);
}

export async function getJob(id: string): Promise<Job | null> {
  return (await getRedis().get<Job>(JOB(id))) ?? null;
}

export async function updateJob(id: string, patch: Partial<Job>): Promise<Job | null> {
  const redis = getRedis();
  const cur = await getJob(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await redis.set(JOB(id), next);
  return next;
}
