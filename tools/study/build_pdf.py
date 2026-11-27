"""요점노트·시험대비 항목(JSON)으로 교사용 PDF의 원본 HTML을 만듭니다.

사용: 저장소 맨 위 폴더에서
    python tools/study/build_pdf.py <study json> <출력 폴더> [항목 id…]
항목마다 요점정리_<단원>_<단원 제목>.html, 시험대비문제_<단원>_<단원 제목>.html을 씁니다(id를 안 주면 모든 항목).
그다음 `node tools/study/render.js <출력 폴더>`가 HTML을 PDF로 바꿉니다(tools/study에서 npm install 먼저).
글 안에서는 <b>, <u>, <br>만 꾸밈으로 쓰고 나머지는 모두 HTML 이스케이프합니다.
"""

import html
import re
import sys
from pathlib import Path

NUM5 = "①②③④⑤"
_FONTS = (Path(__file__).resolve().parent / "node_modules" / "@fontsource" / "noto-sans-kr")
FONT = "".join(f'<link rel="stylesheet" href="{(_FONTS / f"{weight}.css").as_uri()}">' for weight in (400, 700))
_ALLOWED = re.compile(r"&lt;(/?)([bu])&gt;|&lt;br\s*/?&gt;", re.IGNORECASE)

BASE_CSS = """
@page { size: A4; margin: 9mm 11mm 12mm 11mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Noto Sans KR', sans-serif; font-size: 9pt; line-height: 1.5; color: #222; margin: 0; }
b { font-weight: 700; }
.cols { column-count: 2; column-gap: 7mm; column-rule: 1px solid #e3e8ef; orphans: 2; }
"""

NOTES_CSS = BASE_CSS + """
:root { --c: #2b6cb0; --soft: #edf4fc; --warm: #fff6e5; --warmline: #f0b24a; --ink: #1d2b3a; }
.hero { background: linear-gradient(120deg, #2b6cb0, #4a90d9); color: #fff; border-radius: 3mm; padding: 3mm 6mm; margin-bottom: 3mm; }
.hero .unit { font-size: 8pt; opacity: .9; }
.hero h1 { font-size: 15pt; margin: 0.6mm 0 0.4mm; line-height: 1.25; }
.hero .sub { font-size: 8.2pt; opacity: .92; }
.goals { display: flex; gap: 3mm; margin-bottom: 4mm; }
.goal { flex: 1; background: var(--soft); border-radius: 2.5mm; padding: 2.2mm 3mm; font-size: 8.4pt; }
.goal i { font-style: normal; font-weight: 700; color: var(--c); margin-right: 1.5mm; }
h2.big { font-size: 10.5pt; color: #fff; background: var(--c); border-radius: 2mm; padding: 0.8mm 3mm; margin: 2.6mm 0 1.6mm; break-after: avoid; }
.hh { margin: 2.6mm 0 1.3mm; break-after: avoid; border-bottom: 2px solid var(--c); padding-bottom: 0.6mm; }
.hh .t { font-size: 11pt; font-weight: 700; color: var(--ink); }
.hh .s { font-size: 7.8pt; color: #607080; margin-left: 2mm; }
.card { border: 1px solid #cfdcec; border-radius: 2.2mm; margin: 1.6mm 0 2mm; break-inside: avoid; overflow: hidden; }
.card .ct { background: var(--soft); color: var(--c); font-weight: 700; padding: 0.9mm 3mm; font-size: 8.6pt; }
.card ul { margin: 0; padding: 1.4mm 3mm 1.4mm 6mm; }
.card li { margin: 0.4mm 0; }
.def { background: #f3f7fb; border-left: 3px solid var(--c); padding: 1.6mm 3mm; margin: 1.5mm 0; border-radius: 0 2mm 2mm 0; break-inside: avoid; }
.tip { background: var(--warm); border-left: 3px solid var(--warmline); padding: 1.6mm 3mm; margin: 1.6mm 0 2.2mm; border-radius: 0 2mm 2mm 0; break-inside: avoid; }
.tip:before { content: '꼭 기억해요  '; font-weight: 700; color: #b26a00; }
table { border-collapse: collapse; width: 100%; margin: 1.4mm 0 2.2mm; font-size: 8.4pt; }
tr { break-inside: avoid; }
th { background: var(--c); color: #fff; font-weight: 700; padding: 1mm 1.6mm; border: 1px solid #fff; text-align: left; break-after: avoid; }
td { padding: 1mm 1.6mm; border: 1px solid #d5e0ee; vertical-align: top; }
tr:nth-child(even) td { background: #f6f9fd; }
td:first-child { font-weight: 700; color: var(--ink); white-space: nowrap; }
.flow { margin: 1.4mm 0 2.2mm; }
.flow .step { display: flex; gap: 2mm; margin: 0.8mm 0; align-items: stretch; break-inside: avoid; }
.flow .lab { flex: 0 0 15mm; background: var(--c); color: #fff; font-weight: 700; text-align: center; border-radius: 1.8mm; padding: 1mm 0; font-size: 8.4pt; display: flex; align-items: center; justify-content: center; }
.flow .tx { flex: 1; background: #f3f7fb; border-radius: 1.8mm; padding: 1mm 2.4mm; }
.flowt { font-weight: 700; color: var(--c); margin: 1.6mm 0 0.6mm; font-size: 8.6pt; }
ul.list { margin: 1mm 0 2mm; padding-left: 5mm; }
"""

QUIZ_CSS = BASE_CSS + """
:root { --c: #2b6cb0; --ink: #1d2b3a; }
.head { border: 2px solid var(--c); border-radius: 2.5mm; padding: 3mm 4.5mm; margin-bottom: 3mm; display: flex; justify-content: space-between; align-items: flex-end; }
.head h1 { font-size: 14pt; margin: 0; color: var(--ink); line-height: 1.3; }
.head .u { font-size: 8pt; color: #607080; }
.head .who { font-size: 8.6pt; text-align: right; line-height: 1.9; white-space: nowrap; }
.guide { font-size: 7.8pt; color: #607080; margin-bottom: 2.4mm; }
h2.sec { font-size: 10pt; background: var(--c); color: #fff; padding: 0.9mm 3mm; border-radius: 1.8mm; margin: 2.4mm 0 1.6mm; break-after: avoid; }
h2.sec span { font-weight: 400; font-size: 8pt; margin-left: 2mm; opacity: .92; }
.q { break-inside: avoid; margin: 0 0 2.4mm; }
.q .n { font-weight: 700; color: var(--c); }
.ch { margin: 0.5mm 0 0 4mm; padding-left: 4mm; text-indent: -4mm; }
.line { border-bottom: 1px dotted #999; height: 5.4mm; margin-top: 0.6mm; }
.ans { display: inline-block; min-width: 14mm; border-bottom: 1px solid #555; margin-left: 2mm; }
.ox { display: inline-block; border: 1px solid #555; border-radius: 50%; width: 5.5mm; height: 5.5mm; margin-left: 2mm; vertical-align: middle; }
.key h2.sec { background: #b23b3b; }
.a { break-inside: avoid; margin: 0 0 1.6mm; font-size: 8.4pt; line-height: 1.45; }
.a .n { font-weight: 700; color: #b23b3b; }
.a .r { color: #555; display: block; margin-left: 4mm; }
.pb { break-before: page; }
.psg { border: 1px solid #cfdcec; background: #fafcff; border-radius: 2mm; padding: 2mm 3mm; margin: 0 0 2.6mm; }
.psg h3 { font-size: 9.4pt; margin: 0 0 1mm; color: var(--c); }
.psg h3 b { background: var(--c); color: #fff; border-radius: 1.4mm; padding: 0 2mm; margin-right: 1.6mm; }
.psg p { margin: 0 0 1.2mm; text-align: justify; line-height: 1.55; }
.psg u { text-decoration: underline; text-underline-offset: 1px; }
.psg .src { display: block; text-align: right; font-size: 7.6pt; color: #607080; }
.bogi { border: 1px solid #aab8c8; border-radius: 1.6mm; padding: 1mm 2mm; margin: 1mm 0; font-size: 8.6pt; background: #fff; }
"""


def esc(value) -> str:
    """모든 글을 이스케이프하되 <b>, <u>, <br>만 꾸밈으로 되살립니다."""
    safe = html.escape("" if value is None else str(value), quote=False)
    return _ALLOWED.sub(lambda m: "<br>" if m.group(0).lower().startswith("&lt;br") else f"<{m.group(1)}{m.group(2).lower()}>", safe)


def _block(blk) -> str:
    kind = blk.get("t") if isinstance(blk, dict) else None
    if kind == "big":
        return f'<h2 class="big">{esc(blk.get("title"))}</h2>' + "".join(_block(b) for b in blk.get("blocks") or [])
    if kind == "h":
        return f'<div class="hh"><span class="t">{esc(blk.get("title"))}</span><span class="s">{esc(blk.get("sub"))}</span></div>'
    if kind in ("def", "tip"):
        return f'<div class="{kind}">{esc(blk.get("text"))}</div>'
    if kind == "card":
        items = "".join(f"<li>{esc(x)}</li>" for x in blk.get("items") or [])
        return f'<div class="card"><div class="ct">{esc(blk.get("title"))}</div><ul>{items}</ul></div>'
    if kind == "list":
        return '<ul class="list">' + "".join(f"<li>{esc(x)}</li>" for x in blk.get("items") or []) + "</ul>"
    if kind == "flow":
        title = f'<div class="flowt">{esc(blk["title"])}</div>' if blk.get("title") else ""
        steps = "".join(f'<div class="step"><div class="lab">{esc(s.get("label"))}</div><div class="tx">{esc(s.get("text"))}</div></div>'
                        for s in blk.get("steps") or [])
        return title + f'<div class="flow">{steps}</div>'
    if kind == "table":
        head = "".join(f"<th>{esc(h)}</th>" for h in blk.get("head") or [])
        rows = "".join("<tr>" + "".join(f"<td>{esc(c)}</td>" for c in row) + "</tr>" for row in blk.get("rows") or [])
        return f"<table><tr>{head}</tr>{rows}</table>"
    raise SystemExit(f"알 수 없는 요점노트 블록 종류입니다: {kind!r}")


def notes_html(entry: dict) -> str:
    """요점정리 한 편(완전한 HTML 문서)."""
    notes, title = entry.get("notes") or {}, entry.get("unit_title", "")
    goals = "".join(f'<div class="goal"><i>목표 {n}</i>{esc(g)}</div>' for n, g in enumerate(notes.get("goals") or [], 1))
    words = "".join(f"<tr><td>{esc(w.get('w'))}</td><td>{esc(w.get('def'))}</td></tr>" for w in notes.get("words") or [])
    word_part = f'<h2 class="big">낱말 풀이</h2><table><tr><th>낱말</th><th>뜻</th></tr>{words}</table>' if words else ""
    return f"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>{esc(title)} 요점 정리</title>{FONT}<style>{NOTES_CSS}</style></head><body>
<div class="hero"><div class="unit">{esc(notes.get("unit") or entry.get("unit"))}</div><h1>{esc(title)} — 요점 정리</h1><div class="sub">{esc(notes.get("sub"))}</div></div>
<div class="goals">{goals}</div>
<div class="cols">
{"".join(_block(b) for b in notes.get("blocks") or [])}
{word_part}
</div>
</body></html>"""


def _qtext(q) -> str:
    """질문 첫 줄 아래에 줄바꿈이 있으면 나머지를 보기 상자로 둡니다."""
    head, _, rest = str(q).partition("\n")
    return f'{esc(head)}<div class="bogi">{esc(rest)}</div>' if rest else esc(head)


def _heading(title, sub="") -> str:
    return f'<h2 class="sec">{title}<span>{sub}</span></h2>' if sub else f'<h2 class="sec">{title}</h2>'


def quiz_html(entry: dict) -> str:
    """시험대비문제 한 편(완전한 HTML 문서): 지문 → 객관식 → 주관식 → OX → 단답형, 새 쪽에서 정답과 해설."""
    quiz, title = entry.get("quiz") or {}, entry.get("unit_title", "")
    passages, mc, sub = quiz.get("passages") or [], quiz.get("mc") or [], quiz.get("sub") or []
    ox, short = quiz.get("ox") or [], quiz.get("short") or []
    labels = "~".join(esc(p.get("label")) for p in (passages[0], passages[-1])) if passages else ""
    parts = [_heading("지문", f"[{labels}]를 읽고 물음에 답하시오. 모든 문항은 지문을 근거로 풉니다.")]
    for p in passages:
        source = f'<span class="src">{esc(p["source"])}</span>' if p.get("source") else ""
        parts.append(f'<div class="psg"><h3><b>{esc(p.get("label"))}</b>{esc(p.get("title"))}</h3>'
                     + "".join(f"<p>{esc(x)}</p>" for x in p.get("paras") or []) + source + "</div>")
    n = 0
    parts.append(_heading("Ⅰ. 객관식", f"{len(mc)}문항 · 5지선다 · 가장 적절한 것을 고르시오"))
    for item in mc:
        n += 1
        choices = "".join(f'<div class="ch">{NUM5[i]} {esc(c)}</div>' for i, c in enumerate(item.get("choices") or []))
        parts.append(f'<div class="q"><span class="n">{n}.</span> {_qtext(item.get("q"))}{choices}</div>')
    parts.append(_heading("Ⅱ. 주관식", f"{len(sub)}문항 · 조건에 맞게 쓰시오"))
    for item in sub:
        n += 1
        parts.append(f'<div class="q"><span class="n">{n}.</span> {esc(item.get("q"))}' + '<div class="line"></div>' * 3 + "</div>")
    parts.append(_heading("Ⅲ. OX", f"{len(ox)}문항 · 지문과 일치하면 O, 일치하지 않으면 X"))
    for item in ox:
        n += 1
        parts.append(f'<div class="q"><span class="n">{n}.</span> {esc(item.get("q"))} <span class="ox"></span></div>')
    parts.append(_heading("Ⅳ. 단답형", f"{len(short)}문항 · 지문에서 찾아 쓰시오"))
    for item in short:
        n += 1
        parts.append(f'<div class="q"><span class="n">{n}.</span> {esc(item.get("q"))}<span class="ans"></span></div>')

    key, n = ['<div class="key"><h2 class="sec" style="column-span:all">정답과 해설</h2>', _heading("Ⅰ. 객관식")], 0
    for item in mc:
        n += 1
        ans = item.get("answer")
        mark = NUM5[ans] if isinstance(ans, int) and 0 <= ans < len(NUM5) else "?"
        key.append(f'<div class="a"><span class="n">{n}. {mark}</span> {esc(item.get("exp"))}</div>')
    key.append(_heading("Ⅱ. 주관식 (모범 답안)"))
    for item in sub:
        n += 1
        key.append(f'<div class="a"><span class="n">{n}.</span> {esc(item.get("model"))}<span class="r">{esc(item.get("note"))}</span></div>')
    key.append(_heading("Ⅲ. OX"))
    for item in ox:
        n += 1
        key.append(f'<div class="a"><span class="n">{n}. {"O" if item.get("answer") else "X"}</span> {esc(item.get("exp"))}</div>')
    key.append(_heading("Ⅳ. 단답형"))
    for item in short:
        n += 1
        alts = f'<span class="r">다른 답: {esc(", ".join(item["alts"]))}</span>' if item.get("alts") else ""
        key.append(f'<div class="a"><span class="n">{n}. {esc(item.get("answer"))}</span> {esc(item.get("exp"))}{alts}</div>')
    key.append("</div>")

    series = esc(" · ".join(entry.get("scope") or []))
    total = len(mc) + len(sub) + len(ox) + len(short)
    return f"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>{esc(title)} 시험대비문제</title>{FONT}<style>{QUIZ_CSS}</style></head><body>
<div class="head"><div><div class="u">{series} · 시험대비문제</div><h1>{esc(title)}</h1></div><div class="who">이름 ________ &nbsp; 날짜 ________<br>점수 ______ / {total}</div></div>
<div class="guide">객관식 {len(mc)} · 주관식 {len(sub)} · OX {len(ox)} · 단답형 {len(short)} (총 {total}문항). 점수는 연습용이며 실제 평가가 아닙니다. 답은 마지막 장에 있습니다.</div>
<div class="cols">{"".join(parts)}</div>
<div class="cols pb">{"".join(key)}</div>
</body></html>"""


def file_stem(entry: dict) -> str:
    """파일 이름에 못 쓰는 글자(/ \\ : * ? " < > | 와 제어 문자)를 _로 바꾼 '<단원>_<단원 제목>'."""
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", f'{entry["unit"]}_{entry["unit_title"]}').strip(" .")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("사용: python tools/study/build_pdf.py <study json> <출력 폴더> [항목 id…]", file=sys.stderr)
        return 2
    from academy.study import entry_problems, read_study  # 명령줄 실행이 경로를 더해 줍니다
    entries = read_study(argv[0])
    wanted = argv[2:]
    missing = [i for i in wanted if i not in {e.get("id") for e in entries if isinstance(e, dict)}]
    if missing:
        raise SystemExit(f"파일에 없는 항목 id입니다: {', '.join(missing)}")
    chosen = [e for e in entries if not wanted or e.get("id") in wanted]
    for entry in chosen:
        problems = entry_problems(entry)
        if problems:
            raise SystemExit(f"항목 {entry.get('id')!r}의 모양이 틀립니다: {'; '.join(problems[:3])}")
    out = Path(argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for entry in chosen:
        for prefix, make in (("요점정리", notes_html), ("시험대비문제", quiz_html)):
            path = out / f"{prefix}_{file_stem(entry)}.html"
            path.write_text(make(entry), encoding="utf-8")
            print(path)
    return 0


if __name__ == "__main__":
    # 직접 실행하면 이 폴더가 import 경로가 되므로, academy를 찾도록 저장소 맨 위 폴더를 더합니다(명령줄 실행에서만)
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    sys.exit(main(sys.argv[1:]))
