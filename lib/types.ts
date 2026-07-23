// ============================================================================
// re-animator — 도메인 타입 (M1 범위)
// ----------------------------------------------------------------------------
// 스펙 §4 데이터 모델의 M1 부분집합: 소스 파일 · 가상 캔버스 · 컷(Scene) 경계.
// 이후 마일스톤(캐스팅·재생성·I2V·더빙·합성) 필드는 진행하며 확장한다. 각 필드는
// optional 확장을 전제로 두어, 한 단계 추가가 기존 타입을 깨지 않게 한다.
// ============================================================================

// ── 파이프라인 단계 ──────────────────────────────────────────────────────────
// M1 은 source(소스+분할) 하나만 구현. 나머지는 자리만 잡아둔다(문서/네비게이션용).
export type StepKind =
  | "source" // 1. 업로드 + 가상캔버스 + 컷 분할 + G1 경계 승인   ← M1
  | "cast" // 2. 캐스팅 (G0)                                    (M2)
  | "regen" // 3. 재생성 (G2)                                    (M3)
  | "scene" // 4. 씬 생성 + 더빙 (G3)                            (M4-6)
  | "compose"; // 5. 합성 + 시사                                  (M7)

export const STEP_ORDER: StepKind[] = ["source", "cast", "regen", "scene", "compose"];

export type StepStatus =
  | "pending" // 아직 진행 안 됨 / 이전 단계 미승인
  | "running" // 워커 작업 진행 중(분할 등)
  | "review" // 산출물 나옴, 사람 검수 대기 (G0-G3)
  | "approved" // 승인, 다음 단계 진입 가능
  | "error";

export interface StepState {
  kind: StepKind;
  status: StepStatus;
  jobId?: string; // 워커 비동기 작업 id (split/extract 등)
  error?: string;
  updatedAt: number;
}

export type AspectRatio = "16:9" | "9:16" | "1:1";

// ── 소스 파일 (업로드 순서 유지) ─────────────────────────────────────────────
export interface SourceFile {
  id: string;
  url: string; // Blob 공개 URL
  order: number; // 업로드 순서 (0-base)
  width: number; // 원본 픽셀 폭
  height: number; // 원본 픽셀 높이
}

// ── 가상 캔버스 ──────────────────────────────────────────────────────────────
// 실제 스티칭 없이 오프셋 테이블만으로 "가상의 긴 파일"을 표현(스펙 §5.2).
// 모든 좌표는 refWidth 기준으로 정규화된 전역 y. 워커가 분할 시 계산해 채운다.
export interface VirtualCanvas {
  refWidth: number; // 정규화 기준폭
  totalHeight: number; // 정규화 전역 높이 (= normHeights 합)
  offsets: number[]; // 파일별 시작 전역 y (누적합). offsets[i] = i번째 파일 시작
  normHeights: number[]; // 파일별 정규화 높이 (refWidth 로 리사이즈했을 때)
}

// ── 컷(Scene) — M1 은 경계(source_region)만. 이후 단계가 나머지를 채운다. ───────
export interface SourceRegion {
  yStart: number; // 정규화 전역 y (포함)
  yEnd: number; // 정규화 전역 y (제외)
  xStart?: number; // 좌우 크롭 — 옆 여백 제거(패널만). 없으면 전체 폭(0).
  xEnd?: number; // 없으면 refWidth.
}

// ── 컷 온톨로지 — 컷의 "중심"(타입) + 내용. config/ontology.json 이 어휘의 원천. ──
// 분할 시 VLM 이 채우고 사람이 G1 에서 확정한다. 이후 image-2(재생성)에 레퍼런스+
// 프롬프트로 넘어간다. regenerate=false 타입(text)은 자막/음향/타이틀로 라우팅.
export type CutType =
  | "person" // 인물 (중심·반응·인물들 통합)
  | "action" // 액션
  | "object" // 사물 (타이틀·다이어그램·글씨그림 포함)
  | "background_crowd" // 배경 및 군중 (공간·군중)
  | "transition" // 장면 전환 (흐르는 연출·효과)
  | "text"; // 말풍선·자막·효과음 (오버레이 → 자동 제거)

export type TextKind = "dialogue" | "caption" | "sfx";

// 글씨 영역(0~1 정규화). 마스크 재생성에서 이 부분을 '채울 곳'으로.
export interface TextBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// 말풍선(대사) 단위 — OCR 이 풍선별로 뽑고, 화자를 풍선마다 귀속(더빙 목소리 매핑).
export interface DialogueBubble {
  text: string; // 그 풍선 글자(OCR 보이는 그대로 — 더빙은 이 원문 언어로 읽음)
  translation?: string; // 한국어 번역(편집자용 주석). 원문 text 는 안 건드림 — 더빙 소스 아님. 한국어 원문이면 비움.
  speakerId?: string | null; // 이 풍선을 말하는 캐릭터 id. null=나레이션/미상
  box?: TextBox; // 풍선 영역(0~1)
  audioUrl?: string; // 더빙 오디오 Blob URL (TTS). 화자 목소리로 생성.
  subtitleX?: number; // 이 줄 자막 가로 중심(0~1). 없으면 컷 기본(cut.subtitleX)
  subtitleY?: number; // 이 줄 자막 세로 중심(0~1). 화자가 번갈아 말할 때 줄마다 위치 지정
  emotion?: string; // 감정 연기 id(EMOTIONS) — ElevenLabs v3 오디오 태그로 변환돼 과장 연기
  volume?: number; // 이 줄 목소리 크기 배수(합성 시 적용). 1=보통, <1 작게, >1 크게. 없으면 1.
  distant?: boolean; // 멀리서 들리는 느낌(거리감) — 합성 시 로우패스+약한 반향+감쇠.
  noSubtitle?: boolean; // ★자막에서 제외(소리는 나되 캡션 안 뜸) — 비명·효과음성 대사 등. 화자 목소리 더빙은 유지.
  tracks?: Record<string, BubbleTrack>; // ★언어별(ja/en) 번역·TTS(스펙 §10). 없으면 레거시(text=원어·translation=한국어). 가산적.
}

// ── 언어별 대사 트랙(스펙 §10) — 하위호환 가산 필드. text(원어)·translation(한국어)은 불변. ──
export interface BubbleTrack {
  text?: string; // 번역 텍스트(해당 언어)
  audioUrl?: string; // TTS 오디오 Blob URL(언어별)
  durationFinal?: number; // TTS 도착 후 확정 길이(초, 언어별)
  status?: "pending" | "translated" | "tts" | "done";
}

// 지원 언어(스펙 §10) — 확장 가능. speedCps=초당 글자/모라(길이 어림값). 실측으로 보정.
export const LANGUAGES: { id: string; label: string; speedCps: number }[] = [
  { id: "ja", label: "일본어", speedCps: 6.5 },
  { id: "en", label: "영어", speedCps: 15 },
];
export const LANG_SPEED_CPS: Record<string, number> = { ko: 4.5, ja: 6.5, en: 15 };

// 감정 연기 프리셋 — id 는 bubble.emotion 에 저장, tag 는 ElevenLabs v3 오디오 태그(워커 tts.mjs 와 동기).
export const EMOTIONS: { id: string; label: string; tag: string }[] = [
  { id: "shout", label: "📢 외침", tag: "shouting" },
  { id: "angry", label: "😡 분노", tag: "angry" },
  { id: "cry", label: "😭 울음", tag: "crying" },
  { id: "whisper", label: "🤫 속삭임", tag: "whispering" },
  { id: "laugh", label: "😆 웃음", tag: "laughing" },
  { id: "shock", label: "😱 경악", tag: "shocked" },
  { id: "excited", label: "🔥 신남", tag: "excited" },
  { id: "sigh", label: "😮‍💨 한숨", tag: "sighs" },
];

// ── 오디오 채움 제안(스펙 §6) — VLM 이 무음 구간 최소화용으로 제안. 기본 승인. ──────────
export interface AudioSuggestion {
  type: "sfx" | "vocal_reaction" | "insert_line"; // 효과음 / 배역 리액션 발성 / 삽입 대사(창작)
  text: string; // 소리/발성/대사 내용(작업 언어)
  speaker?: string | null; // 배역 id(vocal_reaction·insert_line). null=미상
  timing?: "start" | "mid" | "end";
  confidence?: number; // 0-1
  enabled?: boolean; // insert_line 은 창작이라 on/off 관리(기본 on). sfx/vocal 은 항상 on.
  ko?: string; // 한국어 병기(§10 — 작업자 이해용, 산출물 제외)
  audioUrl?: string; // 생성된 오디오 Blob URL(§6 경로)
}

export interface CutOntology {
  type: CutType | null; // null = 미분류(사람이 채움)
  textKind: TextKind | null; // type=text 일 때만
  characters: string[]; // 초점 인물 서술 → M2 캐스팅이 엔티티로 해소
  setting: string; // 장소/배경 한 줄
  objects: string[]; // 핵심 사물
  dialogue: string; // 이 컷 대사 합침(하위호환·표시용). 풍선별은 bubbles 가 정답.
  dialogueTranslation?: string; // dialogue 의 한국어 번역(G1 미리보기용 — 분류 단계가 채움). 추출 후엔 bubbles.translation 이 정답.
  bubbles?: DialogueBubble[]; // 말풍선 단위 대사+화자. OCR 이 풍선별로 채움.
  narration?: string; // 흡수된 위·아래 나레이션/자막(별도 — OCR 이 안 건드림)
  narrationTranslation?: string; // narration 의 한국어 번역(편집자용 주석). 한국어 원문이면 비움.
  narrationSpeakerId?: string | null; // 이 내레이션을 읽는 화자(나레이터). null=미상/기본
  narrationAudioUrl?: string; // 내레이션 더빙 오디오 Blob URL (나레이터 목소리로 생성)
  speakerId?: string | null; // (레거시) 컷 단위 화자. bubbles 있으면 풍선별 speakerId 우선.
  textBoxes?: TextBox[]; // 글씨(말풍선·자막·효과음) 영역들(0~1 정규화) — 마스크 재생성용
  textRegions?: SourceRegion[]; // 흡수된 '대사만 있는' 밴드 영역들 — 추출 때 따로 OCR해 이 컷 대사로. (이미지엔 안 합침)
  sfx: string; // 의성어/효과음
  sfxAudioUrl?: string; // 효과음 오디오 Blob URL (ElevenLabs Sound Effects 생성)
  description: string; // VLM 자유 서술(인물·배경·구도·분위기) → image-2 로 그대로 전달
  promptDraft: string; // image-2 재생성용 프롬프트 초안(영문)
  motion: string; // I2V 카메라워크 프롬프트(CAMERA_PROMPTS). '무엇·언제'를 시간구조로 지시.
  action?: string; // 인물/피사체 동작 힌트(I2V, 자유 텍스트) — 버튼(bodyMotion) 없을 때 폴백. AI 연출이 디폴트로 채움.
  bodyMotion?: string; // 인물 몸동작 프리셋(버튼): still/sway/walk-in/walk-out/run/turn/gesture. I2V 지시로 매핑. 모두 절제.
  animatePicture?: boolean; // 사진·초상·표지 속 인물도 움직임 허용(기본=정지). 가끔 그림 속 인물이 움직여야 하는 컷용.
  videoPrompt?: string; // 동영상 생성용 내용 설명(사람 입력, I2V) — 무슨 일이 일어나는지·어떤 움직임인지 자유 서술. 카메라워크는 별도(후처리).
  videoPromptOverride?: string; // ★영상 프롬프트 직접 편집(고급) — 있으면 자동 조립 무시하고 이걸 그대로 Grok 에 보냄(전체 제어).
  durationSec?: number; // 이 컷 영상/씬 길이(초) 사람 지정. 없으면 대사·타입으로 추정.
  transition?: string; // 이 컷 끝의 전환(합성 시): none/fadeout/fadein/black/dissolve
  subtitlePos?: "auto" | "top" | "middle" | "bottom"; // (레거시) 자막 위치 프리셋
  subtitleY?: number; // 자막 세로 중심(0=위,1=아래). 있으면 subtitlePos보다 우선. 컷별 9분할 수동
  subtitleX?: number; // 자막 가로 중심(0=왼쪽,1=오른쪽). 컷별 9분할 수동. 기본 0.5(중앙)
  noCastRef?: boolean; // 재생성 시 캐스팅 정본 참고 끄기(피·변신 등 특수 상태 컷 — 정본이 상태를 덮지 않게)
  cameraWork?: CameraWork; // ★연출 레이어(스펙 §2). 저장은 이 JSON 만; 픽셀은 워커(camerafx)/프리뷰가 테이블로 굽는다.
  // ── 모션 티어(스펙 §3) — VLM 자동 분류(추가 호출 없음). 없으면 미분류. ────────────────
  motionTier?: "talk" | "idle" | "emote" | "action"; // 티어별 I2V 요청 규칙(길이·모션)에 사용
  tierConfidence?: number; // 0-1. 낮으면 "미결만 보기"에 포함
  tierEvidence?: string; // 근거 한 줄
  motionPromptHint?: string; // 티어 규칙 준수 I2V 모션 서술
  interpolationCandidate?: boolean; // 인접 컷 자세차 큼 → 동작 보간 후보(스펙 §4, G2 배지)
  interpolationOn?: boolean; // ★동작 보간 켜기(옵트인, 스펙 §4) — 켜면 이 컷 영상이 '이 이미지→다음 컷 이미지'로 Kling 보간(first/last frame). 구조 변경 없음.
  audioSuggestions?: AudioSuggestion[]; // 오디오 채움 제안(스펙 §6)
  confirmed: boolean; // 사람이 G1 에서 타입 확정했는지
}

// ── 카메라워크(스펙 §2) — 타입만. 수식은 lib/cameraKeyframes.mjs 단일 소스. ──────
export type CameraPreset =
  | "push_in" | "pull_out" | "pan" | "static" | "shake" | "crash_zoom" | "whip" // 계층 A
  | "parallax_push" | "vertigo" // 계층 B(2레이어)
  | "orbit"; // 계층 C(I2V 위임)

export type CameraEasing = "linear" | "easeIn" | "easeOut" | "easeInOut";

// camera_work 스키마(스펙 §2). buildKeyframeTable 의 입력.
export interface CameraWork {
  preset: CameraPreset;
  duration_s: number;
  zoom_rate_pct_per_s?: number; // 양수=push, 음수=pull
  drift_px_per_s?: { x: number; y: number };
  bg_scale_delta_pct_per_s?: number; // 계층 B: 배경 추가/역방향 스케일 속도(%p/s)
  easing?: CameraEasing;
  shake_seed?: number; // 시드 PRNG(양쪽 동일 궤적)
  shake_amp_px?: number;
  shake_damp?: number;
  start_zoom?: number; // pull_out 은 >1 로 시작
}

// 한 시점 crop 창 상태(정규화). scale>=1, cx/cy 중심 0~1.
export interface CameraState {
  scale: number;
  cx: number;
  cy: number;
}

export interface CameraKeyframe extends CameraState {
  t: number; // 초
  off: number; // 정규화 진행 0~1(Web Animations offset)
}

export interface CameraKeyframeTrack {
  keys: CameraKeyframe[];
}

// buildKeyframeTable 의 출력. 워커·웹앱이 이것만 소비. A:{main} B:{character,background} C:{}
export interface CameraKeyframeTable {
  version: number;
  preset: CameraPreset;
  duration_s: number;
  fps: number;
  frames: number;
  layer: "A" | "B" | "C";
  refWidth: number;
  refHeight: number;
  tracks: Record<string, CameraKeyframeTrack>;
  maxScale: number;
}

export interface Scene {
  id: string;
  order: number;
  sourceRegion: SourceRegion; // 가상 캔버스 전역 좌표
  cut?: CutOntology; // 컷 온톨로지(타입+내용). 미분류면 type=null.
  originalImage?: string; // 추출된 원본 컷 Blob URL (확정 후 워커가 채움)
  regenMode?: "mask" | "full"; // 재생성 방식: mask=원본보존+빈공간/글씨만, full=통째 재생성
  generatedImage?: string; // M3 재생성 이미지 Blob URL (image-2)
  regenError?: string; // 재생성 실패 사유(있으면)
  videoUrl?: string; // M4 I2V 영상 Blob URL (Grok image-to-video)
  videoError?: string; // 영상 생성 실패 사유(있으면)
  fxUrl?: string; // 후처리(줌 커브) 구운 영상 Blob URL — 있으면 미리보기·합성이 이걸 사용
  fx?: { effect: string; strength: number }; // 적용된 후처리(크래시인/아웃·램프·펀치)와 강도
  status: StepStatus; // M1 에선 경계 확정 여부 관리에만 사용
}

// ── 캐스트(등장인물) — M2. 캐릭터 타입 컷을 VLM 이 인물별로 묶고 사람이 확정. ──
// 같은 인물 = 같은 엔티티 → 이후 image-2 재생성에 같은 레퍼런스 이미지를 물려 일관성.
export interface Character {
  id: string;
  label: string; // "캐릭터 1" … (순서대로 번호)
  description: string; // 외모(머리·옷·특징) — VLM 서술
  refSceneId?: string; // 대표 컷(가장 선명한 등장) → 레퍼런스 이미지
  sceneIds: string[]; // 이 인물이 나오는 컷 id 들
  voice?: string; // 더빙 목소리 voice_id(카탈로그 config/voices.json). M4 더빙에 사용.
  voiceProvider?: string; // 목소리 제공사: "eleven" | "typecast". 워커가 API 라우팅에 씀.
  voiceName?: string; // 표시용 목소리 이름(선택). 목록 재조회 없이 라벨 표시.
  // 대표 컷에서 이 인물이 차지하는 영역(0~1 정규화). 레퍼런스를 '패널 전체'가 아니라 이 영역만
  // 크롭해 보낸다 — 전체를 보내면 그 컷의 구도·내용까지 모델에 흘러들어 다른 컷을 재생성해도
  // 대표 컷(대개 1~2번)을 닮은 그림이 나온다(실제 사고). 캐릭터당 VLM 1회로 구해 캐시.
  refBox?: { left: number; top: number; right: number; bottom: number };
  realImage?: string; // 실사화 인물 초상 Blob URL — 실사화 재생성 시 얼굴 고정 레퍼런스.
  realPrompt?: string; // 실사 초상 디자인용 추가 지시(선택, 자유 텍스트).
  realEthnicity?: string; // 실사 초상 인종(영문 문구, 칩 선택). 프롬프트에 반영.
}

// ── 프로젝트 ──────────────────────────────────────────────────────────────────
export interface Project {
  id: string;
  name: string;
  aspectRatio: AspectRatio;
  regenMode?: "mask" | "full"; // M3 기본 재생성 방식(프로젝트 공통). 기본 mask.
  stylePrompt: string; // 프로젝트층 프롬프트(화풍). M1 에선 설정만 보관.
  negativePrompt: string; // 기본: 말풍선·글자·텍스트 금지

  sourceFiles: SourceFile[];
  virtualCanvas: VirtualCanvas | null; // 분할 전엔 null
  scenes: Scene[]; // 순서 있는 배열. 분할 결과 → G1 편집 → 확정.
  cast?: Character[]; // M2 캐스팅 결과(등장인물). 확정 전엔 미정.
  composedUrl?: string; // 5단계 합성(이어붙인) 최종 영상 Blob URL
  narratorVoice?: { provider: string; id: string; name: string }; // 나레이션 더빙 목소리(카탈로그에서 선택)
  dubSpeed?: number; // 더빙 말 속도 배수(1=기본, 1.2=조금 빠르게). Typecast tempo / ElevenLabs speed.
  storyContext?: string; // ★스토리 맥락/톤(사용자 작성) — 모든 영상 생성 프롬프트에 주입해 맥락 어긋난 동작(예: 죽어가는데 벌떡 일어남) 방지.
  targetLanguages?: string[]; // ★번역·출력 대상 언어(스펙 §10, 예 ["ja","en"]). 없으면 레거시(단일 — 기존 동작). LANGUAGES 참조.
  videoEngine?: "grok" | "kling"; // I2V 엔진. 기본 kling(키 있으면; 스펙 §4 첫+끝 프레임 보간은 Kling만). 없으면 자동(키 유무).
  workingLanguage?: string; // ★작업 언어(스펙 §10). ""/미설정=원어(source), "ja"/"en"=그 언어 번역으로 표시·더빙·자막. tracks[lang] 사용.
  // ★섹션(부분 작업) — 한 회분을 몇 개 섹션으로 나눠 부분부분 작업 후 최종에 이어붙이기.
  //   값 = 각 섹션이 '시작하는 컷 인덱스'(order 정렬 기준, 0-base). 항상 0 포함·정렬·중복제거.
  //   미설정/빈 배열 = 섹션 없음(전체 한 덩어리 — 기존 동작). 경계는 컷 경계에만 놓여 그림이 안 잘림.
  sectionStarts?: number[];
  // ★섹션별 부분 합성본(방향 B) — 키=섹션 시작 컷 인덱스(String), 값=그 섹션만 이어붙인 중간 영상 URL.
  //   최종 join 이 이 몇 개만 이어붙여 composedUrl 을 만든다(한 잡=섹션치 → 디스크·OOM 안전판).
  sectionVideos?: Record<string, string>;

  steps: Record<StepKind, StepState>;

  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_NEGATIVE_PROMPT =
  "speech bubbles, text, letters, captions, watermarks, sound-effect lettering";

export function newStepState(kind: StepKind): StepState {
  return { kind, status: "pending", updatedAt: Date.now() };
}
