// re-animator 입력단 워커 — jobq:split / jobq:extract 를 폴링해 무거운 연산 실행.
// aninews 와 달리 이 워커가 입력단 픽셀 연산까지 담당(Vercel 서버리스 60초·메모리 회피).
// Render/Railway/Fly 등 상시 서버에서 `node index.mjs`.
import { popJob, updateJob, failStep } from "./store.mjs";
import {
  runSplit,
  runExtract,
  runCast,
  runResplit,
  runRegen,
  runSplitCut,
  runMergeCut,
  runVideo,
} from "./jobs.mjs";
import { runCompose } from "./compose.mjs";

const POLL_MS = 3000;
const JOB_TIMEOUT_MS = 12 * 60 * 1000; // 12분(재생성 배치 여유)

const TYPES = ["split", "resplit", "splitcut", "mergecut", "extract", "cast", "regen", "video", "compose"];
const JOB_FN = {
  split: runSplit,
  resplit: runResplit,
  splitcut: runSplitCut,
  mergecut: runMergeCut,
  extract: runExtract,
  cast: runCast,
  regen: runRegen,
  video: runVideo,
  compose: runCompose,
};
const JOB_STEP = {
  split: "source",
  resplit: "source",
  splitcut: "regen",
  mergecut: "regen",
  extract: "source",
  cast: "cast",
  regen: "regen",
  video: "scene",
  compose: "compose",
};

async function runJob(job) {
  const fn = JOB_FN[job.type] ?? runSplit;
  const count = await Promise.race([
    fn(job.projectId, job.payload),
    new Promise((_, rej) =>
      setTimeout(
        () => rej(new Error(`${job.type} 타임아웃(8분) — 워커 매달림`)),
        JOB_TIMEOUT_MS
      )
    ),
  ]);
  return count;
}

async function tick() {
  let job = null;
  let type = null;
  for (const t of TYPES) {
    try {
      job = await popJob(t);
    } catch (e) {
      console.error("[worker] 큐 폴링 에러:", e?.message ?? e);
      return;
    }
    if (job) {
      type = t;
      break;
    }
  }
  if (!job) return;

  console.log(`[worker] ${type} 시작 job=${job.id} project=${job.projectId}`);
  try {
    await updateJob(job.id, { status: "running" });
    const count = await runJob(job);
    await updateJob(job.id, { status: "done" });
    console.log(`[worker] ${type} 완료 job=${job.id} (${count}컷)`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    console.error(`[worker] ${type} 실패 job=${job.id}:`, msg);
    await updateJob(job.id, { status: "error", error: msg });
    await failStep(job.projectId, msg, JOB_STEP[type] ?? "source");
  }
}

console.log("[worker] BUILD = m5-video-compose-v2 (grok int-duration x2, ffmpeg optional)");
console.log("[worker] 시작 — jobq:split / resplit / extract / cast / regen 폴링 중…");
for (;;) {
  await tick();
  await new Promise((r) => setTimeout(r, POLL_MS));
}
