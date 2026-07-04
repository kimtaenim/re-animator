// ============================================================================
// 프로젝트 저장소 — Redis CRUD (aninews 계승, 도메인만 교체)
// ----------------------------------------------------------------------------
// 프로젝트 = 하나의 JSON 값(project:<id>). 목록은 정렬셋(projects:index)에 id 보관.
// 저장 구조를 Redis 뒤에 가두어, 나중에 씬별 키 분할(스펙 §M1 노트)로 바꿔도
// 호출부(API/워커)는 이 모듈 함수만 보게 한다.
// ============================================================================

import { getRedis } from "./redis";
import {
  type Project,
  type StepKind,
  STEP_ORDER,
  newStepState,
} from "./types";

const PROJECT = (id: string) => `project:${id}`;
const INDEX = "projects:index"; // sorted set: score=createdAt, member=id

export async function getProject(id: string): Promise<Project | null> {
  return (await getRedis().get<Project>(PROJECT(id))) ?? null;
}

export async function saveProject(p: Project): Promise<void> {
  p.updatedAt = Date.now();
  const redis = getRedis();
  await redis.set(PROJECT(p.id), p);
  await redis.zadd(INDEX, { score: p.createdAt, member: p.id });
}

export async function deleteProject(id: string): Promise<void> {
  const redis = getRedis();
  await redis.del(PROJECT(id));
  await redis.zrem(INDEX, id);
}

// 목록 (최신순). 카드에 필요한 요약만 뽑고 싶으면 호출부에서 map.
export async function listProjects(): Promise<Project[]> {
  const redis = getRedis();
  const ids = await redis.zrange<string[]>(INDEX, 0, -1, { rev: true });
  if (!ids.length) return [];
  const rows = await Promise.all(ids.map((id) => getProject(id)));
  return rows.filter((p): p is Project => p !== null);
}

export function emptySteps(): Record<StepKind, ReturnType<typeof newStepState>> {
  const steps = {} as Record<StepKind, ReturnType<typeof newStepState>>;
  for (const kind of STEP_ORDER) steps[kind] = newStepState(kind);
  return steps;
}

// 단계 상태 갱신 헬퍼 — 상태머신 전이를 한 곳에서.
export function setStep(
  p: Project,
  kind: StepKind,
  patch: Partial<Omit<ReturnType<typeof newStepState>, "kind">>
): void {
  p.steps[kind] = { ...p.steps[kind], ...patch, kind, updatedAt: Date.now() };
}
