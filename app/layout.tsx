import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "re-animator",
  description: "웹툰 → 동영상 자동 변환 하네스",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        <header className="border-b border-[var(--border)] px-6 py-3">
          <Link href="/" className="text-sm font-semibold tracking-wide">
            re<span className="text-[var(--accent)]">·</span>animator
          </Link>
          <span className="ml-2 text-xs text-[var(--muted)]">웹툰 → 동영상</span>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
