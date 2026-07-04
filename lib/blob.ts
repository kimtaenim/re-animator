// ============================================================================
// 에셋 저장소 추상화 (aninews-maker21 계승) — 소스 이미지 · 추출 컷 이미지
// ----------------------------------------------------------------------------
// Vercel Blob. access:"public" → 반환 url 이 그대로 공개 URL.
// grok/fal I2V 가 입력 이미지의 공개 URL 을 요구하므로(§M5) 이 공개성이 핵심.
// 나중에 R2/S3 로 갈아끼울 때도 이 모듈만 고치면 된다.
// ============================================================================

import { put, del, list } from "@vercel/blob";

export interface UploadedAsset {
  url: string;
}

export async function uploadAsset(
  pathname: string,
  data: ArrayBuffer | Buffer | Blob | string,
  contentType: string
): Promise<UploadedAsset> {
  const r = await put(pathname, data as Buffer | Blob | string, {
    access: "public",
    contentType,
    addRandomSuffix: false,
  });
  return { url: r.url };
}

export { del as deleteAsset, list as listAssets };
