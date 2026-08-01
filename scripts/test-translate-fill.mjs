// ============================================================================
// 번역이 '실제로 채워지는지' 를 코드 전체를 돌려 확인한다(모델 호출만 가짜).
// ----------------------------------------------------------------------------
// 한 달간 이 경로가 조용히 0줄을 돌려줬는데, 네트워크가 필요하다는 이유로
// 아무도 실행해보지 않았다. 모델 응답 형태만 주입하고 나머지(파싱→적용→재시도)는 진짜 코드다.
// 실행: node scripts/test-translate-fill.mjs
// ============================================================================
import { translateScenesMultilang } from "../worker/translate.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const mkScenes = (texts) => [
  { id: "s1", cut: { bubbles: texts.map((t) => ({ text: t, speakerId: "c1", tracks: {} })) } },
];
const filled = (scenes, lang) =>
  scenes[0].cut.bubbles.filter((b) => (b.tracks?.[lang]?.text || "").trim()).length;

// 모델이 '정상적으로 완결된' JSON 을 주는 경우 — 실제 응답의 기본형.
const wholeJson = (prompt) => {
  const n = (prompt.match(/^\d+\. /gm) || []).length;
  const items = Array.from({ length: n }, (_, k) => `{"i":${k},"ja":"訳${k}"}`).join(",");
  return { stop_reason: "end_turn", content: [{ type: "text", text: `{"t":[${items}]}` }], usage: { input_tokens: 10, output_tokens: 20 } };
};

console.log("정상 응답(완결 JSON):");
{
  const scenes = mkScenes(["你好", "快跑", "住手", "我知道了", "别动"]);
  const { translated, errors } = await translateScenesMultilang(scenes, ["ja"], { _call: async ({ messages }) => wholeJson(messages[0].content) });
  check("5줄 전부 tracks.ja 가 채워진다", filled(scenes, "ja") === 5, `${filled(scenes, "ja")}줄`);
  check("translated 카운트가 5", translated === 5, String(translated));
  check("에러 없음", !errors?.length, JSON.stringify(errors));
}

console.log("응답이 잘린 경우(앞부분만 살리고 나머지는 재시도):");
{
  const scenes = mkScenes(["你好", "快跑", "住手", "我知道了"]);
  let call = 0;
  const { translated } = await translateScenesMultilang(scenes, ["ja"], {
    _call: async ({ messages }) => {
      call++;
      const n = (messages[0].content.match(/^\d+\. /gm) || []).length;
      if (call === 1) return { stop_reason: "max_tokens", content: [{ type: "text", text: `{"t":[{"i":0,"ja":"訳0"},{"i":1,"ja":"訳` }], usage: {} };
      const items = Array.from({ length: n }, (_, k) => `{"i":${k},"ja":"再${k}"}`).join(",");
      return { stop_reason: "end_turn", content: [{ type: "text", text: `{"t":[${items}]}` }], usage: {} };
    },
  });
  check("잘려도 재시도로 4줄 전부 채운다", filled(scenes, "ja") === 4, `${filled(scenes, "ja")}줄`);
  check("translated 카운트가 4", translated === 4, String(translated));
}

console.log("모델이 거부(refusal)한 경우 — 이유가 올라온다:");
{
  const scenes = mkScenes(["你好", "快跑"]);
  const { translated, errors } = await translateScenesMultilang(scenes, ["ja"], {
    _call: async () => ({ stop_reason: "refusal", content: [{ type: "text", text: "" }], usage: {} }),
  });
  check("0줄", translated === 0);
  check("이유가 errors 에 담긴다(조용한 실패 금지)", !!errors?.length && /refusal|거부/.test(errors[0]), JSON.stringify(errors));
}

console.log("기호만 있는 줄 — 모델 호출 없이 통과:");
{
  const scenes = mkScenes(["……", "!?"]);
  let called = 0;
  const { translated } = await translateScenesMultilang(scenes, ["ja"], { _call: async () => { called++; return wholeJson(""); } });
  check("2줄 채워지고 모델 호출 0", filled(scenes, "ja") === 2 && called === 0, `채움 ${filled(scenes, "ja")}, 호출 ${called}`);
  check("translated 카운트가 2", translated === 2, String(translated));
}

console.log(`\n결과: ${pass}/${pass + fail} 통과`);
process.exit(fail === 0 ? 0 : 1);
