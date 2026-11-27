"""교사용 PDF에서 만든 요점노트·시험대비문제를 단원별 항목으로 읽고 점검합니다.

자료 파일(STUDY_FILE)은 단원마다
{"id", "unit", "unit_title", "works", "scope", "notes", "quiz"}를 담은 JSON 목록입니다.
"""

import json
import logging
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


def _index(answer, size) -> bool:
    return isinstance(answer, int) and not isinstance(answer, bool) and 0 <= answer < size  # True는 1이 아닙니다


def entry_problems(entry) -> list[str]:
    """항목의 모양이 틀린 곳을 한국어 한 줄씩 돌려줍니다. 문제가 없으면 빈 목록."""
    if not isinstance(entry, dict):
        return ["항목이 사전({...})이 아닙니다"]
    problems = [f"{key}가 비어 있거나 글이 아닙니다" for key in ("id", "unit", "unit_title") if not _text(entry.get(key))]
    if not _texts(entry.get("works")):
        problems.append("works가 글 목록이 아닙니다")
    scope = entry.get("scope")
    if not (_texts(scope) and scope):
        problems.append("scope가 비어 있거나 글 목록이 아닙니다")
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
