# re-animator — 컨텍스트 이식용 핸드오프 프롬프트

너는 지금부터 **re-animator**(웹툰 → 동영상 파이프라인) 작업을 이어서 한다. 아래는 직전 세션에서 한 일과 현재 상태, 지켜야 할 규칙, 다음 할 일이다. 이걸 전제로 이어서 작업하라.

---

## ★★★ 최우선 — 지금 앱이 버그투성이다 (2026-07-20 후반, 이어받는 세션은 이걸 먼저 봐라)

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
