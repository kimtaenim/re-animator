import { NextRequest, NextResponse } from "next/server";
import { getProject, saveProject } from "@/lib/projectStore";
import { uploadAsset } from "@/lib/blob";
import { type SourceFile } from "@/lib/types";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

// POST (multipart) — 여러 이미지 업로드 → Blob → SourceFile[] 로 프로젝트에 추가.
//   field "projectId", field "files" (다중), field "dims" = JSON [{w,h}] (files 순서).
//   크기는 브라우저(createImageBitmap)가 재므로 서버에서 이미지 디코딩 불필요.
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ ok: false, error: "multipart 필요" }, { status: 400 });
  }
  const projectId = String(form.get("projectId") ?? "").trim();
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "projectId 필요" }, { status: 400 });
  }
  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ ok: false, error: "파일 없음" }, { status: 400 });
  }

  let dims: { w: number; h: number }[] = [];
  try {
    dims = JSON.parse(String(form.get("dims") ?? "[]"));
  } catch {
    dims = [];
  }

  const startOrder = project.sourceFiles.length;
  const added: SourceFile[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const bytes = Buffer.from(await file.arrayBuffer());
    const width = Math.round(dims[i]?.w ?? 0);
    const height = Math.round(dims[i]?.h ?? 0);
    if (width <= 0 || height <= 0) {
      return NextResponse.json(
        { ok: false, error: `${file.name}: 이미지 크기를 못 읽었어요` },
        { status: 400 }
      );
    }
    const order = startOrder + i;
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    const { url } = await uploadAsset(
      `project/${projectId}/source-${order}-${randomUUID().slice(0, 8)}.${ext}`,
      bytes,
      file.type || "image/png"
    );
    added.push({ id: randomUUID(), url, order, width, height });
  }

  // 새 소스가 들어오면 이전 분할 결과는 무효 — 캔버스·씬 리셋, 단계 pending 으로.
  project.sourceFiles = [...project.sourceFiles, ...added];
  project.virtualCanvas = null;
  project.scenes = [];
  project.steps.source = {
    ...project.steps.source,
    kind: "source",
    status: "pending",
    error: undefined,
    updatedAt: Date.now(),
  };
  await saveProject(project);

  return NextResponse.json({ ok: true, project });
}
