"""교사용 PDF에서 만든 요점노트·시험대비문제를 단원별 항목으로 읽고 점검합니다.

자료 파일(STUDY_FILE)은 단원마다
{"id", "unit", "unit_title", "works", "scope", "notes", "quiz"}를 담은 JSON 목록입니다.
"""

import json
import logging
import re
import unicodedata
from pathlib import Path

# 시험대비문제 종류별 문항 수(항상 같습니다)
QUIZ_COUNTS = [("mc", "객관식", 10), ("sub", "주관식", 5), ("ox", "OX", 10), ("short", "단답형", 10)]
CHOICES = 5


def read_study(path) -> list:
    """요점노트·시험대비 파일을 읽기만 합니다(~: 집 폴더, 메모장의 BOM은 뺌). 쓸 수 있는 항목만 고르는 것은 usable_study.
    없거나 깨졌으면 한 줄 안내로 멈춥니다(서버·확인 도구가 함께 씀)."""
    if not path:
        return []
    try:
        entries = json.loads(Path(path).expanduser().read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as e:  # ValueError: JSON 형식 오류·글자 깨짐
        raise SystemExit(f"요점노트·시험대비 파일을 읽지 못했습니다: {path} ({e}). STUDY_FILE 경로와 파일 형식을 확인하세요"
                         "(python -m academy.check)") from None
    if not isinstance(entries, list):
        raise SystemExit(f"요점노트·시험대비 파일이 항목 목록([...])이 아닙니다: {path} (STUDY_FILE 확인)")
    return entries


def _text(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _texts(value) -> bool:
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


def _words(value) -> bool:
    """글 목록이면서 빈 글·공백뿐인 글이 없어야 합니다(빈 scope 낱말은 모든 폴더에 들어맞아 버립니다)."""
    return isinstance(value, list) and all(_text(v) for v in value)


def _index(answer, size) -> bool:
    return isinstance(answer, int) and not isinstance(answer, bool) and 0 <= answer < size  # True는 1이 아닙니다


def entry_problems(entry) -> list[str]:
    """항목의 모양이 틀린 곳을 한국어 한 줄씩 돌려줍니다. 문제가 없으면 빈 목록."""
    if not isinstance(entry, dict):
        return ["항목이 사전({...})이 아닙니다"]
    problems = [f"{key}가 비어 있거나 글이 아닙니다" for key in ("id", "unit", "unit_title") if not _text(entry.get(key))]
    if not _words(entry.get("works")):
        problems.append("works가 글 목록이 아니거나 빈 글이 있습니다")
    scope = entry.get("scope")
    if not (_words(scope) and scope):
        problems.append("scope가 비어 있거나 글 목록이 아니거나 빈 글이 있습니다")
    notes = entry.get("notes")
    if not (isinstance(notes, dict) and isinstance(notes.get("blocks"), list)):
        problems.append("notes.blocks가 목록이 아닙니다")
    quiz = entry.get("quiz")
    if not isinstance(quiz, dict):
        return problems + ["quiz가 사전({...})이 아닙니다"]
    if not (isinstance(quiz.get("passages"), list) and quiz["passages"]):
        problems.append("quiz.passages가 비어 있거나 목록이 아닙니다")
    for key, name, count in QUIZ_COUNTS:
        items = quiz.get(key)
        if not isinstance(items, list) or len(items) != count:
            problems.append(f"{name} 문항이 {count}개여야 합니다(지금 {len(items) if isinstance(items, list) else '목록 아님'})")
            continue
        for n, item in enumerate(items, 1):
            problems += _item_problems(key, name, n, item)
    return problems


def _item_problems(key, name, n, item) -> list[str]:
    if not isinstance(item, dict):
        return [f"{name} {n}번이 사전({{...}})이 아닙니다"]
    if key == "mc":
        choices = item.get("choices")
        found = []
        if not (isinstance(choices, list) and len(choices) == CHOICES):
            found.append(f"{name} {n}번 보기가 {CHOICES}개가 아닙니다")
        if not _index(item.get("answer"), CHOICES):
            found.append(f"{name} {n}번 정답이 0~{CHOICES - 1} 사이의 숫자가 아닙니다")
        return found
    if key == "ox" and not isinstance(item.get("answer"), bool):
        return [f"{name} {n}번 정답이 true/false가 아닙니다"]
    if key == "short" and not _text(item.get("answer")):
        return [f"{name} {n}번 정답이 비어 있거나 글이 아닙니다"]
    return []


def usable_study(entries) -> list[dict]:
    """항목 가운데 모양이 틀린 것과, 그 항목(또는 앞의 올바른 항목)과 id가 겹치는 뒤쪽 항목은 빼고 로그에 남깁니다.
    틀린 항목의 id도 쓴 것으로 보므로, 깨진 항목 대신 같은 id의 뒤쪽 항목이 조용히 끼어들지 않습니다."""
    usable, ids = [], set()
    for n, entry in enumerate(entries, 1):
        entry_id = entry.get("id") if isinstance(entry, dict) and isinstance(entry.get("id"), str) else None
        problems = entry_problems(entry)
        if problems:
            logging.warning("요점노트·시험대비 %d번째 항목을 건너뜀(모양이 다름): %s", n, "; ".join(problems[:3]))
        elif entry_id in ids:
            logging.warning("요점노트·시험대비 %d번째 항목을 건너뜀(같은 id가 이미 있음): %s", n, entry_id)
        else:
            usable.append(entry)
        if entry_id is not None:
            ids.add(entry_id)
    return usable


def norm(text: str) -> str:
    """한글을 NFC로 합치고 띄어쓰기·기호를 지웁니다(맥에서 옮긴 자모 분리 이름도 같아집니다)."""
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFC", text))


def read_links(path) -> dict:
    """직접 연결 파일을 읽습니다: {영상 제목(폴더 포함): 항목 id 또는 null}. 경로가 없으면 {}.
    읽지 못하면 read_study처럼 한 줄 안내로 멈춥니다. 제목은 NFC로 합칩니다."""
    if not path:
        return {}
    try:
        links = json.loads(Path(path).expanduser().read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as e:
        raise SystemExit(f"영상 직접 연결 파일을 읽지 못했습니다: {path} ({e}). STUDY_LINKS_FILE 경로와 파일 형식을 확인하세요"
                         "(python -m academy.check)") from None
    if not isinstance(links, dict):
        raise SystemExit(f"영상 직접 연결 파일이 사전({{...}})이 아닙니다: {path} (STUDY_LINKS_FILE 확인)")
    return {unicodedata.normalize("NFC", str(title)): entry_id for title, entry_id in links.items()}


def _matches(entry, folder, name) -> tuple[bool, bool]:
    """(항목이 이 영상에 맞는지, 단원 번호 말고 제목·작품 이름으로도 맞는지)."""
    scope = [norm(word) for word in entry.get("scope") or []]
    if not scope or not folder or any(not word or word not in folder for word in scope):
        return False, False  # scope가 비었거나 빈 낱말이 있으면 연결하지 않음
    flat = norm(name)
    parts = [p for p in re.split(r"-", unicodedata.normalize("NFC", str(entry.get("unit", "")))) if p.strip()]
    by_number = bool(parts) and re.match(r"\s*" + r"\s*[-–]\s*".join(re.escape(p.strip()) for p in parts) + r"(?!\d)",
                                         unicodedata.normalize("NFC", name)) is not None
    title = norm(str(entry.get("unit_title", "")))
    by_name = len(title) >= 4 and title in flat
    for work in entry.get("works") or []:
        work = norm(work)
        by_name = by_name or (len(work) >= 3 and work in flat)
    return by_number or by_name, by_name


def link_video(entries: list, title: str, links: dict | None = None) -> dict:
    """영상 제목(폴더를 /로 이은 것)에 맞는 요점노트·시험대비 항목을 고릅니다.
    status: direct(직접 연결 파일), matched(이름으로도 맞음), number_only(단원 번호만 맞음),
    ambiguous(서로 다른 항목 둘 이상이 맞아 연결하지 않음), none."""
    title = unicodedata.normalize("NFC", title)
    if links:
        direct = {unicodedata.normalize("NFC", k): v for k, v in links.items()}
        if title in direct:
            found = [e for e in entries if direct[title] is not None and e.get("id") == direct[title]][:1]
            return {"status": "direct" if found else "none", "entries": found}
    folder, _, name = title.rpartition("/")
    folder = norm(folder)
    found, named = [], False
    for entry in entries:
        ok, by_name = _matches(entry, folder, name)
        if ok:
            found.append(entry)
            named = named or by_name
    if len({e.get("id") for e in found}) > 1:
        return {"status": "ambiguous", "entries": []}
    if not found:
        return {"status": "none", "entries": []}
    return {"status": "matched" if named else "number_only", "entries": found[:1]}
