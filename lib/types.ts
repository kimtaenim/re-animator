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

export interface CutOntology {
  type: CutType | null; // null = 미분류(사람이 채움)
  textKind: TextKind | null; // type=text 일 때만
  characters: string[]; // 초점 인물 서술 → M2 캐스팅이 엔티티로 해소
  setting: string; // 장소/배경 한 줄
  objects: string[]; // 핵심 사물
  dialogue: string; // 말풍선 텍스트(풀해상도 OCR로 정확히 → 자막/더빙)
  speakerId?: string | null; // 이 대사를 말하는 캐릭터 id(M2 화자 귀속). null=나레이션/미상
  textBoxes?: TextBox[]; // 글씨(말풍선·자막·효과음) 영역들(0~1 정규화) — 마스크 재생성용
  sfx: string; // 의성어/효과음
  description: string; // VLM 자유 서술(인물·배경·구도·분위기) → image-2 로 그대로 전달
  promptDraft: string; // image-2 재생성용 프롬프트 초안(영문)
  motion: string; // I2V 모션 힌트(후속)
  confirmed: boolean; // 사람이 G1 에서 타입 확정했는지
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
}

// ── 프로젝트 ──────────────────────────────────────────────────────────────────
export interface Project {
  id: string;
  name: string;
  aspectRatio: AspectRatio;
  stylePrompt: string; // 프로젝트층 프롬프트(화풍). M1 에선 설정만 보관.
  negativePrompt: string; // 기본: 말풍선·글자·텍스트 금지

  sourceFiles: SourceFile[];
  virtualCanvas: VirtualCanvas | null; // 분할 전엔 null
  scenes: Scene[]; // 순서 있는 배열. 분할 결과 → G1 편집 → 확정.
  cast?: Character[]; // M2 캐스팅 결과(등장인물). 확정 전엔 미정.

  steps: Record<StepKind, StepState>;

  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_NEGATIVE_PROMPT =
  "speech bubbles, text, letters, captions, watermarks, sound-effect lettering";

export function newStepState(kind: StepKind): StepState {
  return { kind, status: "pending", updatedAt: Date.now() };
}
