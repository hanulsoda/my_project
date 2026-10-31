"""Claude API로 요점 정리·퀴즈를 만들고, 학생 질문에 답합니다."""

import json
import os

MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")

GUIDE_PROMPT = """당신은 학원 강의를 학생용 학습 자료로 정리하는 선생님입니다.
강의 받아쓰기 대본이 주어집니다. 각 줄 앞의 [분:초]는 그 말이 나온 시점입니다.
받아쓰기라서 오타나 잘못 들린 단어가 있을 수 있으니, 문맥으로 바로잡아 이해하세요.

다음을 한국어로 만드세요.
- summary: 강의 전체를 3~5문장으로 요약.
- chapters: 주제가 바뀌는 지점마다 하나씩, 강의 흐름 순서대로. 강의 길이에 맞게 10분에 1~2개 정도.
  start는 그 설명이 시작되는 대본 줄의 시점을 "분:초" 형식 그대로 적습니다.
  points에는 학생이 복습할 때 꼭 알아야 할 핵심 내용을 2~5개, 각각 한 문장으로 적습니다.
  공식, 정의, 예제 풀이 순서처럼 시험에 나올 만한 내용을 우선합니다.
- quiz: 강의 내용만으로 풀 수 있는 4지선다 문제 5개. answer는 정답 보기의 번호(0부터 시작).
  explanation에는 왜 그 답인지 한두 문장으로, time에는 관련 설명이 나오는 시점("분:초")을 적습니다.
- corrections: 대본에서 잘못 들린 용어를 바로잡는 목록. wrong에는 대본에 나온 표기 그대로, right에는 올바른 표기를 적습니다.
  강의 주제상 확실히 틀린 용어만 적고(예: '격률'을 '경률'로 받아쓴 경우), 두 글자 이상이어야 합니다.
  대본 전체에서 그대로 바꾸므로, 맞게 쓰인 다른 말까지 바뀔 수 있는 표기는 넣지 마세요. 없으면 빈 목록입니다.
- page_labels: 화면 글자가 주어질 때만 채우고, 없으면 빈 목록입니다.
- overview, glossary, edits: 학원 요점 정리가 주어질 때만 채우고, 없으면 빈 목록입니다."""

SCREEN_NOTE = """

화면 글자도 함께 주어집니다. 선생님이 수업 중 띄운 교재·판서를 글자 인식(OCR)으로 읽은 것이고, [분:초]는 그 화면이 처음 나온 시점입니다.
- 용어·작품명·작가명의 표기는 대본보다 화면 글자를 우선해 바로잡으세요.
- 말로는 하지 않고 화면에만 있는 핵심 내용(정의, 표, 예시 등)도 요점 정리와 퀴즈에 넣을 수 있습니다.
- 화면 글자에는 프로그램 메뉴 같은 잡음과 잘못 읽힌 글자가 섞여 있으니, 강의 내용과 관련된 것만 쓰세요.
- 챕터와 퀴즈의 시점은 계속 대본 줄의 시점을 쓰세요.
- page_labels: 화면 글자의 [분:초] 묶음마다 하나씩, 학생이 자기 교재에서 그 화면을 찾을 수 있는 짧은 이름표(20자 안팎).
  start는 그 묶음의 [분:초]를 그대로 적습니다. 화면에 인쇄된 교재 쪽 번호가 보이면 "170쪽 · 꺼삐딴 리 지문"처럼
  쪽수를 앞에 적고, 안 보이면 "(2) 운율 형성 방법"처럼 단원·소제목만 적습니다. PDF 프로그램 위쪽의 "11 / 200" 같은
  표시는 파일 안의 순서라 교재 쪽수와 다를 수 있으니 쪽수로 쓰지 마세요."""

REFERENCE_NOTE = """

학원이 이미 만든 요점 정리(학원 요점 정리)도 주어집니다. 교재 PDF에서 자동으로 뽑은 것이라 엉뚱한 내용, 잘린 문장,
중복이 섞여 있을 수 있습니다.
- points는 학원 요점 정리의 항목과 표현을 최대한 그대로 쓰고, 각 항목을 강의에서 그것을 설명하는 시점의 챕터에 넣으세요.
  강의에서 다루지 않은 항목은 가장 관련 있는 챕터에 넣습니다.
- 대본·화면 글자와 맞지 않거나 추출 오류로 보이는 항목은 고치거나 빼고, 그 내역을 edits에 적으세요.
  before는 원래 항목, after는 고친 항목(뺐으면 빈 문자열), reason은 한 문장입니다.
- overview: 학원 요점 정리의 개요(갈래·성격·주제·배경·제재 등)를 name/value로 적고, 오류는 고쳐서 적습니다.
- glossary: 학원 요점 정리의 어휘 가운데 강의를 이해하는 데 필요한 것을 term/meaning으로 적습니다.
- 퀴즈를 만들 때 학원 요점 정리의 빈칸 문제도 참고하세요."""

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
            },
            "required": ["start", "title", "points"],
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
        "corrections": {"type": "array", "items": {
            "type": "object",
            "properties": {"wrong": {"type": "string"}, "right": {"type": "string"}},
            "required": ["wrong", "right"],
            "additionalProperties": False,
        }},
        "page_labels": {"type": "array", "items": {
            "type": "object",
            "properties": {"start": {"type": "string"}, "label": {"type": "string"}},
            "required": ["start", "label"],
            "additionalProperties": False,
        }},
        "overview": {"type": "array", "items": {
            "type": "object",
            "properties": {"name": {"type": "string"}, "value": {"type": "string"}},
            "required": ["name", "value"],
            "additionalProperties": False,
        }},
        "glossary": {"type": "array", "items": {
            "type": "object",
            "properties": {"term": {"type": "string"}, "meaning": {"type": "string"}},
            "required": ["term", "meaning"],
            "additionalProperties": False,
        }},
        "edits": {"type": "array", "items": {
            "type": "object",
            "properties": {"before": {"type": "string"}, "after": {"type": "string"},
                           "reason": {"type": "string"}},
            "required": ["before", "after", "reason"],
            "additionalProperties": False,
        }},
    },
    "required": ["summary", "chapters", "quiz", "corrections", "page_labels", "overview", "glossary", "edits"],
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


def _ask_claude(client, stream=False, **request) -> str:
    """stream: 답이 길 수 있는 요청(요점 정리)은 스트리밍으로 받습니다. 한도(max_tokens)를 크게 잡으면 SDK가 보통 요청을 막습니다."""
    # 안전 필터가 드물게 요청을 거절하면 Anthropic이 권장하는 다른 모델로 자동 재시도합니다.
    request = {"model": MODEL, "betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default", **request}
    if stream:
        with client.beta.messages.stream(**request) as answer:
            response = answer.get_final_message()
    else:
        response = client.beta.messages.create(**request)
    if response.stop_reason in ("refusal", "max_tokens"):
        raise RuntimeError(f"Claude 응답이 완료되지 않았습니다 ({response.stop_reason})")
    return "".join(b.text for b in response.content if b.type == "text")


def make_study_guide(client, title: str, segments: list[dict], screens: list[dict] | None = None,
                     references: list[str] | None = None) -> dict:
    """screens는 페이지마다 {"start": 초, "text": [화면 글자 줄]}. 있으면 근거로 함께 보내고 페이지 이름표를 받습니다.

    references는 학원이 이미 만든 작품별 요점 정리 글. 있으면 그 항목을 다듬어 쓰고 고친 내역(edits)을 받습니다.
    """
    content = f"강의 제목: {title}\n\n<대본>\n{transcript_text(segments)}\n</대본>"
    if screens:
        content += "\n\n<화면 글자>\n" + "\n\n".join(
            f"[{fmt_time(s['start'])}]\n" + "\n".join(s["text"]) for s in screens) + "\n</화면 글자>"
    if references:
        content += "\n\n<학원 요점 정리>\n" + "\n\n".join(references) + "\n</학원 요점 정리>"
    system = GUIDE_PROMPT + (SCREEN_NOTE if screens else "") + (REFERENCE_NOTE if references else "")
    text = _ask_claude(
        client,
        stream=True,
        # 생각한 글도 이 한도에 듭니다. 3시간 강의(챕터 30개쯤·페이지 이름표 90개쯤)는 16,000이면 잘려 밤마다 다시 요청했습니다.
        # 실제로 쓴 만큼만 비용이 들고, 한도를 넉넉히 잡는 것만으로는 비용이 늘지 않습니다.
        max_tokens=64000,
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": GUIDE_SCHEMA}},
        system=system,
        messages=[{"role": "user", "content": content}],
    )
    guide = json.loads(text)
    for chapter in guide["chapters"]:
        chapter["start"] = parse_time(chapter["start"])
    guide["chapters"].sort(key=lambda c: c["start"])
    guide["quiz"] = [q for q in guide["quiz"] if 0 <= q["answer"] < len(q["choices"])]
    for q in guide["quiz"]:
        q["time"] = parse_time(q["time"])
    guide["corrections"] = [c for c in guide["corrections"]
                            if len(c["wrong"]) >= 2 and c["wrong"] != c["right"]]
    for label in guide["page_labels"]:
        label["start"] = parse_time(label["start"])
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
