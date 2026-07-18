import { NextResponse } from "next/server";
import catalog from "@/config/voices.json";

export const runtime = "nodejs";

// GET — 더빙 목소리 카탈로그. 큐레이션 JSON(config/voices.json) + ★ElevenLabs 계정 목소리를
// 동적으로 합쳐 서빙(사용자 요구: 목소리 훨씬 많이). 캐스팅/나레이터가 이 목록에서 골라 붙인다.
// 실제 음성 생성은 워커가 provider 별 키로 수행. 미교체 placeholder(REPLACE_ME_*)는 제외.
// ★ELEVENLABS_API_KEY 가 앱(Vercel) env 에 있어야 계정 목소리를 불러온다(없으면 큐레이션만).
type CatalogVoice = {
  provider?: string;
  id?: string;
  name?: string;
  lang?: string;
  gender?: string;
  note?: string;
  narration?: boolean;
};

type Voice = {
  id: string;
  name: string;
  provider: string;
  language: string;
  gender: string;
  age: string; // ★카테고리 필터용(young/middle_aged/old 등)
  note: string;
  narration: boolean;
};

// ElevenLabs 계정 목소리(premade + 커스텀) 조회 → 표시용 포맷. 키 없거나 실패 시 빈 배열.
async function fetchElevenVoices(): Promise<Voice[]> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return [];
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!r.ok) return [];
    const d = (await r.json()) as { voices?: Array<Record<string, unknown>> };
    return (d.voices ?? [])
      .map((v) => {
        const labels = (v.labels ?? {}) as Record<string, string>;
        return {
          id: String(v.voice_id ?? ""),
          name: String(v.name ?? v.voice_id ?? ""),
          provider: "eleven",
          language: labels.language || labels.accent || "",
          gender: labels.gender || "",
          age: labels.age || "",
          note: [v.category, labels.descriptive || labels.description]
            .filter(Boolean)
            .join(" · ")
            .slice(0, 80),
          narration: false,
        } as Voice;
      })
      .filter((v) => v.id);
  } catch {
    return [];
  }
}

export async function GET() {
  const raw = ((catalog as { voices?: CatalogVoice[] }).voices ?? []) as CatalogVoice[];
  const curated: Voice[] = raw
    .filter((v) => v && typeof v.id === "string" && v.id && !v.id.startsWith("REPLACE_ME"))
    .map((v) => ({
      id: v.id as string,
      name: v.name || (v.id as string),
      provider: v.provider === "typecast" ? "typecast" : "eleven",
      language: v.lang || "",
      gender: v.gender || "",
      age: "",
      note: v.note || "",
      narration: v.narration === true,
    }));

  // 큐레이션 우선 → ElevenLabs 계정 목소리 중 아직 없는 것만 추가(중복 id 제거).
  const eleven = await fetchElevenVoices();
  const seen = new Set(curated.map((v) => v.id));
  const voices = [...curated, ...eleven.filter((v) => !seen.has(v.id))];

  return NextResponse.json({ ok: true, voices });
}
