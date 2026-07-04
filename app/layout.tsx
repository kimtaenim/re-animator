import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Noto_Sans_KR } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const notoSansKr = Noto_Sans_KR({
  weight: ["400", "700"],
  subsets: ["latin"],
  display: "swap",
  preload: false,
  variable: "--font-noto-sans-kr",
});

export const metadata: Metadata = {
  title: "re-animator",
  description: "웹툰 → 동영상 자동 변환 하네스",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} ${notoSansKr.variable} antialiased`}
    >
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
