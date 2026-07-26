// ============================================================================
// 잡 1개 실행 전용 자식 프로세스.
// ----------------------------------------------------------------------------
// ★왜 이렇게 바꿨나(OOM 이 반복되고 내가 계속 못 잡았던 진짜 구조적 원인):
//   워커는 하나의 '장수 프로세스'였다. 분할·추출 잡이 큰 이미지 raw 버퍼로 RSS 를 올려놓으면,
//   잡이 끝나 JS 객체가 회수돼도 V8·libvips 는 그 메모리를 OS 로 즉시 돌려주지 않는다.
//   그래서 다음 영상 잡의 ffmpeg 가 얹히는 순간 컨테이너 한도를 넘었다.
//   → 증상은 "영상 생성 중 OOM" 인데 원인은 앞 잡이라, 영상 쪽 숫자(동시성·해상도)를
//     아무리 만져도 해결되지 않았다.
//
//   잡 하나를 자식 프로세스에서 돌리고 끝나면 프로세스를 종료하면, 그 잡이 쓴 메모리는
//   sharp(libvips) 네이티브·ffmpeg·버퍼 전부 OS 로 완전히 반환된다. 잡 사이 누적이 원천 차단.
//   부모(index.mjs)는 Redis 폴링만 하므로 수십 MB 로 유지된다.
//
//   부수 효과 두 가지:
//   1) 잡 타임아웃이 '진짜 취소' 가 된다 — 예전 Promise.race 는 거부만 하고 실행 중 잡을
//      멈추지 못해 다음 잡과 겹쳤다(핸드오프에 기록된 미해결 항목). 이제 자식을 죽이면 끝.
//   2) 잡이 크래시해도 부모 폴러는 살아 있다.
//
// 사용: node runOne.mjs '<job JSON>'   → exit 0(성공) / 1(실패). 결과는 stdout 마지막 줄에
//   "__RESULT__ <count>" 형태로. 실패 메시지는 "__ERROR__ <message>".
// ============================================================================

const raw = process.argv[2];
if (!raw) {
  console.error("__ERROR__ job JSON 인자 없음");
  process.exit(1);
}

let job;
try {
  job = JSON.parse(raw);
} catch (e) {
  console.error(`__ERROR__ job JSON 파싱 실패: ${e?.message ?? e}`);
  process.exit(1);
}

// 잡 타입별 모듈 — ★compose/join 은 sharp 를 로드하지 않는 경로를 유지한다(그 잡에선
// 이미지 처리가 없으므로 libvips 를 아예 안 올린다 = 그만큼 ffmpeg 여유).
async function resolveFn(type) {
  if (type === "compose" || type === "join") {
    const m = await import("./compose.mjs");
    return type === "compose" ? m.runCompose : m.runJoin;
  }
  const j = await import("./jobs.mjs");
  const map = {
    split: j.runSplit,
    resplit: j.runResplit,
    splitcut: j.runSplitCut,
    mergecut: j.runMergeCut,
    extract: j.runExtract,
    cast: j.runCast,
    regen: j.runRegen,
    video: j.runVideo,
    portrait: j.runPortrait,
    dub: j.runDub,
    postfx: j.runPostfx,
    camerafx: j.runCameraFx,
    sequence: j.runSequence,
    translate: j.runTranslate,
  };
  return map[type] ?? j.runSplit;
}

// 피크 RSS 를 재서 종료 시 남긴다 — 어느 잡이 메모리를 먹는지 근거로 남긴다.
let peak = 0;
const memTimer = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 500);
memTimer.unref?.();

try {
  const fn = await resolveFn(job.type);
  const count = await fn(job.projectId, job.payload);
  clearInterval(memTimer);
  console.log(`[mem] ${job.type} 피크 ${Math.round(peak / 1048576)}MB`);
  console.log(`__RESULT__ ${Number(count) || 0}`);
  process.exit(0);
} catch (e) {
  clearInterval(memTimer);
  console.log(`[mem] ${job.type} 피크 ${Math.round(peak / 1048576)}MB (실패)`);
  console.error(`__ERROR__ ${String(e?.message ?? e)}`);
  process.exit(1);
}
