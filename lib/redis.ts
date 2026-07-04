// ============================================================================
// Redis 접속 (aninews-maker21 계승) — 프로젝트 상태 + 잡 큐
// ----------------------------------------------------------------------------
// 앱과 워커가 같은 Upstash Redis 를 본다. 앱은 enqueue·조회만, 무거운 연산은 워커.
// ============================================================================

import { Redis } from "@upstash/redis";

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN missing in .env.local"
    );
  }
  _redis = new Redis({ url, token });
  return _redis;
}
