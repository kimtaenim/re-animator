"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { type AspectRatio } from "@/lib/types";

const ASPECTS: AspectRatio[] = ["16:9", "9:16", "1:1"];

export default function NewProjectForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [stylePrompt, setStylePrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/project", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, aspectRatio, stylePrompt }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? "생성 실패");
      router.push(`/project/${d.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "생성 실패");
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <label className="grid gap-1 text-sm">
        <span className="text-[var(--muted)]">이름</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="예: 재의 마녀 1화"
          className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-2"
        />
      </label>

      <div className="grid gap-1 text-sm">
        <span className="text-[var(--muted)]">화면 비율</span>
        <div className="flex gap-2">
          {ASPECTS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAspectRatio(a)}
              className={`rounded-md border px-3 py-1.5 ${
                aspectRatio === a
                  ? "border-[var(--accent)] bg-[var(--panel-2)]"
                  : "border-[var(--border)] bg-[var(--panel)]"
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      <label className="grid gap-1 text-sm">
        <span className="text-[var(--muted)]">화풍(style prompt) — 나중에 수정 가능</span>
        <textarea
          value={stylePrompt}
          onChange={(e) => setStylePrompt(e.target.value)}
          rows={3}
          placeholder="예: 부드러운 셀 애니메이션 화풍, 파스텔 톤, 두꺼운 라인아트"
          className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-2"
        />
      </label>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      <button
        onClick={submit}
        disabled={busy}
        className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "만드는 중…" : "만들기"}
      </button>
    </div>
  );
}
