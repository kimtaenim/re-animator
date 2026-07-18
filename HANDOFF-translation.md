# re-animator 대사 번역(역:) — 핸드오프 (미해결)

웹툰→동영상. Vercel(앱) + Render(워커 `re-animator-worker`) + Upstash Redis + Vercel Blob.
main push 시 자동 배포(수분 지연). **프로덕션에선 번역이 일부 뜬다(=코드는 근본적으로 작동).**

## 지금 문제 (이 대화창 시작부터 미해결)
외국어(중국어) 웹툰의 대사·내레이션 옆에 한국어 "역: …"을 **모든 단계·모든 컷에 일관되게** 띄우기.
현재: 일부 컷만 역:이 뜨고 일부는 안 뜸. 그리고 **역: 글자 색이 흐려서 안 보임**(사용자 지적).

## ★즉시 할 일 (우선순위)
1. **역: 가독성 버그(제일 급함).** 역: 텍스트를 저대비 색으로 넣어 안 보임. `text-[var(--accent)]`(#1e90ff, 라이트·다크 다 보임)로 바꿀 것. 위치:
   - `app/project/[id]/BoundaryEditor.tsx`: `text-cyan-200/70`(말풍선 역:), `text-cyan-200/80`(dialogue 역:)
   - `app/project/[id]/Studio.tsx`: 역: 3곳(대사편집기 line~870, 대사입력 폴백, 연출보고서 line~2424) — `text-[var(--muted)]` 너무 흐림
   - `app/project/[id]/CastReview.tsx`: 역: 2곳(`italic`, muted)
   - preview: `text-white/75`(영상 위라 흰색 OK, 필요시 밝게)
2. **모든 줄에 역: 일관되게.** 원인: gpt-4o가 OCR/classify 스키마의 translation 칸을 줄마다 채우다 말다 함. 해결책 이미 넣음(아래 translateScenes=Claude가 전 줄 번역). 배포판이 실제로 도는지 확인 필요(워커 로그 `대사 번역(Claude) N줄` 또는 `⚠ ANTHROPIC_API_KEY 없음`).

## 번역 파이프라인 구조 (이 세션에서 만든 현재 상태)
- **출처가 단계마다 다름** — 화면의 대사가 어디서 오는지 먼저 확인할 것:
  - G1(분할 후): 대사 = `cut.dialogue`(classify가 채움) + `cut.bubbles`(내레이션 밴드 미리읽기). **OCR bubbles 아님!** (이거 몰라서 며칠 헤맴)
  - 추출 후: `cut.bubbles`(readCutText OCR).
- **번역 생성**:
  - `worker/translate.mjs` `translateScenes(scenes)` = ★권위. Claude(`claude-haiku-4-5`, 워커 ANTHROPIC_API_KEY, director와 공유)가 cut.dialogue→dialogueTranslation + 모든 bubble.text→translation을 60줄씩 배치로 한 번에. `runSplit`·`runExtract` 저장 직전 호출.
  - gpt-4o도 OCR 스키마(bubble.translation)·classify 스키마(dialogueTranslation)에서 번역 뱉음 = **폴백**(Claude가 덮어씀). ※일관성 낮음 — 정리하려면 gpt-4o 번역 제거 고려.
- **저장 필드**: `DialogueBubble.translation`, `CutOntology.dialogueTranslation`, (레거시 narrationTranslation).
- **★저장 화이트리스트(필드 추가 시 전부 갱신 안 하면 저장 때 날아감 — 이게 큰 버그였음)**:
  - `/api/cut`: `lib/cutClean.ts`의 `cleanBubbles`(translation 포함) + `dialogueTranslation`.
  - `/api/boundaries`: 기존 cut에 머지(`{...old.cut, ...cut}`) + cleanCut에 dialogueTranslation.
  - `/api/cast`: `{...b}` 스프레드(보존). `/api/scene`: 필터(보존).
- **표시**: BoundaryEditor(G1, 대사 한 목록으로 통합됨), CastReview, Studio(대사편집기·연출보고서·미리보기). 전부 translation/dialogueTranslation 참조.

## 실행 검증된 것 (scripts/, 키 없이 mock으로 실제 코드 실행)
- `verify-ocr-translation.mjs`: readCutText가 OCR 번역 수신·잘리면 에러. PASS.
- `verify-classify-receive.mjs`: normalizeCut가 dialogueTranslation 수신. PASS.
- `verify-cutclean.mts`: cleanBubbles가 번역·화자·감정 보존. PASS (`npx tsx`).
→ **받아오기·저장·표시 코드는 맞다. 모델이 번역을 주기만 하면 화면까지 간다.**

## 검증 못 한 것 / 제약
- **로컬에 Redis·OpenAI·Anthropic 키 없음**(.env.local엔 BLOB만). → 워커/앱 로컬 실행 불가 → 라이브 검증 불가.
- 사용자는 키 공유 거부(Vercel에서 잘 돌아감). → 검증은 배포+사용자 눈으로만. probe 스크립트(probe-claude-translate.mjs 등)는 키 필요.
- 즉 "살아있는 Claude가 실제로 번역 뱉는지"는 미확인이나, 프로덕션에서 일부 역:이 떴으므로 파이프라인 자체는 작동.

## 부수로 한 것 (이 세션)
- 내레이션=대화 통합(별도 narration 필드/UI 제거, 화자=내레이터인 대사 줄). 워커 normalizeNarration, CastReview 내레이션 행 제거, 라벨 "내레이터". [[reanimator-narration-is-dialogue]]
- 자동 연출 풀 옵션(번역 읽고 카메라·감정·길이·전환·자막·동작) + 연출 보고서.
- UI 경량화: 말풍선/컷카드 ⚙ 접기, 단계 탭 네비(sticky), 컷카드 hover 툴바.

## ★교훈 (반복 금지)
- 로컬 런타임 없음 → **증거 없이 "된다" 금지.** 확신 수준을 정직히.
- **화면의 대사 출처를 먼저 추적**(G1=classify.dialogue, 추출=OCR bubbles). 엉뚱한 경로 고치다 며칠 날림.
- bubble/cut 필드 추가 = **모든 저장 라우트 화이트리스트 갱신** 안 하면 소실.
- **사용자 방향이 내 아이디어보다 매번 나았다**(Claude 번역, 내레이션 통합, 단계탭). 밀지 말고 따르고, 모르면 물어라.

## 주요 커밋 (이 세션)
a3f13d7 번역 초안 → e04d868 OCR통합 → 783b7f7/e0a2e5f (cut 저장 버그·cutClean) →
ebcb8c7 (G1 classify dialogueTranslation) → c2822ea (**번역 Claude 전환 translateScenes**) →
5d3906b (내레이션 통합) → 807a87b (G1 대사 표시 통합). 미완: 역: 색 가독성.
