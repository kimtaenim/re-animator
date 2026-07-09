import { NextResponse } from "next/server";
import catalog from "@/config/voices.json";

export const runtime = "nodejs";

// GET — 더빙 목소리 카탈로그(config/voices.json) 서빙. voice_id 는 공개값이라 API 조회·env 대신
// 큐레이션한 JSON 으로 관리한다. 캐스팅/나레이터가 이 목록에서 골라 붙인다. 실제 음성 생성은
// 워커가 provider 별 API 키로 수행. 미교체 placeholder(REPLACE_ME_*)는 목록에서 제외.
type CatalogVoice = {
  provider?: string;
  id?: string;
  name?: string;
  lang?: string;
  gender?: string;
  note?: string;
  narration?: boolean;
};

export async function GET() {
  const raw = ((catalog as { voices?: CatalogVoice[] }).voices ?? []) as CatalogVoice[];
  const voices = raw
    .filter((v) => v && typeof v.id === "string" && v.id && !v.id.startsWith("REPLACE_ME"))
    .map((v) => ({
      id: v.id as string,
      name: v.name || (v.id as string),
      provider: v.provider === "typecast" ? "typecast" : "eleven",
      language: v.lang || "",
      gender: v.gender || "",
      note: v.note || "",
      narration: v.narration === true,
    }));
  return NextResponse.json({ ok: true, voices });
}
