// re-animator 입력단 워커 — jobq:split / jobq:extract 를 폴링해 무거운 연산 실행.
// aninews 와 달리 이 워커가 입력단 픽셀 연산까지 담당(Vercel 서버리스 60초·메모리 회피).
// Render/Railway/Fly 등 상시 서버에서 `node index.mjs`.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { popJob, updateJob, failStep } from "./store.mjs";

// ★부모(폴러)는 jobs.mjs·compose.mjs 를 아예 로드하지 않는다 — sharp(libvips)도 안 올라온다.
//   모든 실제 작업은 runOne.mjs 자식이 하고, 끝나면 프로세스가 죽어 메모리가 OS 로 반환된다.
// ★크래시 가드 — 'Exited with status 1'(2026-07-17 00:03Z, 유휴 중 사망) 재발 방지.
//   떠돌이 promise 거부는 로그만 남기고 계속(폴러는 무상태라 안전), 동기 예외는
//   원인을 로그에 남긴 뒤 종료(Render 재시작) — 원인 불명 사망 금지.
process.on("unhandledRejection", (e) => {
  console.error("[worker] unhandledRejection(계속 실행):", e?.stack ?? e?.message ?? e);
});
process.on("uncaughtException", (e) => {
  console.error("[worker] uncaughtException(종료→재시작):", e?.stack ?? e?.message ?? e);
  process.exit(1);
});

const POLL_MS = 3000;
const JOB_TIMEOUT_MS = 12 * 60 * 1000; // 12분(재생성 배치 여유)

const TYPES = ["split", "resplit", "splitcut", "mergecut", "extract", "cast", "regen", "video", "compose", "join", "portrait", "dub", "postfx", "camerafx", "sequence", "translate"];
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
  join: "compose",
  portrait: "cast",
  dub: "scene",
  postfx: "scene",
  camerafx: "scene",
};

// ★★잡 1개 = 자식 프로세스 1개.
//   OOM 이 반복되고 내가 계속 못 잡은 구조적 원인: 워커가 장수 프로세스라, 분할·추출 잡이
//   올려놓은 메모리(sharp/libvips 네이티브·큰 raw 버퍼)가 잡이 끝나도 OS 로 반환되지 않고
//   남았다. 다음 영상 잡의 ffmpeg 가 그 위에 얹혀 한도를 넘었다 → 증상은 영상, 원인은 앞 잡.
//   자식에서 돌리고 종료시키면 그 잡의 메모리는 전부 OS 로 돌아간다(누적 원천 차단).
//   부모는 Redis 폴링만 하므로 수십 MB 로 유지된다.
//   ★타임아웃도 이제 '진짜 취소'다 — 자식을 SIGKILL 하면 실제로 멈춘다(예전 Promise.race 는
//     거부만 하고 실행 중 잡을 못 멈춰 다음 잡과 겹쳤다).
const RUN_ONE = fileURLToPath(new URL("./runOne.mjs", import.meta.url));

function runJobInChild(job) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUN_ONE, JSON.stringify(job)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let count = 0;
    let errMsg = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch {}
    }, JOB_TIMEOUT_MS);

    const onLine = (line, isErr) => {
      if (!line) return;
      if (line.startsWith("__RESULT__")) count = Number(line.slice(10).trim()) || 0;
      else if (line.startsWith("__ERROR__")) errMsg = line.slice(9).trim();
      else if (isErr) console.error(line);
      else console.log(line);
    };
    const wire = (stream, isErr) => {
      let buf = "";
      stream.on("data", (d) => {
        buf += d.toString();
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? "";
        for (const l of parts) onLine(l, isErr);
      });
      stream.on("end", () => onLine(buf, isErr));
    };
    wire(child.stdout, false);
    wire(child.stderr, true);

    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`${job.type} 타임아웃(${Math.round(JOB_TIMEOUT_MS / 60000)}분) — 자식 프로세스 강제 종료`));
      if (code === 0) return resolve(count);
      // 종료 코드로 OOM 을 구분해 알려준다(부모는 안 죽는다).
      const oom = signal === "SIGKILL" || code === 137;
      reject(new Error(errMsg || (oom ? "메모리 초과로 잡 프로세스가 종료됨(OOM)" : `잡 프로세스 종료 코드 ${code}`)));
    });
  });
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
    const count = await runJobInChild(job);
    await updateJob(job.id, { status: "done" });
    console.log(`[worker] ${type} 완료 job=${job.id} (${count}컷)`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    console.error(`[worker] ${type} 실패 job=${job.id}:`, msg);
    // ★복구 경로가 다시 던지면(Redis 순단 등) 메인 루프까지 뚫고 프로세스가 죽는다 — 각각 방어.
    try {
      await updateJob(job.id, { status: "error", error: msg });
    } catch (e2) {
      console.error("[worker] updateJob(error) 실패:", e2?.message ?? e2);
    }
    // dub 은 단계 상태를 안 씀(비디오와 병렬) → scene 단계 건드리지 않는다.
    try {
      if (type !== "dub" && type !== "postfx" && type !== "camerafx" && type !== "sequence" && type !== "translate") await failStep(job.projectId, msg, JOB_STEP[type] ?? "source");
    } catch (e2) {
      console.error("[worker] failStep 실패:", e2?.message ?? e2);
    }
  }
}

// ★메모리 빡빡한 워커라 잡은 '한 번에 하나만' 처리한다(병렬 X → OOM 방지). 더빙 UI 는
//   동영상 중에도 걸 수 있지만(잡 큐에 적재), 워커는 순서대로 처리한다.
// ★배포 지문 — 커밋마다 갱신한다. 이 태그로 '내 코드가 실제로 배포됐는지'를 로그에서 확인한다.
//   (예전엔 고정 문자열이라 버전 확인이 불가능했다.)
console.log("[worker] BUILD = fixes-v18 (언어별 더빙을 4단계로 · 선택/안된것만 항상 노출)");
console.log("[worker] 시작 — 단일 루프(한 번에 한 잡) 폴링 중…");
for (;;) {
  await tick(TYPES);
  await new Promise((r) => setTimeout(r, POLL_MS));
}
