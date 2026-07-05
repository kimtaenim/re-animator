import { NextRequest, NextResponse } from "next/server";
import { getProject, saveProject, setStep } from "@/lib/projectStore";
import { type StepKind } from "@/lib/types";

export const runtime = "nodejs";

// POST {projectId, step} — 멈춘/진행 중 워커 작업의 단계 상태를 안전 지점으로 되돌린다.
// 워커 프로세스 자체는 못 죽이지만(별도 서버), UI 가 running 에 갇히지 않게 풀어준다.
// 결과가 있으면 review, 없으면 pending 으로. jobId·error 정리.
export async function POST(req: NextRequest) {
  let body: { projectId?: string; step?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const projectId = (body.projectId ?? "").trim();
  const step: StepKind =
    body.step === "cast" ? "cast" : body.step === "regen" ? "regen" : "source";
  if (!projectId) return NextResponse.json({ ok: false, error: "projectId 필요" }, { status: 400 });
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ ok: false, error: "프로젝트 없음" }, { status: 404 });

  const hasResult =
    step === "cast"
      ? (project.cast?.length ?? 0) > 0
      : step === "regen"
        ? project.scenes.some((s) => s.generatedImage)
        : project.scenes.length > 0;
  const restStatus = hasResult ? "review" : "pending";
  setStep(project, step, { status: restStatus, jobId: undefined, error: undefined });
  await saveProject(project);
  return NextResponse.json({ ok: true, status: restStatus });
}
