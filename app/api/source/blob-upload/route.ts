import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// 브라우저가 Blob 로 "직접" 업로드하기 위한 클라이언트 토큰 발급 엔드포인트.
// 큰 웹툰 파일을 서버리스 함수로 보내지 않으므로 Vercel 4.5MB 본문 한계를 우회한다.
// 업로드 완료 후 SourceFile 등록은 클라가 /api/source/register 로 별도 호출.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
          "image/bmp",
        ],
        addRandomSuffix: true,
      }),
      onUploadCompleted: async () => {
        // 등록은 클라가 upload() 완료 후 /api/source/register 로 처리(웹훅 의존 X).
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "업로드 토큰 발급 실패" },
      { status: 400 }
    );
  }
}
