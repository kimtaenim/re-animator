// ============================================================================
// 컷 온톨로지 — 클라이언트/서버 공용 헬퍼. 어휘의 원천은 config/ontology.json.
// 워커(mjs)는 loadOntology 로 같은 파일을 읽는다 → 단일 원천, 어긋남 없음.
// ============================================================================

import ontologyJson from "@/config/ontology.json";
import type { CutOntology, CutType, TextKind } from "@/lib/types";

export interface CutTypeDef {
  id: CutType;
  ko: string;
  regenerate: boolean;
  entityRole: "character" | "context" | "prop" | null;
  desc: string;
}
export interface TextKindDef {
  id: TextKind;
  ko: string;
  route: string;
  desc: string;
}

export const CUT_TYPES = ontologyJson.cutTypes as CutTypeDef[];
export const TEXT_KINDS = ontologyJson.textKinds as TextKindDef[];

export function cutTypeKo(id: CutType | null | undefined): string {
  if (!id) return "미분류";
  return CUT_TYPES.find((t) => t.id === id)?.ko ?? id;
}

export function textKindKo(id: TextKind | null | undefined): string {
  if (!id) return "";
  return TEXT_KINDS.find((t) => t.id === id)?.ko ?? id;
}

// 미분류 기본 컷(새 컷 추가·cut 없는 씬 편집 시).
export function blankCut(): CutOntology {
  return {
    type: null,
    textKind: null,
    characters: [],
    setting: "",
    objects: [],
    dialogue: "",
    speakerId: null,
    sfx: "",
    description: "",
    promptDraft: "",
    motion: "",
    confirmed: false,
  };
}
