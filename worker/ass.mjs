// ============================================================================
// ASS 자막 생성 (스펙 §7) — PNG 오버레이 대체.
// ----------------------------------------------------------------------------
// 스펙 §7: 하단 중앙, 텍스트 하단 = 화면 높이 92-95% 지점, 블록 높이 4-5%(720p 약 30px),
//   흰색 + 검은 외곽선 2px, 배경 박스 없음. 타이밍은 오디오 종속 — 시작 0.1초 전 표시,
//   종료 0.2초 후 소멸. ASS 로 생성해 ffmpeg subtitles 필터로 번인.
//
// ★왜 PNG 대신 ASS 인가:
//   1) 스펙이 ASS 를 지정했다.
//   2) 캡션마다 sharp/canvas 로 PNG 를 만들면 compose(OOM 경계 경로)에 이미지 디코딩이
//      들어간다 — 이 프로젝트에서 반복된 OOM 의 알려진 원인. ASS 는 텍스트 파일 하나라
//      네이티브 이미지 메모리가 0 이다.
//   3) ffmpeg 입력 수가 줄어든다(캡션 N개 → 0개).
//
// ★워커 자기완결 — ../lib import 금지.
// ============================================================================

// ASS 는 시간을 H:MM:SS.cc(1/100초)로 쓴다.
function assTime(sec) {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.round((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// ASS 특수문자 이스케이프 + 줄바꿈(\N). 중괄호는 태그로 해석되므로 반드시 치환.
function assText(t) {
  return String(t || "")
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, "\\N")
    .trim();
}

// [[강조]] 마커 → 크게·노랑(미리보기/PNG 경로와 같은 규칙). 나머지는 기본 스타일.
function withEmphasis(t) {
  // {\fscx130\fscy130\c&H3FD2FF&} = 130% 크기 + 노랑(BGR). 끝에서 원복.
  return assText(t).replace(/\[\[(.+?)\]\]/g, "{\\fscx130\\fscy130\\c&H3FD2FF&}$1{\\r}");
}

/**
 * 캡션 목록 → ASS 파일 내용.
 * @param caps [{ text, start, end, sx?, sy? }]  sx/sy = 0~1 화면 비율(그 줄 지정, 없으면 기본)
 * @param opts { W, H, defaultYFrac, defaultXFrac, fontName, leadIn, leadOut }
 */
export function buildAss(caps, opts = {}) {
  const W = Math.max(2, Math.round(opts.W || 1280));
  const H = Math.max(2, Math.round(opts.H || 720));
  // 스펙 §7: 블록 높이 4-5%(720p 약 30px) → 폰트 크기를 해상도에 비례시킨다.
  const fontSize = Math.max(14, Math.round(H * 0.045));
  // 외곽선 2px(720p 기준) — 해상도 비례로 살짝 키운다.
  const outline = Math.max(2, Math.round(H / 360));
  // ★폰트 이름 — libass 는 시스템 폰트를 찾는다. Render(Linux)엔 한글 폰트가 없어
  //   Windows 전용 이름(Malgun Gothic)을 쓰면 자막이 아예 안 그려진다(실측 확인).
  //   PNG 경로가 쓰는 Noto Sans KR 파일을 fontsdir 로 물려주고, 그 패밀리명을 쓴다.
  const font = opts.fontName || process.env.ASS_FONT || "Noto Sans KR";
  const leadIn = opts.leadIn ?? 0.1; // 시작 0.1초 전
  const leadOut = opts.leadOut ?? 0.2; // 종료 0.2초 후
  // 기본 위치: 텍스트 '하단'이 화면 93% 지점(스펙 92-95%) → 하단 여백으로 환산.
  const defYFrac = opts.defaultYFrac ?? 0.93;
  const marginV = Math.max(0, Math.round(H * (1 - defYFrac)));

  const header =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n` +
    `[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    // PrimaryColour 흰색, OutlineColour 검정, BorderStyle 1(외곽선만 = 배경 박스 없음), Shadow 0.
    // Alignment 2 = 하단 중앙.
    `Style: Def,${font},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,${Math.round(W * 0.06)},${Math.round(W * 0.06)},${marginV},1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  const lines = [];
  for (const c of caps ?? []) {
    const text = withEmphasis(c.text);
    if (!text) continue;
    const st = assTime(Math.max(0, (Number(c.start) || 0) - leadIn));
    const en = assTime((Number(c.end) || 0) + leadOut);
    // 줄별 위치 지정이 있으면 \pos 로 그 좌표에 놓는다(화자 번갈아 말할 때 줄마다 다른 위치).
    const hasPos = typeof c.sx === "number" || typeof c.sy === "number";
    let body = text;
    if (hasPos) {
      const px = Math.round(W * Math.max(0.05, Math.min(0.95, typeof c.sx === "number" ? c.sx : 0.5)));
      const py = Math.round(H * Math.max(0.05, Math.min(0.95, typeof c.sy === "number" ? c.sy : defYFrac)));
      // \an5 = 지정 좌표를 '가운데' 기준으로 해석.
      body = `{\\an5\\pos(${px},${py})}${text}`;
    }
    lines.push(`Dialogue: 0,${st},${en},Def,,0,0,0,,${body}`);
  }
  return header + lines.join("\n") + "\n";
}

// ffmpeg subtitles 필터에 넣을 경로 문자열 이스케이프.
//   Windows 경로(C:\...)와 콜론·따옴표는 필터 문법과 충돌하므로 반드시 처리한다.
export function assFilterPath(p) {
  return String(p).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
