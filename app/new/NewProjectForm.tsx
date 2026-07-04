"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { type AspectRatio } from "@/lib/types";

// 비율 + 방향 라벨 + 미리보기 사각형 크기.
const ASPECTS: { id: AspectRatio; label: string; w: number; h: number }[] = [
  { id: "16:9", label: "가로형", w: 40, h: 22 },
  { id: "9:16", label: "세로형", w: 22, h: 40 },
  { id: "1:1", label: "정사각형", w: 30, h: 30 },
];

export default function NewProjectForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/project", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, aspectRatio }),
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
    <div className="grid gap-5">
      <label className="grid gap-1 text-sm">
        <span className="text-[var(--muted)]">이름</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="예: 재의 마녀 1화"
          className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-2"
        />
      </label>

      <div className="grid gap-2 text-sm">
        <span className="text-[var(--muted)]">화면 비율</span>
        <div className="flex gap-2">
          {ASPECTS.map((a) => {
            const on = aspectRatio === a.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setAspectRatio(a.id)}
                className={`flex flex-1 flex-col items-center gap-1.5 rounded-md border px-3 py-3 ${
                  on
                    ? "border-[var(--accent)] bg-[var(--panel-2)]"
                    : "border-[var(--border)] bg-[var(--panel)]"
                }`}
              >
                <span className="flex h-11 items-center justify-center">
                  <span
                    className={`rounded-sm border-2 ${on ? "border-[var(--accent)]" : "border-[var(--muted)]"}`}
                    style={{ width: a.w, height: a.h }}
                  />
                </span>
                <span className="font-medium">{a.id}</span>
                <span className="text-[11px] text-[var(--muted)]">{a.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-[var(--muted)]">
        화풍은 이미지를 올린 뒤 캐스팅·재생성 단계에서 정합니다.
      </p>

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
