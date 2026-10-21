"""학원이 이미 만든 작품별 요점 정리(이해완성·개념완성)를 영상과 짝지어 요점 정리의 근거로 씁니다.

자료 파일(REFERENCES_FILE)은 작품마다
{"title", "grade", "meta", "features", "stages", "stanzas", "persons", "fillins", "words"}를 담은 JSON 목록입니다.
"""

import json
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
    return [{"source": f"{ref['grade']} 「{_work(ref['title'])}」", "text": reference_text(ref)} for _, ref, _ in hits]


def _grade_score(grade, title):
    """같은 작품이 여러 학년에 있을 때: 폴더의 학년(고1)과 같으면 2, 학교급(중등부·고1 등의 중/고)만 같으면 1."""
    exact = re.search(r"[중고][1-3]", title)
    level = exact.group(0)[0] if exact else "중" if "중등" in title else "고" if "고등" in title else None
    return 2 if exact and grade == exact.group(0) else 1 if level and grade.startswith(level) else 0


def reference_text(ref) -> str:
    lines = [f"「{_work(ref['title'])}」({ref['grade']})"]
    if ref.get("meta"):
        lines.append("개요: " + " / ".join(f"{k}: {v}" for k, v in ref["meta"].items()))
    for key, name in PARTS:
        if ref.get(key):
            lines.append(f"{name}:")
            lines += ["- " + _item(key, item) for item in ref[key]]
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
