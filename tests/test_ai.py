import pytest

from academy.ai import answer_question, fmt_time, make_study_guide, parse_time, transcript_text
from tests.fakes import FakeClient

SEGMENTS = [
    {"start": 0.0, "end": 4.0, "text": "오늘은 이차방정식을 배웁니다."},
    {"start": 75.5, "end": 80.0, "text": "근의 공식을 봅시다."},
]

GUIDE = {
    "summary": "이차방정식과 근의 공식을 다룹니다.",
    "chapters": [
        {"start": "01:15", "title": "근의 공식", "points": ["공식 유도"]},
        {"start": "00:00", "title": "도입", "points": ["이차방정식의 정의"]},
    ],
    "quiz": [
        {"question": "근의 공식은?", "choices": ["가", "나", "다", "라"], "answer": 1,
         "explanation": "나가 맞습니다.", "time": "01:15"},
        {"question": "보기 범위를 벗어난 정답", "choices": ["가", "나"], "answer": 5,
         "explanation": "", "time": "00:00"},
    ],
}


def test_fmt_time():
    assert fmt_time(0) == "00:00"
    assert fmt_time(75.9) == "01:15"
    assert fmt_time(3725) == "1:02:05"


def test_parse_time():
    assert parse_time("01:15") == 75
    assert parse_time("1:02:05") == 3725
    assert parse_time("잘못된 값") == 0


def test_transcript_text_marks_each_line_with_time():
    assert transcript_text(SEGMENTS) == "[00:00] 오늘은 이차방정식을 배웁니다.\n[01:15] 근의 공식을 봅시다."


def test_study_guide_converts_times_sorts_chapters_and_drops_broken_quiz():
    client = FakeClient(GUIDE)

    guide = make_study_guide(client, "수학/1강", SEGMENTS)

    assert [c["start"] for c in guide["chapters"]] == [0, 75]
    assert guide["chapters"][0]["title"] == "도입"
    assert len(guide["quiz"]) == 1
    assert guide["quiz"][0]["time"] == 75


def test_study_guide_request_sends_transcript_and_json_schema():
    client = FakeClient(GUIDE)

    make_study_guide(client, "수학/1강", SEGMENTS)

    req = client.requests[0]
    assert req["model"] == "claude-opus-5-5"
    assert req["fallbacks"] == "default"
    assert req["output_config"]["format"]["type"] == "json_schema"
    assert "[01:15] 근의 공식을 봅시다." in req["messages"][0]["content"]
    assert "수학/1강" in req["messages"][0]["content"]


def test_refusal_raises():
    client = FakeClient("", stop_reason="refusal")

    with pytest.raises(RuntimeError):
        make_study_guide(client, "1강", SEGMENTS)


def test_answer_question_caches_transcript_and_keeps_history():
    client = FakeClient("근의 공식은 [01:15]에 나옵니다.")
    history = [{"role": "user", "content": "이전 질문"}, {"role": "assistant", "content": "이전 답"}]

    answer = answer_question(client, "1강", SEGMENTS, "근의 공식이 뭐예요?", history, current_time=80)

    assert answer == "근의 공식은 [01:15]에 나옵니다."
    req = client.requests[0]
    system = req["system"][0]
    assert system["cache_control"] == {"type": "ephemeral"}
    assert "[01:15] 근의 공식을 봅시다." in system["text"]
    assert req["messages"][:2] == history
    last = req["messages"][2]
    assert last["role"] == "user"
    assert "근의 공식이 뭐예요?" in last["content"]
    assert "01:20" in last["content"]


def test_answer_question_without_current_time():
    client = FakeClient("답")

    answer_question(client, "1강", SEGMENTS, "질문", [], current_time=None)

    assert client.requests[0]["messages"] == [{"role": "user", "content": "질문"}]
