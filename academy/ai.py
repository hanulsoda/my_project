"""Claude API로 요점 정리·퀴즈를 만들고, 학생 질문에 답합니다."""

import base64
import json
import os
import re
from collections.abc import Sequence

MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
BOARD_TIME = re.compile(r"\d+(:\d{1,2}){1,2}")

GUIDE_PROMPT = """당신은 학원 강의를 학생용 학습 자료로 정리하는 선생님입니다.
강의 받아쓰기 대본이 주어집니다. 각 줄 앞의 [분:초]는 그 말이 나온 시점입니다.
받아쓰기라서 오타나 잘못 들린 단어가 있을 수 있으니, 문맥으로 바로잡아 이해하세요.

다음을 한국어로 만드세요.
- summary: 강의 전체를 3~5문장으로 요약.
- chapters: 주제가 바뀌는 지점마다 하나씩, 강의 흐름 순서대로. 강의 길이에 맞게 10분에 1~2개 정도.
  start는 그 설명이 시작되는 대본 줄의 시점을 "분:초" 형식 그대로 적습니다.
  points에는 학생이 복습할 때 꼭 알아야 할 핵심 내용을 2~5개, 각각 한 문장으로 적습니다.
  공식, 정의, 예제 풀이 순서처럼 시험에 나올 만한 내용을 우선합니다.
  board에는 그 챕터의 판서가 가장 잘 보이는 화면 사진의 시점을 "분:초"로 적습니다. 판서가 보이는 사진이 없으면 빈 문자열입니다.
- 대본 뒤에 "[분:초] 화면" 표시와 함께 강의 화면 사진이 붙어 있을 수 있습니다. 사진에 보이는 판서(칠판·태블릿에 쓴
  수식, 도표, 정리)를 읽어 요점에 반영하고, 수식은 x² + 2x + 1 처럼 텍스트로 옮겨 적으세요.
- quiz: 강의 내용만으로 풀 수 있는 4지선다 문제 5개. answer는 정답 보기의 번호(0부터 시작).
  explanation에는 왜 그 답인지 한두 문장으로, time에는 관련 설명이 나오는 시점("분:초")을 적습니다."""

GUIDE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "chapters": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "start": {"type": "string"},
                "title": {"type": "string"},
                "points": {"type": "array", "items": {"type": "string"}},
                "board": {"type": "string"},
            },
            "required": ["start", "title", "points", "board"],
            "additionalProperties": False,
        }},
        "quiz": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "question": {"type": "string"},
                "choices": {"type": "array", "items": {"type": "string"}},
                "answer": {"type": "integer"},
                "explanation": {"type": "string"},
                "time": {"type": "string"},
            },
            "required": ["question", "choices", "answer", "explanation", "time"],
            "additionalProperties": False,
        }},
    },
    "required": ["summary", "chapters", "quiz"],
    "additionalProperties": False,
}

TUTOR_PROMPT = """당신은 학원 강의를 들은 학생의 질문에 답하는 친절한 튜터입니다.
아래 강의 대본을 근거로 답하세요. 각 줄 앞의 [분:초]는 그 말이 나온 시점입니다.
- 근거가 되는 설명이 나온 시점을 [12:34]처럼 대괄호로 적어 주세요. 학생이 눌러서 그 장면으로 이동합니다.
- 강의에 없는 내용이면 그렇다고 먼저 밝힌 뒤, 짧게 일반적인 설명을 해 주세요.
- 학생 눈높이에 맞춰 쉽고 짧게 답하세요. 마크다운 기호(**, #, 표) 없이 평범한 문장으로 쓰세요.

<강의 제목>{title}</강의 제목>
<대본>
{transcript}
</대본>"""


def fmt_time(seconds: float) -> str:
    s = int(seconds)
    h, m, s = s // 3600, s % 3600 // 60, s % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def parse_time(text: str) -> float:
    try:
        seconds = 0
        for part in text.strip().split(":"):
            seconds = seconds * 60 + int(part)
        return seconds
    except ValueError:
        return 0


def transcript_text(segments: list[dict]) -> str:
    return "\n".join(f"[{fmt_time(s['start'])}] {s['text']}" for s in segments)


def _ask_claude(client, **request) -> str:
    response = client.beta.messages.create(
        model=MODEL,
        # 안전 필터가 드물게 요청을 거절하면 Anthropic이 권장하는 다른 모델로 자동 재시도합니다.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        **request,
    )
    if response.stop_reason in ("refusal", "max_tokens"):
        raise RuntimeError(f"Claude 응답이 완료되지 않았습니다 ({response.stop_reason})")
    return "".join(b.text for b in response.content if b.type == "text")


def _board_frame(text: str, frames: Sequence[tuple[int, bytes]]) -> int | None:
    """모델이 고른 "분:초"를 보낸 장면 중 가장 가까운 장면의 초로. 형식이 틀리면 사진 없음."""
    if not frames or not BOARD_TIME.fullmatch(text.strip()):
        return None
    t = parse_time(text)
    return min((seconds for seconds, _ in frames), key=lambda seconds: abs(seconds - t))


def make_study_guide(client, title: str, segments: list[dict],
                     frames: Sequence[tuple[int, bytes]] = ()) -> dict:
    content = [{"type": "text", "text": f"강의 제목: {title}\n\n<대본>\n{transcript_text(segments)}\n</대본>"}]
    for seconds, jpeg in frames:
        content += [{"type": "text", "text": f"[{fmt_time(seconds)}] 화면"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                 "data": base64.b64encode(jpeg).decode()}}]
    text = _ask_claude(
        client,
        max_tokens=16000,
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": GUIDE_SCHEMA}},
        system=GUIDE_PROMPT,
        messages=[{"role": "user", "content": content}],
    )
    guide = json.loads(text)
    for chapter in guide["chapters"]:
        chapter["start"] = parse_time(chapter["start"])
        chapter["board"] = _board_frame(chapter["board"], frames)
    guide["chapters"].sort(key=lambda c: c["start"])
    guide["quiz"] = [q for q in guide["quiz"] if 0 <= q["answer"] < len(q["choices"])]
    for q in guide["quiz"]:
        q["time"] = parse_time(q["time"])
    return guide


def answer_question(client, title: str, segments: list[dict], question: str,
                    history: list[dict], current_time: float | None) -> str:
    if current_time is not None:
        question = f"(지금 [{fmt_time(current_time)}] 장면을 보면서 질문합니다)\n{question}"
    return _ask_claude(
        client,
        max_tokens=8000,
        output_config={"effort": "medium"},
        # 같은 영상에 대한 질문이 이어지면 대본 부분은 캐시에서 싸게 읽힙니다.
        system=[{"type": "text",
                 "text": TUTOR_PROMPT.format(title=title, transcript=transcript_text(segments)),
                 "cache_control": {"type": "ephemeral"}}],
        messages=[*history, {"role": "user", "content": question}],
    )
