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
  runPortrait,
  runDub,
} from "./jobs.mjs";
import { runCompose } from "./compose.mjs";

const POLL_MS = 3000;
const JOB_TIMEOUT_MS = 12 * 60 * 1000; // 12분(재생성 배치 여유)

const TYPES = ["split", "resplit", "splitcut", "mergecut", "extract", "cast", "regen", "video", "compose", "portrait", "dub"];
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
  portrait: runPortrait,
  dub: runDub,
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
  portrait: "cast",
  dub: "scene",
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

async function tick(types) {
  let job = null;
  let type = null;
  for (const t of types) {
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
    // dub 은 단계 상태를 안 씀(비디오와 병렬) → scene 단계 건드리지 않는다.
    if (type !== "dub") await failStep(job.projectId, msg, JOB_STEP[type] ?? "source");
  }
}

// ★ 더빙(dub)은 가벼운 네트워크 작업이라 무거운 메인 큐(분할·추출·영상·합성)와 '병렬'로 돈다.
//   → 동영상 생성 중에도 더빙이 동시에 처리된다. 저장은 오디오 필드만 병합(runDub)해 충돌 방지.
const MAIN_TYPES = TYPES.filter((t) => t !== "dub");
async function loop(types) {
  for (;;) {
    await tick(types);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

console.log("[worker] BUILD = m6-dub-fix-v8 (dialogue 대사 더빙 + 효과음 자동생성 제거)");
console.log("[worker] 시작 — 메인 큐 + 더빙 큐(병렬) 폴링 중…");
await Promise.all([loop(MAIN_TYPES), loop(["dub"])]);
