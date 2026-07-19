# re-animator — 컨텍스트 이식용 핸드오프 프롬프트

너는 지금부터 **re-animator**(웹툰 → 동영상 파이프라인) 작업을 이어서 한다. 아래는 직전 세션에서 한 일과 현재 상태, 지켜야 할 규칙, 다음 할 일이다. 이걸 전제로 이어서 작업하라.

---

## ★ 이번 세션(2026-07-20) 요약 — 연출 레이어 스펙 구현 착수

`re-animator-spec.md`(v0.2, 이번에 성문화)의 "연출 레이어(카메라워크·모션 티어·오디오 채움·프리뷰·다국어)"를 §11 순서로 구현 시작. **Phase 1-3 + Phase 4 그라운드워크 완료·전부 push·배포 반영.** 사용자는 자던 중이라 무인 진행 — "데이터 날려먹지만 않으면 돼"가 하한이라, 검증 불가·데이터 위험 큰 단계는 안 하고 안전한 것만 했다.

**완료(커밋):**
- `9123986` Phase 1 — 카메라워크 **수식 모듈 단일 소스** `lib/cameraKeyframes.mjs`(순수 ESM·무의존): `CameraWork → 정규화 키프레임 테이블`. 계층 A(단일 crop track)/B(character·background 2 track)/C(orbit=I2V 위임). 헬퍼 `toPixelCrop`(워커), `toWebTransform`/`toWebKeyframes`(웹), 시드 PRNG 셰이크, **가시범위 clamp**(scale 여백 밖 이동 흡수 → 워커·웹 좌표 구조적 일치). `lib/types.ts` 카메라 타입. 골든 테스트 `scripts/test-camera-keyframes.mjs` **103 pass**(워커↔웹 2px).
- `c317a43` Phase 2 — 워커 렌더러(계층 A) `worker/cameraRender.mjs`: 테이블의 리터럴 픽셀 crop 을 ffmpeg **sendcmd**(crop w/h/x/y = T 플래그 런타임 command)로 프레임마다 재생. **zoompan 수식 직접 기술 금지 준수**. 단일 패스 스트리밍(합성 OOM 회피). `runCameraFx` 잡 + `camerafx` 타입(index.mjs/jobQueue.ts) + `/api/camerafx`. 통합 테스트 `scripts/test-camera-render.mjs` **11 pass**(실제 ffmpeg·psnr). 기존 `runPostfx`(effect/strength) 유지.
- `b804f30` Phase 3(부분) — `app/project/[id]/CameraWorkEditor.tsx`: 정지이미지 위 **Web Animations 근사 프리뷰** + 슬라이더(preset·길이·줌속도·드리프트·시작줌·배경델타·흔들). 저장 = `cameraWork` JSON(`updateCut`). "적용(굽기)" = camerafx. "근사"/orbit "프록시 렌더 필수"/계층B "매트 후" 라벨. Studio 씬 카드 삽입(기존 ⚡후처리 카메라와 **공존**). **cameraWork 저장 위치 = `CutOntology`**(Scene 아님) — 앱 저장 경로가 cut 기반(/api/cut+화이트리스트 cleanCut)이라 재사용+소실 회피. `cleanCameraWork` 추가.
- `4c3c48b` Phase 4 그라운드워크 — `CutOntology`에 `motionTier`/`tierConfidence`/`tierEvidence`/`motionPromptHint`/`interpolationCandidate`(§3·§4)+`audioSuggestions`(§6). `cleanCut`/`cleanAudioSuggestions` 화이트리스트. **VLM 로직 미변경**(옵셔널 필드만).

**핵심 아키텍처 원칙(회귀 금지):** 카메라워크 수식은 `lib/cameraKeyframes.mjs` **한 곳**에만. 워커·웹앱은 그 테이블만 소비(두 벌 구현 금지). 셰이크는 shake_seed 시드 PRNG 로 양쪽 동일 궤적. 계층 B(parallax/vertigo)는 **인물/배경 매트가 없어 현재 스킵**(사용자 승인 — 온디맨드 매트 확보 후). orbit 은 I2V 위임(후처리 없음).

**무인이라 일부러 안 한 것 + 이유(다음 세션이 이어서):**
1. **§9 접힌 씬 줄 재정의** — motion_tier 드롭다운·작업 언어 표기에 의존(Phase 4 VLM·Phase 5 다국어). 거대 Studio.tsx 의 파괴적 접힌 줄 수술은 사용자 미확인 무인 상태에서 안 함. 의존 데이터 확보 후.
2. **Phase 4 VLM 산출**(classify.mjs·config/prompts.json 에 motion_tier·audio_suggestions·다국어 동시번역·vertigo/보간 태그) — API 키 없어 로컬 검증 불가, 프롬프트 수술은 분류 회귀 위험. 배포 검증 가능 환경에서.
3. **Phase 5 다국어 데이터 재구조화**(§10 `dialogue.tracks{ja,en}`) — **데이터 위험 최상**. 반드시 하위호환(기존 bubbles 보존, tracks 는 가산). 사용자와 방향 합의 권장.
4. **Phase 6-8**(티어별 I2V 규칙+duration 2단계, crash_zoom 3프레이밍 잡, orbit I2V 경로, TTS·ASS 자막·오디오 3트랙 덕킹·whip·이펙트·프록시 렌더·언어별 출력) — 대부분 배포 env 필요.

**배포 후 사용자 검증 항목:** 4단계 씬 카드에 "🎥 카메라워크" 편집기가 뜨는지, 프리셋·슬라이더로 프리뷰가 움직이는지, "적용(굽기)" 후 fxUrl 이 갱신돼 미리보기가 카메라워크 반영하는지. (로컬엔 키·env 없어 실제 굽기는 배포에서만 가능.)

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
