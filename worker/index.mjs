// re-animator 입력단 워커 — jobq:split / jobq:extract 를 폴링해 무거운 연산 실행.
// aninews 와 달리 이 워커가 입력단 픽셀 연산까지 담당(Vercel 서버리스 60초·메모리 회피).
// Render/Railway/Fly 등 상시 서버에서 `node index.mjs`.
import { popJob, updateJob, failStep } from "./store.mjs";
import { runCompose } from "./compose.mjs";

// ★sharp(libvips) 격리 — jobs.mjs 는 로드 시 sharp 네이티브 라이브러리를 프로세스에 올린다.
//   compose(ffmpeg)와 같은 프로세스에 sharp 가 상주하면 그 몫만큼 ffmpeg 여유가 줄어 OOM.
//   aninews 워커에는 sharp 가 아예 없어서 같은 합성이 안 터진다 — 같은 조건을 만들기 위해
//   jobs.mjs 는 compose 외의 잡이 실제로 들어왔을 때만 lazy 로드한다(compose 경로는 sharp 무관).
let _jobs = null;
async function jobFn(type) {
  if (type === "compose") return runCompose;
  _jobs ??= await import("./jobs.mjs");
  const map = {
    split: _jobs.runSplit,
    resplit: _jobs.runResplit,
    splitcut: _jobs.runSplitCut,
    mergecut: _jobs.runMergeCut,
    extract: _jobs.runExtract,
    cast: _jobs.runCast,
    regen: _jobs.runRegen,
    video: _jobs.runVideo,
    portrait: _jobs.runPortrait,
    dub: _jobs.runDub,
  };
  return map[type] ?? _jobs.runSplit;
}

const POLL_MS = 3000;
const JOB_TIMEOUT_MS = 12 * 60 * 1000; // 12분(재생성 배치 여유)

const TYPES = ["split", "resplit", "splitcut", "mergecut", "extract", "cast", "regen", "video", "compose", "portrait", "dub"];
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
  const fn = await jobFn(job.type);
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

// ★메모리 빡빡한 워커라 잡은 '한 번에 하나만' 처리한다(병렬 X → OOM 방지). 더빙 UI 는
//   동영상 중에도 걸 수 있지만(잡 큐에 적재), 워커는 순서대로 처리한다.
console.log("[worker] BUILD = m7-compose-v28 (영상 프롬프트 기본톤=세련·빠른 호흡 + 화려 카메라 프리셋만)");
console.log("[worker] 시작 — 단일 루프(한 번에 한 잡) 폴링 중…");
for (;;) {
  await tick(TYPES);
  await new Promise((r) => setTimeout(r, POLL_MS));
}
