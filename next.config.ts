import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 상위 폴더(C:\myapps)에 다른 lockfile 이 있어 루트가 잘못 잡히는 걸 방지.
  turbopack: { root: import.meta.dirname },
  images: {
    // Vercel Blob 공개 URL (소스 이미지·추출 컷 썸네일)을 next/image 로 띄울 때 허용.
    remotePatterns: [
      { protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
    ],
  },
};

export default nextConfig;
