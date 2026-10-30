"""학원이 이미 만든 작품별 요점 정리(이해완성·개념완성)를 영상과 짝지어 요점 정리의 근거로 씁니다.

자료 파일(REFERENCES_FILE)은 작품마다
{"title", "grade", "meta", "features", "stages", "stanzas", "persons", "fillins", "words"}를 담은 JSON 목록입니다.
"""

import hashlib
import json
import logging
import random
import re
import unicodedata
from pathlib import Path

PARTS = [("features", "핵심 특징"), ("stages", "구조"), ("stanzas", "연별 정리"), ("persons", "인물"),
         ("fillins", "빈칸 문제"), ("words", "어휘")]


def load_references(path) -> list[dict]:
    return usable_references(json.loads(Path(path).read_text(encoding="utf-8"))) if path else []


def usable_references(refs) -> list[dict]:
    """정리 파일에 모양이 다른 정리(손으로 고친 JSON 등)가 섞여도 목록·검색·현황이 멈추지 않게, 쓸 수 없는 정리는 빼고 로그에 남깁니다.
    같은 학년·제목의 정리가 또 있으면 처음 것만 씁니다(선생님이 고친 내용을 학년+제목 열쇠로 기억하므로)."""
    usable, keys = [], set()
    for n, ref in enumerate(refs, 1):
        try:
            if not (isinstance(ref, dict) and isinstance(ref.get("title"), str) and isinstance(ref.get("grade"), str)):
                raise ValueError("제목·학년이 없음")
            reference_text(ref), reference_quiz(ref), suspects(ref)  # 학생·선생님 화면에 쓰는 것을 미리 만들어 봅니다
        except Exception as error:  # noqa: BLE001 — 어떤 모양이든 그 정리만 뺍니다
            logging.warning("학원 정리 %d번째를 건너뜀(모양이 다름): %r", n, error)
            continue
        if not ref.get("meta") and not any(ref.get(key) for key, _ in PARTS):
            continue  # PDF 추출에 실패해 제목만 남은 정리: 같은 학년·제목의 진짜 정리를 밀어내지 않게 먼저 뺍니다
        if ref_key(ref) in keys:
            logging.warning("학원 정리 %d번째를 건너뜀(같은 학년·제목이 이미 있음): %s %s", n, ref["grade"], ref["title"])
            continue
        keys.add(ref_key(ref))
        usable.append(ref)
    return usable


def _work(title):
    return re.sub(r"^[\d\s\-.()]+", "", title).strip()  # "1-1.(2)성난 풀잎" → "성난 풀잎"


def _norm(text):
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFC", text))  # 맥에서 옮긴 이름은 한글이 자모로 나뉘어 있기도 함


def find_references(title, screen_lines, references) -> list[dict]:
    """영상 제목(폴더/파일 이름)과 화면 글자로 짝지어지는 정리를 {"source", "text"} 목록으로 돌려줍니다."""
    return matcher(references)(title, screen_lines)


def matcher(references):
    """find_references(제목, 화면 글자 줄)를 만들어 돌려줍니다. 여러 강의를 짝지을 때(서버의 강의 목록 3,900개)는 이것을 한 번
    만들어 쓰면 정리마다 작품명과 보여 줄 내용을 한 번씩만 만듭니다(강의마다 다시 만들면 서버를 켠 뒤 첫 목록이 10초 넘게 걸림).
    돌려주는 정리 묶음은 여러 강의가 함께 쓰므로 고치지 말고 읽기만 합니다."""
    # PDF 추출에 실패해 제목만 남은 정리는 근거가 못 됩니다.
    works = [(_norm(_work(ref["title"])), ref) for ref in references
             if ref.get("meta") or any(ref.get(key) for key, _ in PARTS)]
    made = {}  # id(정리) → 보여 줄 내용

    def summary(ref):
        if id(ref) not in made:
            made[id(ref)] = {"source": f"{ref['grade']} 「{_work(ref['title'])}」", "key": ref_key(ref), "text": reference_text(ref),
                             "sections": reference_sections(ref), "quiz": reference_quiz(ref)}
        return made[id(ref)]

    def find(title, screen_lines=()):
        title = unicodedata.normalize("NFC", title)
        name = _norm(title.rsplit("/", 1)[-1])
        quoted = {_norm(q) for line in screen_lines for q in re.findall(r"[「『](.+?)[」』]", line)}
        found = {}  # 작품 → (파일 이름으로 찾았는지, 정리, 학년 점수)
        for work, ref in works:
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
        return [summary(ref) for _, ref, _ in hits]

    return find


def ref_key(ref) -> str:
    """정리마다 바뀌지 않는 짧은 열쇠(학년+제목). 선생님이 고친 내용을 이 열쇠로 기억합니다."""
    return hashlib.sha1(f"{ref['grade']}|{ref['title']}".encode()).hexdigest()[:10]


def suspects(ref) -> dict:
    """학생에게 보이는 항목 가운데 선생님이 확인할 만한 것 {칸 이름: {항목: 까닭}}.
    깨진 기호·쪽 머리글 꼬리·같은 칸 중복·빈 단계는 보여 줄 때 이미 자동으로 정리하므로, 그 뒤에도 남는 것만 봅니다."""
    found = {}
    for section in reference_sections(ref):
        if section["name"] == "빈칸 문제":  # 빈칸 문제 지문은 보통 길어 따로 보지 않습니다
            continue
        for item in section["items"]:
            if len(item) > 250:
                found.setdefault(section["name"], {})[item] = f"너무 긴 항목({len(item)}자)"
    # PDF에서 뽑다가 다른 단계의 내용이 한 단계로 몰린 것: 단계가 셋 이상인데 빈 단계가 있고 한 단계가 70% 이상
    stages = [s for s in _tidy(ref).get("stages") or [] if isinstance(s, dict)]
    counts = [len(s.get("bullets") or []) for s in stages]
    empty = [s.get("label", "") for s in stages if not s.get("bullets")]
    if len(stages) >= 3 and empty and sum(counts) >= 3 and max(counts) >= 0.7 * sum(counts):
        crowded = _item("stages", stages[counts.index(max(counts))])
        found.setdefault("구조", {})[crowded] = f"한 단계에 내용이 몰림(빈 단계: {', '.join(empty)})"
    return found


def _grade_score(grade, title):
    """같은 작품이 여러 학년에 있을 때: 폴더의 학년(고1·고등1)과 같으면 2, 학교급(중등부·고1 등의 중/고)만 같으면 1.
    낱말 안의 글자('집중1강'의 중1)는 학년으로 보지 않습니다."""
    exact = re.search(r"(?<![가-힣])([중고])등?\s?([1-3])(?!\d)", title)
    level = exact.group(1) if exact else "중" if "중등" in title else "고" if "고등" in title else None
    return 2 if exact and grade == exact.group(1) + exact.group(2) else 1 if level and grade.startswith(level) else 0


def reference_sections(ref) -> list[dict]:
    """정리를 [{"name": "개요"·"핵심 특징"…, "items": [...]}]로 나눕니다(학생 화면에 그대로 보여 줄 때)."""
    ref = _tidy(ref)
    # 항목 글은 바꾸지 않습니다: 선생님이 고치거나 숨긴 내용을 이 글로 기억합니다(.reference-fixes).
    sections = [("개요", [f"{k}: {v}" for k, v in ref["meta"].items()])] if ref.get("meta") else []
    sections += [(name, [_item(key, item) for item in ref[key]]) for key, name in PARTS if ref.get(key)]
    # 내용 없는 항목('전개:')과 같은 칸 안의 중복은 뺍니다.
    sections = [(name, list(dict.fromkeys(i for i in items if i.strip() and not i.strip().endswith(":"))))
                for name, items in sections]
    return [{"name": name, "items": items} for name, items in sections if items]


def _same(text):
    """띄어쓰기·끝 마침표만 다른 글은 같은 글로 봅니다(PDF에서 두 번 뽑힌 뜻)."""
    return re.sub(r"\s+", " ", text).strip().rstrip(".")


def reference_quiz(ref) -> list[dict]:
    """빈칸 문제는 {"context", "parts": [글, 빈칸, 글, …]}, 어휘는 뜻을 고르는 4지선다로 만듭니다."""
    raw_fills = ref.get("fillins") or []
    ref = _tidy(ref)
    quiz = []
    seen = set()
    for raw, fill in zip(raw_fills, ref.get("fillins") or []):
        asked = (fill.get("passage", ""), fill.get("answer_line"))
        if fill.get("answer_line") and asked not in seen:  # PDF에서 뽑다가 같은 문제가 두 번 들어간 것은 한 번만
            seen.add(asked)
            # 교재에서 빈칸에 들어갈 말은 앞뒤를 두 칸 이상 띄워 둡니다. 줄 맨 앞·끝의 빈칸은 다듬을 때 띄어쓰기가
            # 지워지므로 원래 글에 있던 두 칸을 되살립니다.
            edge = raw["answer_line"]
            line = ("  " if re.match(r" {2,}\S", edge) else "") + fill["answer_line"] + ("  " if re.search(r"\S {2,}$", edge) else "")
            parts = [p.strip() for p in re.split(r" {2,}(\S(?:.*?\S)?) {2,}", line)]
            # item: '빈칸 문제' 칸의 항목 글(선생님이 학원 정리 고치기에서 숨기면 퀴즈에서도 뺍니다)
            quiz.append({"context": fill.get("passage", ""), "parts": parts if len(parts) > 1 else ["", parts[0], ""],
                         "item": _item("fillins", fill)})
    # 어휘: 낱말마다 한 번(뜻이 둘이면 처음 뜻), 오답 보기는 다른 낱말의 뜻 가운데 정답·같은 낱말의 다른 뜻과 겹치지 않는 것
    words = [w for w in ref.get("words") or [] if w.get("w") and w.get("def")]
    first = {}
    for w in words:
        first.setdefault(w["w"], w)
    for name, word in first.items():
        senses = {_same(w["def"]) for w in words if w["w"] == name}
        others = list({_same(w["def"]): w["def"] for w in words if _same(w["def"]) not in senses}.values())
        if len(others) < 3:
            continue
        meaning = word["def"]
        rng = random.Random(name + meaning)  # 강의를 열 때마다 같은 보기·순서
        choices = rng.sample(others, 3) + [meaning]
        rng.shuffle(choices)
        quiz.append({"question": f"‘{name}’의 뜻으로 알맞은 것은?", "choices": choices,
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
    if not isinstance(item, dict):  # 정리에 따라 항목이 글 한 줄이기도 합니다("김첨지: 인력거꾼")
        return ", ".join(map(str, item)) if isinstance(item, list) else str(item)
    if key == "features":
        return item.get("text", "")
    if key == "stages":
        return f"{item.get('label', '')}: " + " / ".join(map(str, item.get("bullets") or []))
    if key == "fillins":
        return f"{item.get('passage', '')} → {item.get('answer_line', '')}"
    if key == "words":
        return f"{item.get('w', '')}({item.get('pos', '')}): {item.get('def', '')}"
    # 연별 정리·인물 등은 형태가 제각각이라 값만 이어 붙입니다.
    return " / ".join(", ".join(map(str, v)) if isinstance(v, list) else str(v) for v in item.values() if v)
