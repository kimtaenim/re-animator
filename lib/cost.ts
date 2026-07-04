// ============================================================================
// 비용 집계 (§15) — 워커/앱이 Redis(cost:entries)에 적재한 USD 를 합산해 ₩로.
// 환율은 여기 한 곳(KRW_PER_USD)에서 관리. 단가(토큰당)는 호출 지점에서 계산해
// costUsd 로 적재하므로, 여기선 합산·환산만 한다.
// ============================================================================

import { getRedis } from "./redis";

export const KRW_PER_USD = 1500;

export function usdToKrw(usd: number): number {
  return Math.round(usd * KRW_PER_USD);
}

export function formatKrw(usd: number): string {
  return `₩${usdToKrw(usd).toLocaleString("ko-KR")}`;
}

export interface CostEntry {
  id: string;
  projectId?: string;
  vendor: "openai" | "grok" | "fal" | "elevenlabs" | "typecast";
  model: string;
  costUsd: number;
  createdAt: number;
  meta?: Record<string, unknown>;
}

const KEY = "cost:entries";

// projectId 주면 그 프로젝트만, 없으면 전체 누적.
export async function totalCostUsd(projectId?: string): Promise<number> {
  const entries = (await getRedis().lrange<CostEntry>(KEY, 0, -1)) ?? [];
  const filtered = projectId ? entries.filter((e) => e.projectId === projectId) : entries;
  return filtered.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
}
