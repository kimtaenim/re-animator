# re-animator — 컨텍스트 이식용 핸드오프 프롬프트

너는 지금부터 **re-animator**(웹툰 → 동영상 파이프라인) 작업을 이어서 한다. 아래는 직전 세션에서 한 일과 현재 상태, 지켜야 할 규칙, 다음 할 일이다. 이걸 전제로 이어서 작업하라.

---

# ★★★★★ 지금 상태 (2026-08-02 밤, 세션 Re-animator (8) 종료 시점) — 여기부터 읽어라

**배포 HEAD = `8e3c671` · 워커 BUILD = `wire-v70`** (분할 첫 로그에 `node vXX` 자가 표기, Node 20 고정).

## 이 세션이 만든 것(전부 push·배포)
- **🌳 트리 = 유일한 컷 작업 동선**: 탭 = 소스·분할 / 캐스팅 / 🌳 컷 작업 / 합성(3·4·5 탭·번호 제거).
  트리: 섹션→컷→[③재생성 ④영상·더빙 ⑤카메라] 카드(렌더러 공유), 섹션 끝 ⑥ 이 섹션 합성,
  맨 아래 ⑥ 최종 이어붙이기. 하단 리모컨 = [🖼+🎙 이미지·더빙 일괄] [🎙 더빙 일괄] [🎬 동영상 일괄]
  (자동 몰래 실행 없음 — 사용자가 명시적으로 버튼). ④ 카드: 동영상 프롬프트 맨 앞, 🎥 카메라
  프리셋 선택(오빗=생성 전 선택 유도), 조작줄 상시 노출, ③에도 🎙 더빙(동일 함수=싱크).
- **워커 robust**: ★잡 자동 재개(auto-v67~) — 재배포·재시작·OOM 에 끊긴 잡을 큐 맨 앞에 재큐해
  스스로 이어감(같은 잡 2회 중단 시에만 에러 확정). 추출 섹션 이어달리기(잡=섹션, 없으면 8컷
  자동 분절) + 중간 저장 2지점(글씨·연출 / 교정·번역) → 죽어도 전진. 분할·추출 진행로그에
  [mem]·node 버전 자가 기록.
- **합성 = 사운드 흘려얹기(flow-v62)**: 영상(컷 길이)이 뼈대, 소리는 그룹(섹션) 타임라인에
  배치(넘치면 다음 컷 위로, 앞 소리 끝난 뒤 이어서; 섹션 경계는 안 넘고 마지막 컷만 홀드).
  세그먼트 영상 전용 인코딩(슬로모션 폐지) → concat → adelay/amix(normalize=0) 1패스 mux
  (-c:v copy). ★실데이터 완주는 미검증 — 첫 섹션 합성이 판정.
- **카메라 렌더 전면 교체(cam-v59)**: sendcmd 폐기 → 테이블→구간선형 '수식 crop' 컴파일
  (buildCropExprs). 이유(실측): sendcmd 는 crop 성장(줌아웃·버티고 배경)에서 ffmpeg 교착(4분 행)
  + 계층 B 는 타깃 불일치로 아예 무동작(돈 쓰고 정지 클립 저장). 수식은 성장 포함 정상.
  버티고 프리셋 start_zoom 1.45·rate2·accel6(lib/worker 동일) — 배경 실제로 풀림(수치 확인).
  씬 미리보기 모달에도 안 구운 카메라 WAAPI 근사 표시(구운 컷은 원본 재생, loop 제거=홀드).
- **배선 수정(전부 실측·코드로 원인 확정)**: ①VLM_MODEL 미정의로 재생성 전멸(f523be6)
  ②하늘 컷이 인물로 — 인물 없는 컷(사물·텍스트, characters 0 / 내용 프롬프트 공백)엔 캐스팅
  레퍼런스 자동 제외 ③영상 '얼굴 끼어듦' — 같은 게이트로 인물 지시 제외 ④효과음이 앱에서
  무음 — bubbleAudio 가 언어 모드에서 b.audioUrl(효과음 저장 위치)을 안 봄 → 효과음만 언어
  규칙 제외(acdd845; 합성은 원래 정상=최종엔 들어가 있었음) ⑤좌우 크롭 한쪽 핸들만 조정 시
  저장이 통째 버려 여백 부활(8b79541) ⑥G1 낡은 자동저장이 새 분할을 되돌림 — 씬 id 생존율
  30% 미만(진짜 재분할)일 때만 편집 폐기 + 작업 중 경계 저장 409(c119169+40005c0)
  ⑦목소리 변경 시 그 화자 기존 더빙 자동 무효화(8e3c671) ⑧섹션 합성 언어 게이트 우회·원어판
  불가(6ea0363) ⑨계층B 매트 길이로 긴 클립 잘림 ⑩compose ensureSubtitleFontPath 미임포트.
- **no-undef 정적 점검**을 push 전 통과 조건에 추가(워커 전체, 미정의 변수 부류 박멸).

## ★미해결·확인 대기(새 세션 우선순위)
1. **사용자 확인 대기**: 컷 2 영상 재시도(자동 재개 후 완주?), 흘려얹기 합성 첫 실행, 버티고
   굽기 실물, 효과음 실패 사유(ELEVENLABS 관련 — 더빙 시작 로그에 키 부재 경고 나오는지).
2. **대사·효과음 '텍스트' 수정 시 소리 자동 무효화 미구현** — 지금은 '이 컷 더빙'(강제)으로만
   갱신됨. 목소리 변경 무효화(8e3c671)와 같은 패턴으로 /api/cut 저장에서 텍스트 diff 시
   audioUrl 제거하면 됨(preserveWorkerAudio 의 텍스트 가드와 일관되게).
3. 대상 언어 UI 가 1단계에 있는 것 정리(4단계로), ASS 자막 기본 승격(폰트 번들), 자막 자동
   행갈이 모양 조정(수동 \n 은 이미 존중됨).
4. 핸드오프의 옛 '다음 방향' 중 트리 재편은 완료됨 — 아래 이력 블록의 (a)(b)(c) 전부 끝.

## ★이 세션의 교훈(다음 세션은 그대로 지켜라)
- **사용자 진술이 1급 증거다.** "새 배포부터 터진다"(맞았음), "파일 크기 늘 같다"(내 가설 기각),
  "15컷은 내 수작업"(스테일 아님), "네 배선 문제"(전부 배선이었음). 반박하려면 diff·실측 먼저.
- **push 타이밍**: 오늘 잡 사망 대부분이 '사용자 작업 중 내 배포'였다. 자동 재개(v67)로
  치명도는 낮아졌지만, 몰아서 배포하고 사용자가 돌리는 중엔 피하라.
- **git 은 반드시 `cd /c/myapps/re-animator &&` 또는 `git -C`** — cwd 가 aninews 로 튀어
  오배포 사고 1회(즉시 revert). 커밋 전 `git remote get-url origin` 확인 습관화.
- 원인 못 찾으면 '실행'해라: ffmpeg 교착·믹스 패턴·메모리 전부 스크래치 실행으로 판정했다
  (scripts/measure-split-memory.mjs 등). 로그 요청은 최후 수단 — 코드·실행으로 먼저.

---

# (이력) 2026-08-02 저녁 상태 — 이어받는 세션은 이 블록부터 읽어라

**배포 HEAD = `7c34b04`** · **워커 BUILD = `mem-v40`**.

## ★★★분할 OOM·먹통 조사 — 사용자 말을 먼저 들어라(이번 세션 최대 교훈)
사용자가 처음부터 "이전엔 안 터졌다, 새 배포부터 터진다, 이전 코드를 봐라"라고 했다.
나는 내 가설(이번 원고 파일이 커서 / 캐시 개수 문제)부터 쫓다가 시간을 태웠고 둘 다 틀렸다
(사용자: 이전 회차 파일이 더 컸고, 웹툰 세로 사이즈는 늘 같다). **다음 세션은 사용자 진술을
1급 증거로 취급하고 반박하려면 diff·실측을 먼저 가져와라.**

### 검증된 사실(다시 조사하지 마라)
- 안 터지던 배포 = `41215f5`(7-24~8-01 유일 배포, 이 시기 분할 성공). 그것과 어제 OOM 시점
  워커의 diff: **분할 경로(imaging·ocr·classify·runOne·runSplit) 코드 diff 0**(import 2줄뿐),
  **의존성 락파일 변화 0**(sharp 0.34.5 고정), 원고 크기 동일(사용자).
- **유일한 미고정 변수 = Node 런타임**: render.yaml 이 `runtime: node`라 Dockerfile 의
  node:20 고정은 무효였고 .node-version 도 없었다 → 재빌드마다 런타임이 바뀔 수 있었다.
  → `7c34b04` 로 worker/.node-version=20 고정 + 분할 첫 로그·BUILD 라인에 node 버전 자가 보고.
  **다음 분할 로그의 `(node vXX)` 가 물증** — 20 아닌 버전이 찍혔던 적 있는지 확인.
- 실측 도구 `scripts/measure-split-memory.mjs`(실제 sharp 실행, 키 불필요): 같은 총 높이라도
  통짜 2파일=410MB vs 잘게 8파일=236MB. 피크=상주 raw 캐시+통째 디코드 순간 임시 버퍼.
  `09bc3ab` 로 ①방출을 디코드 전으로 ②sequentialRead ③libvips 캐시 끔 → 410→362~387MB.
- **먹통의 구조적 정체(수정됨)**: 인스턴스가 통째 죽으면 잡이 Redis 에 running 좀비로 남아
  화면이 영원히 '진행 중'이었다 → `ba183a6`+`09bc3ab`: worker:current 기록, 부팅 sweep +
  SIGTERM 즉시 "중단됨 — 다시 시작해 주세요" 표시.
- 분할 진행 로그에 단계별 `[mem] rss·raw캐시` 자가 기록(`6ebde04`) — 다음 OOM 은 숫자로 잡힌다.
- ★내가 한 시간에 push 5번 해서 사용자가 돌리던 잡을 배포로 계속 죽였다(재배포=잡 사망).
  **사용자가 잡 돌리는 중엔 push 를 묶어라. 단 "push 안 하겠다"는 태업으로 받아들인다 —
  고치면 바로 push 하되 타이밍을 봐라.**

### 다음 세션 첫 할 일
1. 사용자가 분할을 돌리면: 첫 줄 `(node vXX)` + `[mem]` 숫자 확인 → OOM 재발 시 그 지점만 수술.
   피크가 여전히 400MB+ 면 남은 수단은 '컷이 걸친 구간만 디코드'(통째 디코드 폐지) — 좌표
  수술이라 사용자 승인 후. 2. 트리 뷰(아래) 검증·(c)단계는 그 다음.

**(이전 상태) 배포 HEAD = `2872051`** · **워커 BUILD = `tree-v34`**(로그 첫 줄로 배포 확인, 커밋마다 갱신).
**★파일은 절대경로 `C:\myapps\re-animator\...` 로 확인.** 형제 프로젝트 `aninews-maker21` 과 모델이 다름.

## ★인터페이스 트리 재편 — (a)(b) 완료·push, (c)는 사용자 확인 대기
- **(a) `51335ba`**: 3·4·5단계 컷 카드 JSX 를 `renderRegenCard`/`renderSceneCard`/`renderCameraCard`
  함수로 추출(Studio.tsx `return (` 직전에 정의). 화면·동작 무변경 — tsc·전체 테스트로 확인.
- **(b) `2872051`**: **🌳 트리 뷰 새 탭**(네비 2번째 뒤, `#tree` 해시) — 섹션→컷→[③④⑤ 카드],
  섹션 끝 `⑥ 이 섹션 합성`(composeSection 공유), 맨 아래 `⑥ 최종 이어붙이기`(joinSections 공유).
  카드 렌더러를 그대로 재사용(중복 구현 0). 컷 펼치면 ④ 카드 아코디언(openScene)도 같이 펼침.
  기존 3·4·5 탭은 그대로 남아 있음(안전판).
- **(c) 미착수 — 게이트**: "확인되면 3·4·5 탭을 트리 뷰로 대체(커밋 분리)". 사용자가 배포에서
  트리 뷰가 실제로 돌아가는 걸 확인한 뒤에만 할 것.
- **사용자 확인 항목**: 🌳 탭이 보이는지 → 섹션·컷 펼침 → ③④⑤ 카드가 각 단계 탭과 똑같이
  동작하는지(재생성·영상·더빙·카메라 굽기) → ⑥ 이 섹션 합성 → 전 섹션 후 ⑥ 최종 이어붙이기.
- ★로컬 `next dev` 도 구글 폰트(layout.tsx noto_sans_kr)로 컴파일 실패 — 로컬 브라우저 검증 불가
  확인(2026-08-02, 코드 무관). 검증은 tsc+테스트 스위트+배포.

## ★사용자가 정한 다음 방향(아직 미착수 — 여기부터 하면 된다)
1. **섹션 중심 워크플로우로 권장**(사용자 지정, 이유: "그래야 에러가 없다").
   1단계에서 섹션을 나누고 → 2·3·4·5단계는 **섹션 단위**로 작업 → 6단계는 **합치기만**.
   기반은 이미 있다: `Project.sectionStarts`/`sectionVideos`, 섹션 바(3·4·카메라), 시퀀스 자동 나누기(`sequence` 잡),
   섹션별 합성(`runCompose(sceneIds, sectionKey)`) + 최종 join(`runJoin`). **UI 유도가 없을 뿐이다.**
2. **인터페이스 재편(대공사) — 사용자가 지정한 화면 구조는 '트리' 다. 이대로 만들어라:**

   ```
   전체
    ├ 섹션 1
    │   ├ 컷 1  → [3단계 재생성] [4단계 영상·더빙] [5단계 카메라]   ← 한 컷 안에 3개가 같이
    │   ├ 컷 2  → [3] [4] [5]
    │   └ ⑥ 이 섹션 합성(6단계 초반)                                ← 섹션마다 하나
    ├ 섹션 2 …
    └ ⑥ 최종 이어붙이기(전 섹션 합성본 join)                        ← 전체 레벨에 하나
   ```
   - 1·2단계는 지금처럼 '단계 우선'(소스·분할 / 캐스팅)으로 둔다.
   - 3·4·5는 **단계 탭을 없애고 컷 안으로** 들어간다. 컷 하나를 붙잡고 재생성→영상/더빙→카메라를
     끝낸 뒤 다음 컷으로 가는 흐름(사용자: "한 컷마다 단계 3개를 모아놓고 조정").
   - 6단계는 **섹션 단위 합성이 주 동선**이고, 전 섹션이 끝나면 최종 join. 전체 일괄 합성은 보조.
   ★안전한 순서(반드시 이 순서로, 슬라이스마다 커밋):
     (a) 지금 3·4·5단계의 컷 카드 JSX 를 **함수로 추출**(`renderRegenCard(s)` / `renderSceneCard(s)` /
         `renderCameraCard(s)`) — 동작·모양 무변경, 기존 탭이 그대로 보이는지 tsc·build 로 확인.
     (b) 트리 뷰(새 탭)를 추가해 섹션→컷→그 3개 카드를 쌓고, 섹션 끝에 '이 섹션 합성' 을 붙인다.
     (c) 확인되면 기존 3·4·5 탭을 트리 뷰로 대체(되돌릴 수 있게 커밋 분리).
   Studio.tsx 는 5000줄이라 한 번에 뜯으면 반드시 깨진다(과거 사고).

## 이번 세션(8-01~02)에 고친 것 — 전부 push 됨
- **★일본어 더빙이 몇 주간 안 되던 진짜 원인 = 번역 응답 파서**(`6c60eb4`). `salvageItems` 가 괄호 균형으로
  객체를 긁는데, 모델이 정상 완결 `{"t":[{"i":0,"ja":"…"}]}` 를 주면 **바깥 객체 하나만** 잡혀 전부 버려졌고
  (i 없음), 잘리면 아예 못 건졌다 → 모델이 우연히 배열로 답할 때만 동작 = "번역이 들쭉날쭉".
  그 파서는 내가 `e047137` 에서 "진짜 원인을 잡았다"며 만든 것이었고 **한 번도 실행 검증하지 않았다.**
  → `scripts/test-translate-parse.mjs` 7/7 로 못박음(정상/잘림/코드펜스/배열/다국어키/오탐).
- **언어 누수 차단**(`143498b`): 언어판에서 그 언어 음성이 없으면 원어(중국어) 음성·원문 자막을 대신 넣던
  폴백 제거(번역만 있으면 무음+그 언어 자막, 둘 다 없으면 그 줄 제외). 음성이 0 이면 무음 영상을 만들지 않고 멈춘다.
  → `scripts/test-language-tracks.mjs` 9/9(원어 음성 유출 0 + 원어판 회귀 0).
- 더빙 전반: 전량 실패를 성공으로 끝내던 것 수정, 더빙 전용 로그(`dub:progress:*`)를 앱이 표시,
  오디오 제안이 잡 전체를 막던 것 제거(비언어 발성은 효과음 경로), 원어 더빙은 명시 버튼으로만,
  워커 큐에서 compose 를 맨 뒤로(더빙보다 먼저 실행돼 무음 합성되던 것), 더빙 비용(글자 수) 기록.
- **카메라**: 가속 줌(`zoom_accel` 0~12) + **느린 구간**(`accel_hold`)과 **크립**(`accel_hold_creep`) —
  "거의 멈췄다가 확" 을 구간으로 나눠 지정. 흔들림 기본 0(+`shake_hz` 속도, 기존 컷 일괄 끄기 버튼).
  **오빗+줌 동시**(궤도는 I2V·줌은 후처리), **계층 B 2레이어 렌더 구현**(매트로 인물/배경 분리),
  **인물 매트 자동 생성**(`worker/matte.mjs`, fal, 컷당 1회·재사용), 계층 B 2레이어 **미리보기**.
- **원터치**: 6단계 `🎬 최종본 만들기` 하나가 덜 된 번역·더빙 → 안 구운 카메라 굽기 → 합성까지.
  판단은 지문(`fx.sig`=카메라워크 해시, worker `camSig` ↔ `lib/cutClean camSig` 동일 규칙).
- 단계 번호: 카메라=5, 합성=6. 새로고침해도 단계 유지(주소 해시). 4·5단계에 앱 커밋 SHA 표시.

## ★이번 세션의 교훈(반드시 지켜라)
- **읽는 리뷰로는 안 잡힌다.** 한 달을 잡아먹은 파서 버그는 "정상 입력에서 조용히 빈 배열"이라
  diff 를 읽어선 안 보였고, **7줄짜리 실행 테스트로 3분 만에** 드러났다. 의심되는 함수는 **실행**해라.
- **조용한 실패 금지.** 이번에 나온 결함 대부분이 같은 유형이다(에러를 삼킴 / 0건인데 성공 / 폴백으로 원어).
  실패는 반드시 사유와 위치(컷 번호·대사 앞부분)를 남겨라.
- **로컬 `next build` 는 구글 폰트 다운로드가 간헐 실패**한다(변경을 stash 해도 실패 = 코드 무관).
  tsc·테스트로 대체 확인하고, 최종은 Vercel 빌드로 판단.

---

# (이력) 2026-07-24 상태

**배포 HEAD = `41215f5`** (확인: `git log origin/main --oneline -1`). push = Vercel(앱)+Render(워커) 자동 배포.
**워커 BUILD = `onebutton-v20`** — 로그 첫 줄로 배포 반영 확인.
**워커 BUILD 태그로 배포 반영을 확인한다** — 로그 첫 줄 `[worker] BUILD = ...`. 커밋마다 갱신할 것.
**★파일은 반드시 절대경로 `C:\myapps\re-animator\...` 로 확인하라.** (형제 프로젝트 `C:\myapps\aninews-maker21` 과 모델이 완전히 다름.)

## 사용자 상태 — 매우 중요
2주 넘게 납품이 막혀 크게 분노한 상태. **"지시를 무시한다", "매번 네가 에러를 만든다"** 가 핵심 불만이고 둘 다 사실이었다.
- **지시한 것만 해라.** 눈에 다른 문제가 보여도 손대지 말고, 하나 끝내고 확인받아라. 우선순위를 사용자에게 되묻지 마라(떠넘기지 마라).
- **"고쳤다"고 말하지 마라.** "이 조건에서 이렇게 확인했다 / 이건 미확인"으로만 보고.
- **로그 갖다 달라는 요구를 반복하지 마라.** 사용자가 지긋지긋해한다. 앱/워커가 스스로 남기게 만들어라.
- 욕설에 절대 맞대응하지 말고 존댓말·프로페셔널 톤 유지.

## ★내가 만든 사고 목록(재발 금지)
1. **OOM 4회** — ① OCR 병렬이 풀해상도 PNG 8장 보유 ② compose 에 별도 ffmpeg 패스 추가 ③ **1080p 상향 + 끝프레임 앵커(트림이 꺼짐)를 동시 투입** ④ 잡 사이 메모리 누적.
   → **메모리를 곱하는 변경은 한 번에 하나만.** 상쇄 조건(트림 등)을 먼저 확인할 것.
2. **프롬프트 길이 상한 초과** — 문단을 계속 덧붙여, 내가 넣은 수정(반복금지·입다물기·스토리)이 **전송 직전 잘려나가** 무효였다. 지금은 엔진별 예산(Kling 2400·MiniMax 1900)으로 조립 + 스모크가 감시.
3. **프롬프트에 동작 예시(침·멱살·발차기)를 넣음** → 모델이 없는 장면에 그 동작을 생성. **동작 이름을 예로 들지 마라.**
4. **배선 누락(가장 큰 부류)** — 만든 쪽과 읽는 쪽 필드가 달라 기능이 죽어 있었다. 아래 표 참조.
5. 편집 실수로 함수 정의 삭제, sed 재귀 치환 등 — **큰 치환 후 반드시 `node --check`·`tsc`.**

## 오늘(7-24) 고친 배선 결함 — 전부 같은 유형
| 만든 쪽 | 읽는 쪽 | 증상 | 커밋 |
|---|---|---|---|
| AI 연출 → `cut.motion` | 미리보기·굽기 → `cut.cameraWork` | 카메라워크 열흘간 정지 | `6b7c8d9`+`579e925`(티어 기본값 자동) |
| classify·dub → 효과음 생성 | compose 가 참조 안 함 | 효과음 안 들림 | `49d02de` |
| 번역 → tracks | compose 자막=번역/오디오=원문 | 자막·더빙 언어 어긋남 | `d247ded` |
| 워커 → 새 videoUrl | `vidPending` 옛 URL 비교 없음 | **새 영상 안 뜸(1주)** | `d247ded` |
| 번역 응답 잘림 | `catch{}` 가 덩어리 통째 폐기 | 번역 나오다 말다 | `e047137` |
| G1 저장 | 연출 필드 19개 미보존 | 경계 1px 드래그에 AI 연출 소실 | `f8a101d` |
| `toggleTargetLanguage` | setState 업데이터 안에서 값 계산 | **저장은 성공하는데 빈 배열이 저장** | `abe989b` |

## 오늘 새로 구현(스펙 §)
- **§1 업스케일**: 확대 지점에 lanczos+언샵(`7e334f2`). ESRGAN 신경망은 외부 키 필요 — 미구현.
- **§5 홀드/슬로우**: talk/action 슬로우 금지→마지막 프레임 홀드, idle/emote 만 0.8배(`1c909b9`).
- **§6 오디오 3트랙**: 효과음 믹싱(`49d02de`) + **BGM 업로드·자동 덕킹**(`513769b`).
- **§7 ASS 자막**: `worker/ass.mjs` 구현. **★기본 OFF(`ASS_ENABLE=1`)** — libass 가 Noto Sans KR 가변폰트를 못 찾아 자막이 아예 안 그려짐(실측). 고정굵기 TTF 번들하면 승격 가능.
- **§8② 프록시 렌더**: 480p "🔍 정확 미리보기"(`3c45656`). 본 굽기(fxUrl) 안 건드림.
- **§10 다국어**: 언어별 최종 출력 `composed-ja-*.mp4` + 5단계 UI 버튼(`09c612d`,`6db40a6`).
- **섹션**: 분할 끝나면 **시퀀스 자동 나누기**, 전 단계 상단 노출(`1d4f449`). 1단계 G1 도 섹션 단위 편집.
- **영상 프롬프트 직접 입력**: 기능은 원래 있었고 4단계 아코디언에 묻혀 있었음 → 카메라 탭에 노출(`6db40a6`). 값이 있으면 자동 조립 무시하고 그대로 전송(실측 확인).

## 오늘 오후 추가분 (7-24 후반)
- **G1 가로 조정**(`7f2edf4`) — 1단계 왼쪽 스트립에서 세로만 끌 수 있었다 → 좌·우 경계 핸들 추가.
- **효과음이 내레이터로 잡히던 것**(`7f2edf4`) — OCR 이 말풍선 밖 의성어를 bubbles 에 넣으면 화자가 null(내레이터)이라 내레이터가 읽었다. OCR 프롬프트 강화 + `normalizeSfx` 재판정(화자 미지정 줄 중 의성어만 `__sfx__` 로). 검증 22건 미탐·오탐 0. ★"짧은 한글+느낌표" 규칙은 뺐다(살려줘!/형! 이 효과음으로 잡히는 오탐).
- **재생성 인체 묘사**(`7f2edf4`) — ANATOMY 절(손가락 5개·관절·가려진 부위는 지어내지 말 것). ★상한 1600 에서 잘려 무효였던 걸 실측으로 잡아 순서 조정 + 상한 2600.
- **캐릭터 레퍼런스를 모든 재생성 경로에**(`80c6dc7`) — 전에는 gpt-image **full 경로에만** 들어갔다. 마스크 모드·Flux 는 레퍼런스가 아예 없어 모델이 얼굴을 지어냈다. `collectCastRefs()` 로 단일화해 세 경로 연결. Flux 는 kontext 가 이미지 1장뿐이라 레퍼런스 있으면 `kontext/max/multi`(image_urls)로 자동 전환. 참고이미지 0개인 인물 컷은 로그로 경고.
- **언어별 더빙 + 위치 정정**(`80c6dc7`,`add31b4`) — 더빙은 `workingLanguage`, 언어별 합성은 `payload.lang` 을 봐서 "일본어판인데 중국어 소리" 가 났다. `runDub` 이 `payload.lang` 을 받게 하고, 더빙 버튼을 **5단계→4단계**로 옮겼다(더빙은 4단계 기능).
- **조용한 원문 폴백 차단**(`158ecd7`) — 그 언어 번역이 없으면 원문을 더빙/자막으로 흘려보내 "더빙 두 번 눌러도 중국어" 가 됐다. 이제 번역 없는 줄은 건너뛰고, 대상이 0이면 진짜 원인("번역이 아직 없다")을 말한다. 언어판 합성도 번역 0이면 거부. "목소리 미배정" 에러에 어느 화자인지 표기.
- **★언어판 = 버튼 하나**(`41215f5`) — "번역 채우기 → 더빙 → 합성" 을 사람이 순서대로 누르게 한 게 잘못이었다. 4단계에 `[일본어로 만들기]` 하나(번역 없으면 자동으로 채우고 이어서 더빙), 옆에 `번역 12/34 · 더빙 0/34` 상태 표시. 5단계 언어판 합성도 덜 됐으면 알아서 선행. '지금 번역 채우기' 버튼 제거.
- **배치 버튼 숨김 제거**(`add31b4`) — '안 된 것만 N개'·'선택 N개 다시 생성' 을 조건부로 숨기고 있었다(내가 임의로 넣은 조건). 3·4단계 모두 항상 노출, 선택 0이면 비활성.

## ★OOM — 구조 변경했으나 미확인(최우선)
`eb45a24`: **잡 1개 = 자식 프로세스 1개**(`worker/runOne.mjs`). 워커가 장수 프로세스라 분할·추출이 올린 메모리(sharp/libvips·raw 버퍼)가 잡 후에도 OS 로 반환되지 않아, 다음 영상 잡의 ffmpeg 가 얹히면 터졌다 — **증상은 영상, 원인은 앞 잡**. 자식이 죽으면 전부 반환된다.
부수 효과: 잡 타임아웃이 **진짜 취소**(SIGKILL), 잡이 터져도 부모 폴러 생존.
같이: 해상도 720p 복귀(1080p 는 targetDims 가 720p 로 줄여 버리므로 **순수 낭비였음**), libx264 threads1·zerolatency, 영상 스트리밍 처리.
**→ 이게 OOM 을 잡았는지 아직 확인 안 됨. 첫 검증 대상.**

## 검증 도구(새로 만듦)
- `node scripts/smoke-compose.mjs` — **실제 ffmpeg** 로 오디오 조립·효과음 믹싱·자막·트림·concat·프롬프트 길이를 돌리고 **피크 RSS** 출력. 현재 9/9, RSS ~65MB. **push 전 반드시 실행.**
- `node scripts/test-camera-render.mjs` (11 pass) · `node scripts/test-camera-keyframes.mjs` (103 pass).
- 워커 배포검증: `grep -rn "from ['\"]\.\./lib" worker/*.mjs` 비어야 함 + 전 모듈 실제 로드(더미 Redis env).
- worker deps 로컬 설치됨(`worker/node_modules` — ffmpeg-static·sharp) → **로컬에서 ffmpeg 검증 가능**.

## 지금 사용자가 확인해야 할 것(순서)
1. **서버가 안 터지는가** — 영상 생성을 돌려 OOM 메일이 안 오는지. 로그에 `[mem] <잡> 피크 NNNMB`.
2. **새 영상이 화면에 뜨는가** — 재생성 후 🕐 시각이 바뀌며 카드가 갱신되는지.
3. **섹션** — 1단계 상단 `📚 섹션 (부분 작업)` 바, 분할하면 자동으로 섹션 탭이 생기는지.
4. **카메라워크** — 카메라 탭에서 프리뷰가 움직이는지(빈 컷도 티어 기본값 자동), 🔍 정확 미리보기.
5. **일본어판** — 4단계 `🎬 언어판 만들기 → [일본어로 만들기]` 한 번. 옆 숫자가 `번역 N/N · 더빙 N/N` 이 되는지. 그다음 5단계 `일본어판 합성`.
6. **효과음** — 자막에 효과음이 뜨지 않고 소리로 나는지. ★재판정은 **더빙을 다시 돌려야** 적용된다(normalizeSfx 가 dub/extract 에서 실행). 기존 데이터는 그래서 아직 자막으로 남아 있을 수 있음.
7. **캐릭터 얼굴** — 재생성 후 얼굴이 캐스팅과 맞는지. 로그의 `[진단] 컷 N 참고이미지 ← …` 가 안 찍히는 컷 = 레퍼런스 없이 그려진 컷.
8. **BGM** — 5단계에서 업로드 후 최종 합성에 깔리고 대사 구간에 눌리는지.

## ★사용자가 반복 지적한 UI 원칙(어기면 분노)
- **순서를 사람이 외우게 하지 마라.** 중간 단계를 버튼으로 노출하지 말고 자동으로 이어라('지금 번역 채우기' 사고).
- **기능을 조건부로 숨기지 마라.** 안 되는 상태면 비활성으로 두되 존재는 보여라(섹션 바·안된것만·선택생성 전부 이 문제였다).
- **기능은 그 기능이 속한 단계에 둬라.** 더빙 버튼을 5단계에 둔 것 같은 배치 오류 금지.

## 미구현으로 남은 것
- Real-ESRGAN 신경망 업스케일(외부 키 필요) · ASS 기본 승격(폰트 번들 필요) · 계층 B(인물/배경 매트 없음, 사용자 승인하 보류) · 프록시 캐시 무효화(camera_work 해시).
- **효과음 재판정 자동 적용** — 지금은 더빙/추출을 다시 돌려야 반영된다. 기존 데이터에도 바로 먹게 할 필요.

## ★사용자 환경 제약(내가 못 하는 것)
API 키 없음(생성·번역·더빙 실행 불가) · Render/Vercel 대시보드 못 봄 · 실제 프로젝트 데이터 없음 → **품질(번역·효과음 적절성·UI 사용성)은 사용자만 판단 가능.** 나는 크래시·OOM·필터 오류·회귀만 잡을 수 있다.

---

## (이력) 2026-07-23 상태 — 이어받는 세션은 이 블록만 먼저 읽어라

**배포 HEAD = `7a69579`** (확인: `git log origin/main --oneline -1`). push = Vercel(앱)+Render(워커) 자동 배포.
**★파일은 반드시 절대경로 `C:\myapps\re-animator\...` 로 확인하라.** (형제 프로젝트 `C:\myapps\aninews-maker21` 와 헷갈려 aninews 의 compose 라우트를 re-animator 것으로 착각한 사고가 있었다. aninews 롱폼(`format:"long"`·`sections[].segmentIds`)은 **re-animator 와 전혀 다른 모델**이다.)

## 지금 최우선: 1단계(컷 분할) 성능/메모리 — 사용자 검증 대기 중
첫 단계가 병목이면 툴을 못 쓴다며 사용자가 크게 분노한 상태. 경과:
1. **먹통(hang)** — `긴 구간 분할 검사`(splitTallRegions→vlmSplitCut)에서 수십 분 정지. 원인: 초장문 구간을 `extractRegion`(거대 버퍼+PNG)·`computeBoundaryness`(거대 raw+동기 픽셀 루프)로 처리 → **이벤트 루프가 막혀 12분 잡 캡 타이머조차 못 뜸.**
   → **해결 `5ff5816`**: `extractRegion(…, maxH)` 세로 다운샘플 옵션 추가 + `vlmSplitCut` 이 저해상도(`SPLIT_ANALYZE_H`, 기본 4000)로 분석하고 **분할 좌표를 분석높이→구간높이로 되돌림**. 긴 구간도 **스킵 없이 정상 자동 분할**. (그 전 `eae14e5` 의 "상한 초과 스킵"은 사용자가 "스킵은 해결이 아니다"라고 거부해 폐기.)
2. **OOM** — 내가 넣은 tall-split 병렬화(동시 3)가 `fileRawAt` full-file raw 디코딩(파일당 수십 MB·LRU 3)을 동시에 터뜨려 Render 워커 메모리 초과 재시작. → **`71e7dd7` 로 동시성 1 복귀.**
3. **속도** — 사용자: "인스턴스 상향해도 속도는 그대로 아니냐"(정확한 지적). 진짜 병목은 메모리가 아니라 **AI 호출 대기의 직렬화**.
   → **`7a69579`**: OCR(대사 읽기)을 **준비(순차 디코딩 1개씩)/호출(VLM 병렬 8개)** 로 분리. 동시 디코딩 3→1(메모리↓) + 네트워크 대기 겹침(속도↑).

**→ 사용자가 분할을 다시 돌려 결과를 알려주기로 함: "괜찮다 / 여전히 느리다 / 또 터졌다".**
- **느리다** → `splitTallRegions` 에도 같은 준비/호출 분리 적용, `SPLIT_OCR_NET_CONCURRENCY` 상향.
- **터졌다(OOM)** → `SPLIT_OCR_NET_CONCURRENCY=4`, `RAW_FILE_CACHE=1` 로 낮춤.
- ★사용자는 **"인스턴스 계속 상향"을 거부**한다. 돈이 아니라 **구조로** 해결할 것.

**튜닝 env(Render 워커, 코드 배포 없이 조정 가능):** `SPLIT_OCR_NET_CONCURRENCY`(8) · `SPLIT_TALL_CONCURRENCY`(1) · `RAW_FILE_CACHE`(3) · `SPLIT_ANALYZE_H`(4000) · `SPLIT_PREVIEW_SOFT_MS`(9.5분).

## 이번 세션에 새로 만든 것 (전부 push, 배포 검증 대기)
- **🎥 카메라 미리보기 탭**(`c5b4a5a`) — 4단계에서 카메라워크를 분리한 전용 탭(A안). `activeStep` 에 **UI 전용 'camera'** 만 추가(steps 레코드 무변경 → 옛 프로젝트 안전). 프리뷰 박스 **hover 시 실제 영상 위 실시간 카메라**(`70eb855`), 클릭=결과 모달. 오빗은 굽기가 아니라 **영상 생성 때** 적용 → "🎬 오빗으로 영상 재생성" 버튼(`1e4cc52`).
- **카메라 톤**(`1e4cc52`→`a325a5f`) — 사용자 지정 "동작은 작게, 카메라워크는 **MV보다 더 거칠게**": 프리셋 대폭 상향(push_in 8%/s·pan 60px/s·crash 15·shake amp 24) + push/pan/crash 에 **핸드헬드 그레인**. 줌 슬라이더 ±15, 흔들 슬라이더 노출. **`lib/` 와 `worker/` 의 cameraKeyframes.mjs CAMERA_PRESETS 는 반드시 동일값 유지**(다르면 프리뷰≠굽기). 골든 테스트 103 pass·렌더 11 pass.
- **📚 섹션(부분 작업)** — 사용자 아이디어. 데이터는 가산만: `Project.sectionStarts`(섹션 시작 컷 인덱스) + `Project.sectionVideos`(섹션별 합성본 URL).
  - Phase 1(`629b12d`): 섹션 바(3·4·카메라 단계), 섹션 선택 시 **목록·일괄작업(재생성/영상/더빙/카메라굽기)이 그 섹션만** 대상. 섹션 없으면 기존 전체 동작 그대로.
  - **🤖 시퀀스 자동 나누기**(`6fc6ea2`): 워커 잡 `sequence`(`worker/sequence.mjs`, Claude 텍스트만·90s 타임아웃·자기완결)가 컷 type/setting/description 으로 **서사 시퀀스 경계** 산출 → sectionStarts.
  - **방향 B**(`1274c7d`): **섹션별 합성 잡 + 최종 join**. `runCompose(payload)` 가 sceneIds면 그 섹션만 합성→`sectionVideos[key]`, `runJoin` 이 섹션 합성본들을 concat(`-c copy`)→`composedUrl`. 한 잡=섹션치 → 디스크·OOM 안전판·실패 격리. 잡 타입 `join`(compose 처럼 sharp 무관 경로). **섹션 경계 전환은 현재 하드컷**(페이드는 후속).
- **버그 수정**(리뷰 기반): `178b8e7` 이미지 생성 중 편집한 대사가 pollRegen 통째교체로 사라지던 것(필드 병합) · `6d588c7` /api/cut 통째 저장이 워커 오디오 URL 덮던 레이스(`preserveWorkerAudio`) · `da5a4e6` runSplit 경계 소실/Kling 비용 오귀속/ffmpeg 고아 프로세스 · `3e0052f` 언어 토글 stale · `d4a2d1b` 감정 select 접힘 밖 노출 · `ce02e50` "🎞 다음 컷 액션연결" 라벨 · KST 시간(`5ff5816`).

## 배포 검증 안 된 것(로컬에 키·데이터 없어 빌드/로드만 검증)
카메라 미리보기 탭·실시간 오버레이 · 섹션 Phase1/2 · 시퀀스 자동 나누기 · 섹션별 합성/최종 join. **사용자가 배포에서 확인해야 함.**

---

## ★★★ (이력) 2026-07-20 후반 — 앱이 버그투성이였던 시점

이번 세션에 `re-animator-spec.md`(연출 레이어)를 통째로 구현하며 **너무 많이·너무 빨리 바꿔서 앱이 여러 곳 깨졌다.** 사용자가 크게 분노한 상태. **새 기능 추가 금지. 지금은 버그를 제대로 잡는 게 전부다.** 증상마다 찔러 고치지 말고, **바뀐 코드(`bb9adc9..HEAD`)를 체계적으로 리뷰해서 진짜 결함을 찾아 고쳐라.**

**★★ 가장 큰 교훈(이미 한 번 대형 사고):**
1. **워커는 자기완결이어야 한다 — `../lib` import 절대 금지.** Render 워커는 `rootDir: worker`라 워커 폴더 밖(`../lib/...`)을 import하면 `jobs.mjs` 로드가 깨져 **모든 워커 잡(분할·재생성·영상·더빙)이 죽는다.** 이게 "재생성 안 됨·동영상 안 됨"의 뿌리였다(수식 모듈을 `worker/cameraKeyframes.mjs`로 복사해 고침, `dee0035`). 워커 배포 검증에 **`grep -rn "import.*\.\./lib" worker/*.mjs` 가 비어야 함**을 넣어라.
2. **워커는 단일 스레드(한 번에 한 잡).** 느리거나 매달리는 외부 호출(Claude·OpenAI·Kling) 하나가 워커 전체를 "먹통"으로 만든다. **모든 외부 호출에 타임아웃이 있어야 한다.** translate.mjs 는 90s 캡 넣음(`d6e80de`) — grok.mjs·kling.mjs·classify.mjs·ocr.mjs·director.mjs 등 **전부 타임아웃 있는지 점검.**
3. **자주 push해서 배포로 검증하는 건 맞다(사용자 확인).** push를 아끼지 마라. 단 in-flight 잡은 재배포 때 죽으니, 사용자가 돌리는 중이면 감안.
4. **진짜 문제는 코드 품질이다.** 추측·땜질 말고 정독·검증. 사용자 왈 "네가 코드를 잘 짜면 안 생길 문제들."

**★★ 2026-07-21 재리뷰 완료 — 확정 결함 6건 수정·push(4aa9e5b..HEAD). 아래 옛 목록은 이력.**
이번 세션(2026-07-21): general-purpose 에이전트 2개로 `bb9adc9..HEAD` 전 diff 재정밀 리뷰 → CRITICAL 0, `../lib` 실제 import 0(주석뿐), 변경된 외부 호출 전부 타임아웃 확인, 화이트리스트 누락 데이터 소실 0. **고친 것(커밋):**
- `da5a4e6` ① runSplit 경계 소실 — 필수 경계 저장이 무거운 프리뷰(OCR·교정·번역) 뒤라 12분 캡 초과 시 통째 버려짐 → 프리뷰에 soft deadline(t0+9.5분, env `SPLIT_PREVIEW_SOFT_MS`) → 캡 전 멈추고 저장 보장(못 읽은 대사는 추출 2단계가 채움). ← "OCR교정 다음 멈춤/실패"의 진짜 원인. ② Kling 클립 Grok 단가·xai 벤더 오청구 → engine 별 분기. ③ ffmpeg spawn 고아→OOM: cameraRender run/probeRaw + conformVideo 에 타임아웃+SIGKILL(run 4분·conform 3분·probe 30초).
- `6d588c7` ④ /api/cut 통째 저장이 동시 워커 오디오 URL(bubbles·tracks·narration·sfx·audioSuggestions) 덮던 레이스 → `preserveWorkerAudio`(클라 미전송 오디오 필드만 서버값 복원, 배열은 인덱스+텍스트 가드). 저장 규약 준수.
- `3e0052f` ⑤ 대상 언어 토글 stale 클로저 유실 → 함수형 업데이트.
- (다음 커밋) ⑥ 잡 타임아웃 로그 "8분"→상수 반영(index.mjs).

**★ 아직 열린/미확정(사용자 확인·결정 필요):**
- **[결정 필요] 동영상 16:9인데 정사각형 + "동영상 안 됨/크래시".** conformVideo 필터 코드는 **정상 확인**(16:9→1280×720). 정사각형 = conformVideo 가 null(ffmpeg 실패) 후 원본 폴백 → **워커 로그 `[conformVideo] 비율 맞춤 실패` 문구로 실제 ffmpeg 에러 확인 필요**(추측 금지, spawn 타임아웃 넣어 '매달림'은 배제됨=진짜 에러). **더 큰 리스크: Kling 이 기본 엔진(`jobs.mjs:1598`, 키 있으면)인데 API 2.0 계약이 실제 키로 미검증** — 계약이 틀리면 모든 Kling 컷 실패. 코드는 내부 일관·타임아웃 안전하나 라이브 검증 전엔 확신 불가. 동영상이 계속 실패하면 **기본을 Grok 으로 되돌리고 Kling opt-in** 이 안전(단 전역 기본 변경이라 사용자 승인 후). → 사용자에게 질문함.
- **재생성 이미지 가끔 안 뜸** — runRegen 은 `bb9adc9..HEAD` 범위 밖 → 이번 세션 변경이 원인 아님. `🔄 새로고침`(bd36f4d)로 미봉. 재현 시 별도 조사.
- (LOW) 액션/보간 클립 길이: Kling min 3s vs estimateVideoSeconds 1-2s — compose 트림 확인(품질, 크래시 아님).
- (UX) §9 아코디언 단일 펼침 — 컨트롤 삭제 아님(의도 설계), 여러 컷 동시 비교 불편하면 openScene→Set.

<옛 목록 — 이력>
- ~~분할 OCR교정 다음 멈춤~~ → ① 로 해결.
- ~~동영상 정사각형~~ → conformVideo 정상 확인, 위 [결정 필요] 참조.
- ~~재생성 이미지 안 뜸~~ → 범위 밖, 위 참조.
- ~~동영상 크래시~~ → `../lib` 회귀 없음·타임아웃 확인, 위 Kling 결정 참조.
**★ 코드 리뷰 결과(확정/유력 버그, 심각도순 — file:line):**
1. **[HIGH] 동영상 크래시 유력 원인 = Kling 이 기본 엔진인데 계약 검증 안 됨.** `worker/jobs.mjs:1598` 이 `KLING_API_KEY` 있으면 Kling 기본(사용자에게 키 넣으라 했음) → 모든 컷이 Kling 경로. `worker/kling.mjs`는 내부 일관되나, 리뷰어가 "표준 Kling Open Platform 문서(구형: `/v1/videos/image2video`, flat body, AK/SK→JWT)와 다르다"고 지적. **단 나는 브라우저로 현재 공식 문서(kling.ai/document-api, API 2.0: `/image-to-video/{model}`+contents/settings+`/tasks` 폴링+단일 Bearer)를 직접 읽고 그대로 구현함** → 어느 게 맞는지 **실제 키로 라이브 검증 필수**. 크래시가 계속되면 **일단 기본을 Grok 으로 돌리고(jobs.mjs:1598 의 `hasKling ? "kling":"grok"` → grok 기본), Kling 은 검증될 때까지 opt-in** 으로. (참고: 초기 크래시는 `../lib` 회귀였고 이미 고침 — Kling 이 진짜 원인인지 재확인.)
2. **[HIGH] 정사각형 출력 = conformVideo 런타임 실패 → 원본 폴백.** `jobs.mjs:1677` `conformVideo(raw,p) ?? stripAudio(raw) ?? raw`. targetDims 는 16:9→1280×720 맞음(우회 아님). conformVideo 가 **throw 하면** raw(엔진 native aspect, 예 Kling 1:1)가 그대로 나감. 메커니즘 확정. **워커 로그의 `[conformVideo]` 문구(f31b975)로 ffmpeg 실패 원인 확인** 후 그 지점 수정.
3. **[확정→고침, 잔여 있음] 분할 OCR교정 다음 먹통 = Claude 타임아웃 없음(고침 d6e80de).** 잔여: `worker/index.mjs:63-75` JOB_TIMEOUT 이 `Promise.race` 로 **거부만 하고 실행 중 잡을 취소 안 함** → 타임아웃된 잡이 백그라운드로 계속 돌며 다음 잡과 겹침 → 메모리 빡빡한 워커 OOM 위험. Kling(컷당 최대 10분 폴링)이 12분 전체캡과 겹쳐 악화. (사소: 타임아웃 메시지 "8분"인데 상수는 12분 — index.mjs:44 vs 69.)
4. **[LOW] Kling 비용 오계상.** `jobs.mjs:1684` 이 엔진 무관하게 `GROK_VIDEO_COST` 사용·`vendor:"xai"` 기록. `KLING_VIDEO_COST` import 됐지만 미사용. 기능 무영향.
5. **[UX, 크래시 아님] "이미지 안 보임" = §9 아코디언이 펼치기 전엔 본문(큰 이미지/영상)을 숨김** — 접힌 줄엔 8×12 썸네일만. 의도된 설계지만 사용자가 불편해함. + 3단계 상태 동기 갭(🔄 새로고침 버튼으로 미봉).
6. **[깨끗] 화이트리스트 완전(데이터 소실 없음), worker/cameraKeyframes.mjs 는 lib 복사본과 심볼 동일, compose 작업언어·whip null-safe, classify 스키마 일관, Studio nextGenByScene 진짜 O(n).**

**새 세션 우선순위: (1) Kling 라이브 검증 or Grok 기본 복귀 → 동영상 살리기, (2) conformVideo 로그 보고 정사각형 고치기, (3) index.mjs 잡 타임아웃 취소/겹침 방지.**

**남은 미구현(버그 다 잡은 뒤에):** §9 씬별 앞/뒤 단계 이동 화살표(task #7). Phase 8 나머지(오디오 제안을 compose 출력에 믹싱·BGM 3트랙 덕킹·언어별 출력잡·프록시 렌더). 다국어는 "일본어 우선 제대로"가 목표(workingLanguage→더빙/자막/표시가 tracks[lang] 사용, 배역 목소리는 멀티링구얼이어야 일본어 발음).

**이번 세션 주요 커밋(전부 push됨):** 9123986(P1 수식) c317a43(P2 워커렌더) b804f30(P3 프리뷰) 4c3c48b·9aa4229(P4 VLM티어/오디오제안) 055476f·33b0ed1·2699e22(P5 다국어) ddc2275·bb5174f·7329b3d(Kling 엔진→단일APIKey→API2.0) 495c020·e13a4a3·a29ba3c·3d6a6b6(보간·orbit·crash·whip) 31c0e5f·9be9d99(오디오제안 UI·생성) 6d033d4·2d384c6(작업언어 더빙/자막) e76bd3f·5c08c37·7a3cfea·d2018b5(§9 UI 정리·썸네일·보간토글·O(n)) **dee0035(★워커 자기완결 — ../lib 제거)** f31b975(conformVideo 로그) bd36f4d(새로고침) d6e80de(★번역 타임아웃).

---

## ★ 이번 세션(2026-07-20) 요약 — 연출 레이어 스펙 구현 착수

`re-animator-spec.md`(v0.2, 이번에 성문화)의 "연출 레이어(카메라워크·모션 티어·오디오 채움·프리뷰·다국어)"를 §11 순서로 구현 시작. **Phase 1-3 + Phase 4 그라운드워크 완료·전부 push·배포 반영.** 사용자는 자던 중이라 무인 진행 — "데이터 날려먹지만 않으면 돼"가 하한이라, 검증 불가·데이터 위험 큰 단계는 안 하고 안전한 것만 했다.

**완료(커밋):**
- `9123986` Phase 1 — 카메라워크 **수식 모듈 단일 소스** `lib/cameraKeyframes.mjs`(순수 ESM·무의존): `CameraWork → 정규화 키프레임 테이블`. 계층 A(단일 crop track)/B(character·background 2 track)/C(orbit=I2V 위임). 헬퍼 `toPixelCrop`(워커), `toWebTransform`/`toWebKeyframes`(웹), 시드 PRNG 셰이크, **가시범위 clamp**(scale 여백 밖 이동 흡수 → 워커·웹 좌표 구조적 일치). `lib/types.ts` 카메라 타입. 골든 테스트 `scripts/test-camera-keyframes.mjs` **103 pass**(워커↔웹 2px).
- `c317a43` Phase 2 — 워커 렌더러(계층 A) `worker/cameraRender.mjs`: 테이블의 리터럴 픽셀 crop 을 ffmpeg **sendcmd**(crop w/h/x/y = T 플래그 런타임 command)로 프레임마다 재생. **zoompan 수식 직접 기술 금지 준수**. 단일 패스 스트리밍(합성 OOM 회피). `runCameraFx` 잡 + `camerafx` 타입(index.mjs/jobQueue.ts) + `/api/camerafx`. 통합 테스트 `scripts/test-camera-render.mjs` **11 pass**(실제 ffmpeg·psnr). 기존 `runPostfx`(effect/strength) 유지.
- `b804f30` Phase 3(부분) — `app/project/[id]/CameraWorkEditor.tsx`: 정지이미지 위 **Web Animations 근사 프리뷰** + 슬라이더(preset·길이·줌속도·드리프트·시작줌·배경델타·흔들). 저장 = `cameraWork` JSON(`updateCut`). "적용(굽기)" = camerafx. "근사"/orbit "프록시 렌더 필수"/계층B "매트 후" 라벨. Studio 씬 카드 삽입(기존 ⚡후처리 카메라와 **공존**). **cameraWork 저장 위치 = `CutOntology`**(Scene 아님) — 앱 저장 경로가 cut 기반(/api/cut+화이트리스트 cleanCut)이라 재사용+소실 회피. `cleanCameraWork` 추가.
- `4c3c48b` Phase 4 그라운드워크 — `CutOntology`에 `motionTier`/`tierConfidence`/`tierEvidence`/`motionPromptHint`/`interpolationCandidate`(§3·§4)+`audioSuggestions`(§6). `cleanCut`/`cleanAudioSuggestions` 화이트리스트.
- `9aa4229` Phase 4 VLM 산출 — `worker/classify.mjs` strict 스키마+`config/prompts.json`에 motion_tier(talk/idle/emote/action)·tier_confidence·tier_evidence·motion_prompt_hint·interpolation_candidate·audio_suggestions 추가. normalizeCut 이 snake_case→camelCase 매핑. **분류 로직·기존 필드 무변경(가산)**. (사용자가 "푸시 안 하면 검증도 안 된다"며 명시 허용 → 배포 검증 대상.)
- `055476f` Phase 5(기반) 다국어 — **하위호환 재구조화**: `DialogueBubble.tracks`(BubbleTrack), `Project.targetLanguages`, `LANGUAGES`/`LANG_SPEED_CPS`. 기존 필드 불변(text=원어·translation=한국어), tracks 가산. `cleanTracks` 화이트리스트. `worker/translate.mjs` `translateToLanguages`(한 콜 동시번역)+`translateScenesMultilang`(말풍선→tracks[lang].text). jobs.mjs extract 에 **targetLanguages 있을 때만** 조건부 배선(미설정=무영향·회귀 0).
- `33b0ed1` 대상 언어 선택 UI — 스토리 맥락 아래 "🌐 대상 언어" 토글(ja/en). 켜야 다국어 번역이 돈다.
- `41cc61a` §9 씬 목록 아코디언 재정의 — 접힌 줄 4요소(대사 한국어주·원어보조 / 길이 / 발화자 / 모션티어 드롭다운), 펼치면 기존 카드 본문 전부. 상단 "미결만 보기"·"삽입 대사 일괄 끄기". ★기능 제거 아님(본문 조건부 래핑, 카드 시작·끝 2지점만 수술). 다중선택 체크박스는 펼침 본문으로 이동(트레이드오프).

**핵심 아키텍처 원칙(회귀 금지):** 카메라워크 수식은 `lib/cameraKeyframes.mjs` **한 곳**에만. 워커·웹앱은 그 테이블만 소비(두 벌 구현 금지). 셰이크는 shake_seed 시드 PRNG 로 양쪽 동일 궤적. 계층 B(parallax/vertigo)는 **인물/배경 매트가 없어 현재 스킵**(사용자 승인 — 온디맨드 매트 확보 후). orbit 은 I2V 위임(후처리 없음).

**남은 것(다음 세션 — 대부분 배포 env·API 키 필요해 로컬 검증 불가):**
1. **~~§9 접힌 씬 줄 재정의~~ [완료 41cc61a]** — 배포 후 확인: 4단계 씬 목록이 접힌 4요소 줄로 뜨는지, 줄 클릭 시 펼쳐 기존 컨트롤 다 보이는지, 모션티어 드롭다운·"미결만 보기"·"삽입 대사 일괄 끄기" 동작하는지. (다중선택 생성 체크박스가 펼침 안으로 들어감 — 불편하면 접힌 줄 복귀 요청.)
2. **Phase 5 나머지(다국어 완성):** 작업 언어 토글(ja/en 화면 전환), G1 다국어 셀(원어/한국어/언어 전체 표시·수정), 언어별 TTS(tracks[lang].audioUrl)·ASS 자막·duration_final, compose 언어별 출력 잡(ep01_ja.mp4/ep01_en.mp4). 데이터·번역 기반은 완료됨.
3. **~~Phase 6 티어→I2V~~ [완료 734f1e3]** — estimateVideoSeconds 티어 길이범위, buildVideoPrompt action 절제완화·motionPromptHint 사용. 남은 것: duration 2단계(est/final)·트림/홀드/슬로우는 TTS 도착 의존 → Phase 8. (배포 후 확인: 컷 모션티어 바꾸고 재생성 시 길이·동작 결이 티어대로 나오는지.)
4. **Phase 7** crash_zoom 3프레이밍 잡 + 병합 확장 동작 보간 + orbit I2V 경로.
   - **[진행] I2V 엔진 Kling 전환(ddc2275):** Grok 은 끝 프레임 미지원 → Kling 채택(worker/kling.mjs, image_tail). 기본 Kling(키 있으면)·없으면 Grok 폴백. UI 🎬 영상 엔진 토글. **★사용자 할 일: Kling 가입 → AccessKey/SecretKey 발급 → Render 워커 env 에 KLING_ACCESS_KEY·KLING_SECRET_KEY 추가.** 넣기 전엔 Grok 으로 폴백됨.
   - **[완료]** 동작 보간(495c020, 구조 변경 없이): 컷별 🎞 동작 보간 토글 → 끝 프레임=다음 연속 컷 이미지 자동. orbit(e13a4a3): I2V 궤도 카메라. crash_zoom(a29ba3c): 와이드·바스트·ECU 하드컷. whip(3d6a6b6): compose 경계 모션블러.
5. **~~Phase 8~~ [부분 완료]** — 오디오 제안 UI(31c0e5f)·생성(9be9d99, dub 에서 sfx/발성 TTS→audioSuggestions[].audioUrl). **[남음, compose 대수술·키 필요]:** ① 오디오 제안을 compose 출력에 실제 믹싱(현재 생성만·미재생) ② BGM 3트랙·덕킹(BGM 소스 기능 없음) ③ 언어별 TTS(tracks[lang].audioUrl)·ASS 자막·언어별 출력 잡 ④ 프록시 렌더(카메라 정확 미리보기 480p). — compose.mjs 는 OOM 민감(메모 참조), 로컬 검증 불가라 신중히.
5. **Phase 8** 오디오 채움(audioSuggestions→sfx/vocal/insert 생성) + 오디오 3트랙 덕킹 + whip·이펙트 오버레이 + 프록시 렌더 + 언어별 출력.

**배포 후 사용자 검증 항목:**
- (카메라) 4단계 씬 카드 "🎥 카메라워크" 편집기 표시, 프리셋·슬라이더 프리뷰 동작, "적용(굽기)" 후 fxUrl 갱신·미리보기 반영.
- (VLM) 프로젝트 재분할/재추출 후 `scene.cut.motionTier`·`audioSuggestions` 채워지는지(worker 로그).
- (다국어) 프로젝트 설정 "🌐 대상 언어"에서 ja/en 켜고 **재추출**하면 워커 로그에 "다국어 번역(ja·en) N줄", `bubble.tracks.{ja,en}.text` 채워지는지. 미선택이면 기존과 동일해야(회귀 0).
- 로컬엔 키·env 없어 실제 생성·굽기·번역은 배포에서만 검증 가능.

## 0. 무엇보다 먼저 — 배포 규칙 (직전 세션 최대 사고)
- 앱은 **Vercel**, 워커는 **Render**. **`git push origin main` 하면 둘 다 자동 배포**된다. 로컬 편집·빌드만으로는 배포된 앱에 아무 변화가 없다.
- 직전 세션에서 나는 **하루 종일 코드만 고치고 빌드만 하고 커밋·푸시를 한 번도 안 해서**, 사용자가 "다 됐다는데 화면엔 아무것도 없다"며 크게 분노했다. **작업이 끝나면 반드시 커밋·푸시하고, "됐다"고 말하기 전에 배포 반영까지 확인하라.**
- 나는 Render/Vercel 대시보드를 볼 수 없다. 배포 완료는 사용자가 확인하거나, UI에 새 요소(예: 새 버튼)가 보이는지로 판별한다.
- 로컬에 API 키 없음 → 실제 생성은 배포 후 사용자만 검증 가능. `tsc --noEmit` + `next build`(앱), `node --check`(워커) 로 빌드만 검증한다.

## 1. 프로젝트 개요
- 웹툰 이미지 → 5단계로 동영상 제작: **1) 소스·컷 분할 → 2) 캐스팅 → 3) 이미지 재생성 → 4) 동영상 생성·더빙 → 5) 합성**.
- 아키텍처: Next.js 앱(Vercel) + 워커(Render, `worker/`) + Upstash Redis(잡 큐·진행로그) + Vercel Blob(이미지·영상). 앱이 `lpush(jobq:<type>, id)`, 워커가 `rpop`으로 소비.
- 핵심 파일: `app/project/[id]/Studio.tsx`(메인 UI·거대함), `CastReview.tsx`(캐스팅), `worker/jobs.mjs`(runSplit/runCast/runRegen/runVideo/runDub/runPostfx/runCompose 등), `worker/compose.mjs`(합성), `worker/grok.mjs`(Grok I2V), `worker/fal.mjs`(fal), `worker/tts.mjs`, `worker/regen.mjs`, `worker/director.mjs`, `lib/types.ts`, `lib/cutClean.ts`(말풍선 저장 화이트리스트), `app/api/{cut,dub,video,postfx,cast,project/[id],cancel,scene}/route.ts`.

## 2. 데이터 모델 핵심
- **말풍선(cut.bubbles)이 대사의 정본**. 각 bubble: `text, translation, speakerId(캐릭터id|null=내레이터|"__sfx__"=효과음), audioUrl, subtitleX/Y, emotion, volume, distant, noSubtitle`. `cut.dialogue`는 레거시 폴백.
- **내레이션도 대사다** — 별개 필드 아니라 `speakerId=null`인 말풍선. 절대 분리 UI 만들지 마라.
- CutOntology 주요: `type, description, motion(=cut.motion, ★사실상 죽은 필드—실제 카메라는 postfx), action, bodyMotion, videoPrompt, videoPromptOverride, durationSec, transition, subtitleX/Y, noCastRef, animatePicture, confirmed`.
- Project: `storyContext, dubSpeed(기본 1.2), narratorVoice, aspectRatio, cast[]`.

## 3. 직전 세션에서 구현/수정한 것 (전부 push 됨, HEAD 근처)
**영상(I2V) 프롬프트 로직 (worker/jobs.mjs buildVideoPrompt):**
- `CAMERA_STATIC`(카메라 정지—카메라워크는 postfx 담당) + `SUBTLE_LIFE`(동작 크기 상한, "크거나 빠른 동작 절대 금지, 부족한 쪽으로") + `PICTURE_STATIC`(사진·초상·표지·화면 속 인물은 정지, 단 `cut.animatePicture`면 생략).
- **립싱크 규칙**: `hasSpokenDialogue(cut, shownCharIds)` — 화자가 **이 컷에 보이는 인물(캐스팅 sceneIds 기준)**일 때만 `SPEAKING_GUIDANCE`(입 움직임). 그 외(대사 없음·내레이션·다른/화면밖 화자)는 전부 `MOUTH_CLOSED_GUIDANCE`(입 다물기 강제). shownCharIds는 runVideo에서 `p.cast.filter(c=>c.sceneIds.includes(s.id))`.
- **인물 몸동작 버튼**(`bodyMotion`): still/sway/walk-in/walk-out/run/turn/gesture — BODY_MOTION_PROMPTS로 매핑, 전부 절제.
- **스토리 맥락**(`project.storyContext`): 모든 영상 프롬프트에 주입, "맥락과 모순되는 동작 금지(죽어가는데 벌떡 등)".
- **프롬프트 직접 편집**(`cut.videoPromptOverride`): 있으면 자동 조립 무시하고 그대로 Grok에 전송. UI에 "🎬 프롬프트 직접 편집" 접이식 + "기본값 불러오기".
- **영상 비율**: `conformVideo`가 Grok 출력을 프로젝트 비율로 채워-크롭(1:1→1024², 9:16→720×1280, 16:9→1280×720). Grok이 입력과 무관하게 가로형 내던 것 교정.

**후처리 카메라(postfx, worker runPostfx — 실제 카메라워크):** crash-in/out, ramp-in, punch(줌·흔들) + **느린 팬(pan-left/right/up/down)**. fxUrl에 실픽셀로 구움. UI ⚡후처리 카메라 + 강도 + 적용 + **🎥 굽고 보기**(굽고 미리보기 자동 오픈).

**버그 수정(중요):**
- **fxUrl stale 버그**: 영상 재생성 시 낡은 fxUrl/fx를 안 지워서 카드·미리보기(`fxUrl ?? videoUrl`)가 옛 영상을 계속 보여줌 → "다시 생성해도 똑같다". runVideo flush에서 새 videoUrl 넣을 때 `delete s.fxUrl; delete s.fx`. + pollScene이 fxUrl/fx 병합. + **🧹 카메라효과 전체 해제** 버튼(postfx none, 토큰 0으로 원본 복구). + 각 컷에 **🕐 생성 시각 표시**(videoUrl/fxUrl 파일명 타임스탬프 파싱—재생성이 진짜 새 영상 만들었는지 판별용).
- **더빙 이중 실행**: /api/dub가 scene 단계를 running으로 박아 워커가 안 풀어서 pollScene이 같은 진행을 재표시 → 유령 반복. /api/dub에서 setStep 제거(더빙은 dubbing 상태+jobId로 독립 추적) + 클라이언트 `dubStartingRef` 동기 가드.
- **효과음 통제 줄**: 검출 sfx를 `__sfx__` 말풍선으로 자동 등록(normalizeSfx), ElevenLabs sound-generation으로 생성, 자막 제외.
- **자막 제외**(`bubble.noSubtitle`): 비명·효과음성 대사를 소리는 유지하되 자막에서 뺌. compose·미리보기 양쪽 제외.
- **오디오 볼륨·거리감**(`bubble.volume`, `bubble.distant`): compose에서 ffmpeg volume + lowpass/aecho(멀리서).

**UI:**
- 캐스팅: 플로팅 리모컨에 **캐스팅 확정** 버튼 + 재캐스팅은 확인 팝업(수동 작업 보호), **＋ 새 캐릭터** 박스, 미배정 컷에도 큰 확대경.
- **연출 보고서를 컷마다 접이식**(`directionPanel` → 각 카드 "🎬 연출 보고서 (이 컷)"): 대사(역)·화자·감정·카메라·길이·전환·동작. 큰 표와 같은 updateCut로 싱크.
- 합성(5단계)에도 대사 편집기, 대사 드래그앤드롭(카드 간 이동, ⠿핸들+▲▼순서), 동영상 프롬프트 필드.
- 모든 작업 진행바(단계무관 우하단 workLabel+미니바), **추정 제작비 상시 플로팅**(하단 왼쪽), 더빙/동영상 각각 정지 버튼.
- 미리보기 모달 영상에 `loop`(2초 카메라워크가 스쳐 안 보이던 것).

## 4. 지켜야 할 사용자 규칙 (어기면 분노)
- 내레이션=대사(분리 금지). 립싱크=보이는 화자만(회귀 금지). 동작은 절제(크면 안 됨). 사진 속 인물 정지(기본, 토글로 예외).
- 재생성 여백=같은 화풍으로 새로 그리기(아웃페인팅), 프로젝트 비율로. 네이티브 비율로 멋대로 바꾸지 마라.
- 안 시킨 기존 기능 빼지 마라. 전역 기본값·config 명시 요청 없이 바꾸지 마라. 검증 없이 "진짜 원인" 확정 선언 금지(가설이라 말하라).
- 톤: 사용자가 욕해도 **절대 따라 욕하지 말고 프로 유지**. 변명보다 사실·수정.

## 5. 미해결 / 다음 할 일
- **[2026-07-20 해소]** 카메라워크 방향 확정 — `re-animator-spec.md`가 **후처리 키프레임(sendcmd)** 방식을 채택(카메라는 I2V 에 안 맡김). **Kling 은 미채택**. Phase 1-2 로 구현됨(위 세션 요약 참조). 아래 옛 메모는 이력.
- **[이력] 카메라워크를 다른 방식으로 재구현할 예정** — 사용자가 방향을 바꾸는 중. 현재는 postfx(ffmpeg 줌·팬)로 구움. 사용자는 **Kling 3**가 카메라워크가 더 낫다고 봄. Kling 공식 직접 API 조사됨: 엔드포인트 `https://api-singapore.klingai.com/v1/videos/image2video/`, 인증=AK/SK로 JWT(HS256, 30분), model_name으로 Kling 3.0, **camera control·모션 브러시 네이티브 지원**, ~$0.075/초, 실패 시 무과금. 현재 fal 경유는 비싸고 느림. → `worker/kling.mjs` 어댑터로 붙여 엔진 토글(Grok↔Kling) 가능. **단 사용자가 Kling 안 쓸 수도 있음 — 확정 전까지 구현 보류.**
- **[미해결] 미리보기 더빙 루프**: 사용자가 "미리보기에서 더빙이 루프 반복"이라고 함. 코드상 `playSceneAudio`는 단일 패스라 원인 못 찾음. 재현되면 "씬 전체 반복인지 한 줄 반복인지" 확인 필요. (참고: `playSceneAudio`가 narration을 bubble+narrationAudioUrl로 이중 push할 여지 확인해볼 것.)
- **[진단 도구] 🕐 생성 시각**으로 "안 바뀐다"가 생성 문제/표시 문제/그냥 비슷한 건지 판별 가능 — 사용자 피드백 대기.
- 배포된 최신 커밋 확인: `git log origin/main --oneline -1`.
