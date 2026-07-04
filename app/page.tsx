import Link from "next/link";
import { listProjects } from "@/lib/projectStore";
import { type StepStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: "대기",
  running: "처리 중",
  review: "검수 대기",
  approved: "완료",
  error: "오류",
};

export default async function Home() {
  let projects: Awaited<ReturnType<typeof listProjects>> = [];
  let error = "";
  try {
    projects = await listProjects();
  } catch (e) {
    error = e instanceof Error ? e.message : "프로젝트 목록을 불러오지 못했어요";
  }

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-lg font-semibold">프로젝트</h1>
        <Link
          href="/new"
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium"
        >
          + 새 프로젝트
        </Link>
      </div>

      {error && (
        <p className="rounded-md border border-[var(--danger)] bg-[var(--panel)] p-3 text-sm text-[var(--danger)]">
          {error} — .env.local 의 Redis 설정을 확인하세요.
        </p>
      )}

      {!error && projects.length === 0 && (
        <p className="text-sm text-[var(--muted)]">
          아직 프로젝트가 없어요. 새 프로젝트로 웹툰 이미지를 올려보세요.
        </p>
      )}

      <ul className="grid gap-2">
        {projects.map((p) => (
          <li key={p.id}>
            <Link
              href={`/project/${p.id}`}
              className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--panel)] px-4 py-3 hover:border-[var(--accent)]"
            >
              <span className="font-medium">{p.name}</span>
              <span className="flex items-center gap-3 text-xs text-[var(--muted)]">
                <span>{p.aspectRatio}</span>
                <span>소스 {p.sourceFiles.length}</span>
                <span>컷 {p.scenes.length}</span>
                <span className="rounded bg-[var(--panel-2)] px-2 py-0.5">
                  {STATUS_LABEL[p.steps.source.status]}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
