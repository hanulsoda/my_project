"""요점 정리가 없는 강의에 로컬 AI(ollama)로 '자동 목차'(챕터 제목·시작 시간)를 붙입니다. Claude 비용이 들지 않습니다.

실행: python -m academy.toc [--until 07:00]
시험해 보니 로컬 모델은 핵심 내용·퀴즈에서 틀린 설명을 지어내서 목차만 만들고,
40분 넘는 강의는 통째로 물으면 챕터 자리가 크게 틀려 20분씩 나눠 묻고 이어 붙입니다.
"""

import argparse
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

from academy.library import find_videos, load_analysis, save_analysis

MODEL = os.environ.get("TOC_MODEL", "exaone3.5:7.8b")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
WHOLE_SECONDS = 40 * 60  # 이보다 긴 강의는
PART_SECONDS = 20 * 60  # 이만큼씩 나눠 묻습니다(5분이 안 되는 끝자락은 앞 조각에 붙임)
MIN_GAP = 60  # 이보다 가까운 챕터는 앞 챕터에 합칩니다
PART_GAP = 120  # 나눠 물은 긴 강의는 챕터가 Claude의 두 배로 잘게 나뉘어 2분(시험에서 Claude 챕터 일치 98%→93%, 개수 19→15)
SCHEMA = {"type": "object", "properties": {"chapters": {"type": "array", "items": {
    "type": "object", "properties": {"start": {"type": "string"}, "title": {"type": "string"}},
    "required": ["start", "title"]}}}, "required": ["chapters"]}
PROMPT = """다음은 학원 국어 강의를 자동으로 받아 적은 대본입니다. 받아쓰기 오류가 있을 수 있습니다. 각 줄 앞 [분:초]는 그 말을 한 시간입니다.
학생이 원하는 설명으로 바로 이동할 수 있도록 강의 목차를 JSON으로 만드세요.
- chapters: 강의 흐름에 따라 다루는 주제가 바뀌는 곳마다 하나씩, 5분~10분에 하나 정도.
- start: 그 주제를 시작한 줄의 [분:초]. title: 그 구간에서 다루는 내용을 짧게(15자 안팎).
대본에 없는 내용은 지어내지 마세요."""


def _mmss(t):
    return f"{int(t) // 60:02d}:{int(t) % 60:02d}"


def _seconds(text):
    nums = re.findall(r"\d+", str(text))
    return int(nums[-2]) * 60 + int(nums[-1]) if len(nums) >= 2 else None


def make_toc(segments, duration, ask) -> list[dict] | None:
    """ask(prompt, schema)는 모델의 답(JSON 글)을 돌려줍니다. 쓸 만한 챕터가 2개 미만이면 None."""
    if duration <= WHOLE_SECONDS:
        parts = [(0.0, duration, segments)]
    else:
        starts = range(0, int(duration) - 300, PART_SECONDS)
        ends = [*starts[1:], duration]
        parts = [(b, e, [s for s in segments if b <= s["start"] < e]) for b, e in zip(starts, ends)]
    gap = MIN_GAP if len(parts) == 1 else PART_GAP
    kept = []
    for begin, end, said in parts:
        for c in _ask(said, ask) if said else []:
            # 조각 밖·앞으로 돌아간·바로 앞 챕터와 너무 가까운 시간은 모델이 잘못 짚은 것으로 봅니다.
            if begin <= c["start"] <= end and not (kept and c["start"] < kept[-1]["start"] + gap):
                kept.append(c)
    return kept if len(kept) >= 2 else None


def _ask(segments, ask):
    lines, start = [], None
    for s in segments:  # 15초쯤씩 묶어 모델이 읽을 줄 수를 줄입니다
        if start is None or s["start"] - start >= 15:
            start = s["start"]
            lines.append(f"[{_mmss(start)}] {s['text']}")
        else:
            lines[-1] += f" {s['text']}"
    try:
        chapters = json.loads(ask(f"{PROMPT}\n\n<대본>\n" + "\n".join(lines) + "\n</대본>", SCHEMA))["chapters"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return []
    found = []
    for c in chapters:
        t, title = _seconds(c.get("start")), str(c.get("title", "")).strip()
        if t is not None and title:
            found.append({"start": float(t), "title": title})
    return found


def ollama_ask(prompt, schema):
    # 같은 모델을 다른 서비스도 쓰고 있어, 떠 있는 설정(문맥 32768, 계속 유지)과 똑같이 요청해야 모델이 다시 올라가지 않습니다.
    body = {"model": MODEL, "stream": False, "keep_alive": -1, "format": schema,
            "options": {"num_ctx": 32768, "temperature": 0.2},
            "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(f"{OLLAMA_URL}/api/chat", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=1800) as res:
        return json.load(res)["message"]["content"]


def add_tocs(video_dir, data_dir, ask, has_summary, until=None, now=datetime.now) -> tuple[int, bool]:
    """Claude 요점 정리가 없는 강의에 목차를 붙입니다. (실패 수, 끝까지 했는지)를 돌려줍니다.

    학원 정리에는 챕터가 없어 학원 정리가 있는 강의도 만들되, 아무것도 없는 강의를 먼저 합니다.

    until("07:00")을 주면 처음 부른 때 다음에 오는 그 시각부터는 새 강의를 시작하지 않습니다.
    """
    deadline = None
    if until:
        began = now()
        hour, minute = map(int, until.split(":"))
        deadline = began.replace(hour=hour, minute=minute, second=0, microsecond=0)
        deadline += timedelta(days=1) if deadline <= began else timedelta()
    failures = 0
    for video in sorted(find_videos(video_dir), key=lambda v: has_summary(v["title"])):  # False(정리 없음) 먼저
        data = load_analysis(data_dir, video["id"])
        if not data or not data.get("segments") or data.get("guide") or "toc" in data:
            continue
        if deadline and now() >= deadline:
            print(f"{until}이 지나 멈춥니다. 다음에 실행하면 이어서 합니다.", flush=True)
            return failures, False
        print(f"목차: {video['title']}", flush=True)
        try:
            chapters = make_toc(data["segments"], data["duration"], ask)
        except Exception as e:  # ollama가 꺼져 있거나 응답이 늦을 때. 다음에 다시 시도합니다.
            failures += 1
            print(f"  실패: {e}", flush=True)
            continue
        # 쓸 수 없는 답이었어도 빈 목차로 남겨 매일 밤 다시 묻지 않습니다.
        data["toc"] = {"model": MODEL, "chapters": chapters or []}
        save_analysis(data_dir, video["id"], data)
    return failures, True


def main():
    from academy.references import find_references, load_references

    parser = argparse.ArgumentParser(description="요점 정리 없는 강의에 로컬 AI 자동 목차 붙이기")
    parser.add_argument("--until", metavar="HH:MM", help="이 시각이 지나면 새 강의를 시작하지 않음 (예: 07:00)")
    args = parser.parse_args()
    references = load_references(os.environ.get("REFERENCES_FILE"))
    failures, finished = add_tocs(Path(os.environ.get("VIDEO_DIR", "videos")), Path(os.environ.get("DATA_DIR", "data")),
                                  ollama_ask, lambda title: bool(find_references(title, [], references)), args.until)
    if failures:
        print(f"{failures}개 강의 실패. 다시 실행하면 이어서 합니다.", file=sys.stderr)
    sys.exit(1 if failures else 0 if finished else 75)  # 75: 시각이 되어 멈춤(다음 밤에 이어서)


if __name__ == "__main__":
    main()
