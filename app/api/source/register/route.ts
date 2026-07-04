import { NextRequest, NextResponse } from "next/server";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { type SourceFile } from "@/lib/types";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

// 브라우저가 Blob 직접 업로드를 끝낸 뒤, 그 URL·크기를 프로젝트에 SourceFile 로 등록.
// (파일 바이트는 여기 안 옴 → 함수 본문 한계와 무관, JSON 메타데이터만.)
export async function POST(req: NextRequest) {
  let body: {
    projectId?: string;
    files?: { url: string; width: number; height: number }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  const incoming = body.files ?? [];
  if (!projectId || incoming.length === 0) {
    return NextResponse.json(
      { ok: false, error: "projectId·files 필요" },
      { status: 400 }
    );
  }
  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  }

  const startOrder = project.sourceFiles.length;
  const added: SourceFile[] = incoming.map((f, i) => ({
    id: randomUUID(),
    url: f.url,
    order: startOrder + i,
    width: Math.round(f.width) || 0,
    height: Math.round(f.height) || 0,
  }));
  if (added.some((f) => f.width <= 0 || f.height <= 0)) {
    return NextResponse.json(
      { ok: false, error: "이미지 크기를 못 읽었어요" },
      { status: 400 }
    );
  }

  // 새 소스가 들어오면 이전 분할 결과 무효 → 캔버스·씬 리셋, 단계 pending.
  project.sourceFiles = [...project.sourceFiles, ...added];
  project.virtualCanvas = null;
  project.scenes = [];
  setStep(project, "source", { status: "pending", error: undefined });
  await saveProject(project);

  return NextResponse.json({ ok: true, project });
}
