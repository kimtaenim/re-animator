"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// 프로젝트 삭제(라이브러리). 확인 후 DELETE → 목록 새로고침.
export default function DeleteButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function del() {
    if (!confirm(`"${name}" 프로젝트를 삭제할까요? 되돌릴 수 없어요.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/project/${id}`, { method: "DELETE" });
      router.refresh();
    } catch {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={del}
      disabled={busy}
      className="shrink-0 rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--muted)] hover:border-[var(--danger)] hover:text-[var(--danger)] disabled:opacity-50"
    >
      {busy ? "삭제 중…" : "삭제"}
    </button>
  );
}
