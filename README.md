# re-animator

웹툰(세로 스크롤, 여러 파일로 분할 업로드) → 동영상 자동 변환 하네스.
aninews-maker21 의 형제 프로젝트 — 출력단(영상 래퍼·ffmpeg 합성·단계형 UI)을 계승하고
입력단(가상 캔버스·컷 분할·캐스팅)은 새로 만든다.

## 현재 상태: **M1** (가상 캔버스 + 컷 분할 + G1 경계 편집)

스펙 §16 이 "최대 리스크 선검증"으로 지정한 첫 마일스톤. 이후 M2(캐스팅)~M7(합성)은
단계 네비에 자리만 잡아두고 순차 구현.

## 아키텍처

- **앱** (Next.js 16 / Vercel) — 업로드·상태조회·잡 enqueue 만. 무거운 연산은 안 한다.
- **워커** (`worker/`, 상시 서버) — 컷 분할·컷 추출 등 픽셀 연산(sharp). ffmpeg 합성은 M7 에서 추가.
- **저장** — Upstash Redis(프로젝트 상태 + 잡 큐) + Vercel Blob(소스·컷 이미지).
  grok/fal I2V 가 요구하는 입력 이미지 공개 URL 을 Blob 이 네이티브로 제공(→ M5 마찰 제거).

```
업로드 ─▶ [split 잡] 워커: 행 프로파일 → 경계 검출 → virtualCanvas + scenes
                                          │
                                    G1 경계 편집(드래그·삭제·추가)
                                          │
                              확정 ─▶ [extract 잡] 워커: 컷 crop·concat → Blob
```

## 모듈 경계 (부분 변경 안전 설계)

한 곳을 고쳐도 다른 곳이 안 깨지도록 의존성을 끊어 두었다.

| 관심사 | 파일 | 의존성 |
|--------|------|--------|
| **컷 경계 검출(튜닝 핵심)** | `worker/detect.mjs` | **순수** (sharp·Redis·Blob 0) |
| 튜닝 파라미터 | `config/split.json` | 앱·워커 공유. 코드 수정 없이 값만. |
| 픽셀 연산(프로파일·추출) | `worker/imaging.mjs` | sharp 전담 |
| 가상 캔버스 좌표계 | `lib/canvas.ts`(앱) / `worker/canvas.mjs` | 순수 |
| 저장소 | `lib/projectStore.ts`, `lib/blob.ts` | Redis/Blob 뒤로 격리 |
| G1 UI | `app/project/[id]/BoundaryEditor.tsx` | API 만 호출 |

## 셋업 · 웹앱으로 검수하기

M1 은 업로드 → 분할(워커) → G1 편집 → 추출(워커) 이므로 **앱 + 워커 둘 다** 떠 있어야
브라우저에서 전체 흐름을 검수할 수 있다.

```
# 1) 앱 (터미널 A)
npm install
cp .env.local.example .env.local     # Redis·Blob 값 채우기 (아래 "환경변수" 참고)
npm run dev                          # http://localhost:3000

# 2) 워커 (터미널 B) — 같은 .env.local 을 읽어 로컬에서 함께 구동
cd worker
npm install
npm run start:local                  # node --env-file=../.env.local index.mjs
```

그다음 브라우저에서: **새 프로젝트 → 웹툰 이미지 여러 장 업로드 → "컷 자동 분할"**
→ (워커가 처리, 스피너) → **G1 에서 경계 확인·수정 → "경계 확정·컷 추출"** →
추출된 컷 그리드 확인. 인터페이스와 분할 결과를 여기서 함께 검수한다.

> 배포 시 워커는 Render/Railway/Fly 등 상시 서버에서 `npm start`(= `node index.mjs`),
> 환경변수는 플랫폼에 설정. 로컬 검수용이 `start:local`.

## 컷 분할 로컬 검증 (샘플 웹툰 확보 후)

앱·Redis·Blob 없이 로컬 이미지로 알고리즘만 바로 확인:

```
cd worker
node cli.mjs ../scratch/ep1_01.png ../scratch/ep1_02.png   # 또는 폴더 하나
```
→ `worker/scratch/boundaries.png`(경계 오버레이) + `cut-*.png`(추출 컷) 생성.
`config/split.json` 의 `whiteRatioThreshold`·`minGapPx` 등을 바꿔가며 눈으로 맞춘 뒤,
그 값이 그대로 배포 워커에도 적용된다.

## 환경변수

`.env.local.example` 참고. M1 은 `UPSTASH_REDIS_REST_*` 와 `BLOB_READ_WRITE_TOKEN` 만.
