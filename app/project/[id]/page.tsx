import { getProject } from "@/lib/projectStore";
import Studio from "./Studio";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let project = null;
  let error = "";
  try {
    project = await getProject(id);
  } catch (e) {
    error = e instanceof Error ? e.message : "불러오기 실패";
  }

  if (error) {
    return <p className="text-sm text-[var(--danger)]">{error}</p>;
  }
  if (!project) {
    return <p className="text-sm text-[var(--muted)]">프로젝트를 찾을 수 없어요.</p>;
  }

  return <Studio initialProject={project} />;
}
