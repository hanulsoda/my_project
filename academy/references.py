"""학원이 이미 만든 작품별 요점 정리(이해완성·개념완성)를 영상과 짝지어 요점 정리의 근거로 씁니다.

자료 파일(REFERENCES_FILE)은 작품마다
{"title", "grade", "meta", "features", "stages", "stanzas", "persons", "fillins", "words"}를 담은 JSON 목록입니다.
"""

import json
import random
import re
from pathlib import Path

PARTS = [("features", "핵심 특징"), ("stages", "구조"), ("stanzas", "연별 정리"), ("persons", "인물"),
         ("fillins", "빈칸 문제"), ("words", "어휘")]


def load_references(path) -> list[dict]:
    return json.loads(Path(path).read_text(encoding="utf-8")) if path else []


def _work(title):
    return re.sub(r"^[\d\s\-.()]+", "", title).strip()  # "1-1.(2)성난 풀잎" → "성난 풀잎"


def _norm(text):
    return re.sub(r"[\W_]+", "", text)


def find_references(title, screen_lines, references) -> list[dict]:
    """영상 제목(폴더/파일 이름)과 화면 글자로 짝지어지는 정리를 {"source", "text"} 목록으로 돌려줍니다."""
    name = _norm(title.rsplit("/", 1)[-1])
    quoted = {_norm(q) for line in screen_lines for q in re.findall(r"[「『](.+?)[」』]", line)}
    found = {}  # 작품 → (파일 이름으로 찾았는지, 정리, 학년 점수)
    for ref in references:
        if not ref.get("meta") and not any(ref.get(key) for key, _ in PARTS):
            continue  # PDF 추출에 실패해 제목만 남은 정리는 근거가 못 됩니다.
        work = _norm(_work(ref["title"]))
        # 두 글자 제목(눈, 벽)은 다른 말과 겹치기 쉬워 파일 이름으로는 짝짓지 않고 화면의 「」만 봅니다.
        named = len(work) >= 3 and work in name
        if work and (named or work in quoted):
            score = _grade_score(ref["grade"], title)
            if work not in found or score > found[work][2]:
                found[work] = (named, ref, score)
    # 「비교하며 읽기」처럼 함께 찾은 더 긴 작품명의 일부일 뿐인 것은 뺍니다.
    hits = [hit for work, hit in found.items() if not any(work != other and work in other for other in found)]
    if any(hit[0] for hit in hits):  # 파일 이름으로 찾았으면 화면에 인용만 된 다른 작품은 뺍니다.
        hits = [hit for hit in hits if hit[0]]
    return [{"source": f"{ref['grade']} 「{_work(ref['title'])}」", "text": reference_text(ref),
             "sections": reference_sections(ref), "quiz": reference_quiz(ref)} for _, ref, _ in hits]


def _grade_score(grade, title):
    """같은 작품이 여러 학년에 있을 때: 폴더의 학년(고1)과 같으면 2, 학교급(중등부·고1 등의 중/고)만 같으면 1."""
    exact = re.search(r"[중고][1-3]", title)
    level = exact.group(0)[0] if exact else "중" if "중등" in title else "고" if "고등" in title else None
    return 2 if exact and grade == exact.group(0) else 1 if level and grade.startswith(level) else 0


def reference_sections(ref) -> list[dict]:
    """정리를 [{"name": "개요"·"핵심 특징"…, "items": [...]}]로 나눕니다(학생 화면에 그대로 보여 줄 때)."""
    ref = _tidy(ref)
    sections = [("개요", [f"{k}: {v}" for k, v in ref["meta"].items()])] if ref.get("meta") else []
    sections += [(name, [_item(key, item) for item in ref[key]]) for key, name in PARTS if ref.get(key)]
    # 내용 없는 항목('전개:')과 같은 칸 안의 중복은 뺍니다.
    sections = [(name, list(dict.fromkeys(i for i in items if i.strip() and not i.strip().endswith(":"))))
                for name, items in sections]
    return [{"name": name, "items": items} for name, items in sections if items]


def reference_quiz(ref) -> list[dict]:
    """빈칸 문제는 {"context", "parts": [글, 빈칸, 글, …]}, 어휘는 뜻을 고르는 4지선다로 만듭니다."""
    ref = _tidy(ref)
    quiz = []
    seen = set()
    for fill in ref.get("fillins") or []:
        asked = (fill.get("passage", ""), fill.get("answer_line"))
        if fill.get("answer_line") and asked not in seen:  # PDF에서 뽑다가 같은 문제가 두 번 들어간 것은 한 번만
            seen.add(asked)
            # 교재에서 빈칸에 들어갈 말은 앞뒤를 두 칸 이상 띄워 둡니다.
            parts = [p.strip() for p in re.split(r" {2,}(\S(?:.*?\S)?) {2,}", fill["answer_line"])]
            quiz.append({"context": fill.get("passage", ""), "parts": parts if len(parts) > 1 else ["", parts[0], ""]})
    words = {w["def"]: w for w in ref.get("words") or [] if w.get("w") and w.get("def")}  # 오답 보기가 겹치지 않게 뜻별로 하나
    if len(words) >= 4:
        for meaning, word in words.items():
            rng = random.Random(word["w"] + meaning)  # 강의를 열 때마다 같은 보기·순서
            choices = rng.sample([m for m in words if m != meaning], 3) + [meaning]
            rng.shuffle(choices)
            quiz.append({"question": f"‘{word['w']}’의 뜻으로 알맞은 것은?", "choices": choices,
                         "answer": choices.index(meaning), "explanation": _item("words", word)})
    return quiz


def _tidy(value):
    """교재 PDF에서 뽑을 때 남은 흔적을 정리합니다. 빈칸 표시인 두 칸 띄어쓰기는 그대로 둡니다."""
    if isinstance(value, list):
        return [_tidy(v) for v in value]
    if isinstance(value, dict):
        return {k: _tidy(v) for k, v in value.items()}
    if not isinstance(value, str):
        return value
    value = value.split("\n\n")[0]  # 빈 줄 뒤는 쪽 머리글(단원 번호·UCI 코드·다음 단원 제목)
    value = re.sub(r"[\x00-\x08\x0b-\x1f\x7f-�]", "", value)  # 깨진 기호 글꼴·제어 문자
    value = re.sub(r"(?<=[가-힣])\n(?=[가-힣])", "", value)  # 낱말 중간에서 끊긴 줄
    return re.sub(r" *\n *", " ", value).strip()


def reference_text(ref) -> str:
    lines = [f"「{_work(ref['title'])}」({ref['grade']})"]
    for section in reference_sections(ref):
        lines += [f"{section['name']}:"] + ["- " + item for item in section["items"]]
    return "\n".join(lines)


def _item(key, item):
    if key == "features":
        return item.get("text", "")
    if key == "stages":
        return f"{item.get('label', '')}: " + " / ".join(item.get("bullets", []))
    if key == "fillins":
        return f"{item.get('passage', '')} → {item.get('answer_line', '')}"
    if key == "words":
        return f"{item.get('w', '')}({item.get('pos', '')}): {item.get('def', '')}"
    # 연별 정리·인물 등은 형태가 제각각이라 값만 이어 붙입니다.
    return " / ".join(", ".join(map(str, v)) if isinstance(v, list) else str(v) for v in item.values() if v)
