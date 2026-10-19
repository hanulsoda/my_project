import base64

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
        {"start": "01:15", "title": "근의 공식", "points": ["공식 유도"], "board": ""},
        {"start": "00:00", "title": "도입", "points": ["이차방정식의 정의"], "board": ""},
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
    first_block = req["messages"][0]["content"][0]
    assert first_block["type"] == "text"
    assert "[01:15] 근의 공식을 봅시다." in first_block["text"]
    assert "수학/1강" in first_block["text"]


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


def test_answer_length_is_capped_to_keep_cost_down():
    client = FakeClient("답")

    answer_question(client, "1강", SEGMENTS, "아주 길게 설명해 주세요", [], current_time=None)

    assert client.requests[0]["max_tokens"] <= 4000  # 한 번에 드는 비용의 상한 (짧은 답에는 충분)


FRAMES = [(0, b"\xff\xd8A"), (60, b"\xff\xd8B"), (120, b"\xff\xd8C")]
BOARD_GUIDE = {
    "summary": "요약",
    "chapters": [
        {"start": "00:00", "title": "정의", "points": ["x²"], "board": "01:05"},
        {"start": "01:00", "title": "설명", "points": ["말로 설명"], "board": ""},
        {"start": "02:00", "title": "예제", "points": ["예제"], "board": "abc"},
    ],
    "quiz": [],
}


def test_guide_request_sends_transcript_then_frames():
    client = FakeClient(BOARD_GUIDE)

    make_study_guide(client, "수학/1강", SEGMENTS, FRAMES)

    blocks = client.requests[0]["messages"][0]["content"]
    assert blocks[0]["type"] == "text" and "[01:15] 근의 공식을 봅시다." in blocks[0]["text"]
    pairs = [(blocks[i], blocks[i + 1]) for i in range(1, len(blocks), 2)]
    assert [label["text"] for label, _ in pairs] == ["[00:00] 화면", "[01:00] 화면", "[02:00] 화면"]
    assert pairs[0][1] == {"type": "image", "source": {
        "type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(b"\xff\xd8A").decode()}}


def test_board_maps_to_nearest_frame_or_none():
    guide = make_study_guide(FakeClient(BOARD_GUIDE), "1강", SEGMENTS, FRAMES)

    assert [c["board"] for c in guide["chapters"]] == [60, None, None]


def test_no_frames_means_no_board():
    client = FakeClient(BOARD_GUIDE)

    guide = make_study_guide(client, "1강", SEGMENTS)

    assert [c["board"] for c in guide["chapters"]] == [None, None, None]
    assert all(b["type"] == "text" for b in client.requests[0]["messages"][0]["content"])
