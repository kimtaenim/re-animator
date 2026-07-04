# re-animator 입력단 워커 (M1)

앱(Vercel 서버리스)이 못 돌리는 무거운 이미지 연산을 처리하는 **별도 상시 서버**.
aninews 워커가 ffmpeg 전용이었던 것과 달리, 이 워커는 **입력단 픽셀 연산**을 맡는다.

- Next 앱과 **같은 Redis** 를 본다 (`lib/jobQueue.ts` 가 적재한 `jobq:*`).
- 큐를 `rpop` 으로 소비 → 실행 → 결과를 Blob 에 올리고 Job·Project 상태 갱신.
- 픽셀 연산은 `sharp`(libvips). Docker 이미지에 prebuilt 번들 포함.

## 잡 종류 (M1)
| type | 하는 일 |
|------|---------|
| `split`   | 소스 파일들 → 행 프로파일 → 컷 경계 검출 → `virtualCanvas` + `scenes` |
| `extract` | G1 확정 경계로 컷 이미지 crop·concat → Blob → `scene.originalImage` |

## 모듈 경계 (부분 변경 안전)
- `detect.mjs` — **순수** 경계 검출. 튜닝은 여기 + `config/split.json` 만. 시그니처 고정.
- `imaging.mjs` — sharp 픽셀 연산(프로파일·추출) 전부 격리.
- `canvas.mjs` — offsets 순수 계산.
- `jobs.mjs` — I/O 오케스트레이션.

## 로컬 검증 (샘플 확보 후)
```
cd worker && npm install
node cli.mjs ../scratch/sample1.png ../scratch/sample2.png   # 또는 폴더
```
→ `scratch/boundaries.png`(경계 오버레이)와 `scratch/cut-*.png`(추출 컷) 확인.
`config/split.json` 값(whiteRatioThreshold·minGapPx 등)을 바꿔가며 눈으로 맞춘다.

## 환경변수
`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `BLOB_READ_WRITE_TOKEN`.
(CLI 검증만 할 땐 불필요 — 로컬 파일만 읽고 scratch 에 씀.)

## 가동
```
node index.mjs
```
