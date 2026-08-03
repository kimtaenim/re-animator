// 실제 lib/cutClean.ts 의 invalidateEditedAudio 를 실행 검증 —
// "대사·효과음 텍스트를 고치면 그 줄 소리만 무효화, 안 고친 줄·이동한 줄은 보존" 규칙.
// (더빙 증분은 '소리 있음'만 보므로, 여기서 안 지우면 옛 텍스트 소리가 영영 남는다.)
import { invalidateEditedAudio } from "../lib/cutClean";
import type { CutOntology } from "../lib/types";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => (c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n)));

const cut = (over: Partial<CutOntology>): CutOntology => ({ type: null, confirmed: false, ...over } as CutOntology);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

// prev = 서버 현재값(더빙 완료 상태)
const prev = cut({
  narration: "밤이 깊었다.",
  narrationAudioUrl: "blob:narr-1",
  sfx: "쿵",
  sfxAudioUrl: "blob:sfx-1",
  bubbles: [
    { text: "住手！", speakerId: "c1", audioUrl: "blob:a1", tracks: { ja: { text: "やめて！", audioUrl: "blob:a1-ja", durationFinal: 1.2, status: "tts" } } },
    { text: "__sfx__ 콰앙", speakerId: null, audioUrl: "blob:a2" },
    { text: "你怎么在这里？", speakerId: "c2", audioUrl: "blob:a3", tracks: { ja: { text: "どうしてここに？", audioUrl: "blob:a3-ja", status: "done" } } },
  ],
  audioSuggestions: [{ type: "sfx", text: "유리 깨지는 소리", audioUrl: "blob:sug-1" }],
});

console.log("[1] 아무것도 안 고침 → 소리 전부 보존");
{
  const out = invalidateEditedAudio(clone(prev), clone(prev));
  ok("원어 소리 보존", out.bubbles![0].audioUrl === "blob:a1" && out.bubbles![1].audioUrl === "blob:a2");
  ok("언어 트랙 소리 보존", out.bubbles![0].tracks!.ja.audioUrl === "blob:a1-ja");
  ok("내레이션·효과음·제안 보존", out.narrationAudioUrl === "blob:narr-1" && out.sfxAudioUrl === "blob:sfx-1" && out.audioSuggestions![0].audioUrl === "blob:sug-1");
}

console.log("[2] 대사 텍스트 수정 → 그 줄 원어+언어 소리만 무효화(다른 줄 보존)");
{
  const edited = clone(prev);
  edited.bubbles![0].text = "住手！！快住手！"; // 0번 줄만 수정
  const out = invalidateEditedAudio(edited, clone(prev));
  ok("고친 줄 원어 소리 제거", out.bubbles![0].audioUrl === undefined);
  ok("고친 줄 언어 소리 제거(번역 텍스트는 보존)", out.bubbles![0].tracks!.ja.audioUrl === undefined && out.bubbles![0].tracks!.ja.text === "やめて！");
  ok("고친 줄 durationFinal 제거·status 강등", out.bubbles![0].tracks!.ja.durationFinal === undefined && out.bubbles![0].tracks!.ja.status === "translated");
  ok("안 고친 줄 보존", out.bubbles![1].audioUrl === "blob:a2" && out.bubbles![2].audioUrl === "blob:a3" && out.bubbles![2].tracks!.ja.audioUrl === "blob:a3-ja");
}

console.log("[3] 효과음(__sfx__) 줄 텍스트 수정 → 그 소리 무효화");
{
  const edited = clone(prev);
  edited.bubbles![1].text = "__sfx__ 우르릉";
  const out = invalidateEditedAudio(edited, clone(prev));
  ok("효과음 줄 소리 제거", out.bubbles![1].audioUrl === undefined);
  ok("다른 줄 보존", out.bubbles![0].audioUrl === "blob:a1");
}

console.log("[4] 번역 텍스트만 수정 → 원어 소리 보존, 그 언어 소리만 무효화");
{
  const edited = clone(prev);
  edited.bubbles![2].tracks!.ja.text = "なぜ君がここに？";
  const out = invalidateEditedAudio(edited, clone(prev));
  ok("원어 소리 보존", out.bubbles![2].audioUrl === "blob:a3");
  ok("그 언어 소리 제거", out.bubbles![2].tracks!.ja.audioUrl === undefined);
  ok("고친 번역 텍스트 유지", out.bubbles![2].tracks!.ja.text === "なぜ君がここに？");
}

console.log("[5] 맨 앞에 줄 삽입(인덱스 밀림) → 밀린 줄들 소리 오폭 없음");
{
  const edited = clone(prev);
  edited.bubbles = [{ text: "(새 대사)", speakerId: "c1" }, ...edited.bubbles!];
  const out = invalidateEditedAudio(edited, clone(prev));
  ok("밀린 줄 원어 소리 보존", out.bubbles![1].audioUrl === "blob:a1" && out.bubbles![2].audioUrl === "blob:a2" && out.bubbles![3].audioUrl === "blob:a3");
  ok("밀린 줄 언어 소리 보존", out.bubbles![1].tracks!.ja.audioUrl === "blob:a1-ja" && out.bubbles![3].tracks!.ja.audioUrl === "blob:a3-ja");
  ok("새 줄은 소리 없음 그대로", out.bubbles![0].audioUrl === undefined);
}

console.log("[6] 내레이션·컷 효과음 필드 수정 → 해당 소리 무효화");
{
  const edited = clone(prev);
  edited.narration = "새벽이 밝았다.";
  edited.sfx = "쾅";
  const out = invalidateEditedAudio(edited, clone(prev));
  ok("내레이션 소리 제거", out.narrationAudioUrl === undefined);
  ok("컷 효과음 소리 제거", out.sfxAudioUrl === undefined);
  ok("말풍선 소리는 보존", out.bubbles![0].audioUrl === "blob:a1");
}

console.log("[7] 오디오 제안 텍스트 수정 → 생성음 무효화");
{
  const edited = clone(prev);
  edited.audioSuggestions![0].text = "문 두드리는 소리";
  const out = invalidateEditedAudio(edited, clone(prev));
  ok("제안 소리 제거", out.audioSuggestions![0].audioUrl === undefined);
}

console.log("[8] prev 없음(새 컷) → 무변경 통과");
{
  const edited = clone(prev);
  const out = invalidateEditedAudio(edited, undefined);
  ok("그대로 반환", out.bubbles![0].audioUrl === "blob:a1" && out.narrationAudioUrl === "blob:narr-1");
}

console.log(`\n결과: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
