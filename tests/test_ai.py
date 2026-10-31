import pytest

from academy.ai import GUIDE_PROMPT, answer_question, fmt_time, make_study_guide, parse_time, transcript_text
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
    "corrections": [
        {"wrong": "근의 공시", "right": "근의 공식"},
        {"wrong": "공", "right": "곡"},
        {"wrong": "같음", "right": "같음"},
    ],
    "page_labels": [],
    "overview": [],
    "glossary": [],
    "edits": [],
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


def test_a_guide_for_a_long_lecture_has_room_to_finish():
    client = FakeClient(GUIDE)

    make_study_guide(client, "수학/1강", SEGMENTS)

    # 3시간 강의는 생각+답이 16,000 토큰을 넘어 잘렸고, 밤마다 다시 요청해 비용이 들었습니다.
    # 넉넉한 한도는 스트리밍으로만 보낼 수 있습니다(SDK가 오래 걸릴 보통 요청을 막음).
    assert len(client.streamed) == 1 and client.streamed[0]["max_tokens"] >= 64000


def test_study_guide_keeps_only_real_multi_letter_corrections():
    guide = make_study_guide(FakeClient(GUIDE), "수학/1강", SEGMENTS)

    assert guide["corrections"] == [{"wrong": "근의 공시", "right": "근의 공식"}]


def test_study_guide_sends_screen_text_and_turns_page_labels_into_times():
    client = FakeClient({**GUIDE, "page_labels": [{"start": "01:15", "label": "12쪽 · 근의 공식"}]})

    guide = make_study_guide(client, "수학/1강", SEGMENTS,
                             screens=[{"start": 75.0, "text": ["근의 공식", "판별식 D"]}])

    req = client.requests[0]
    assert "<화면 글자>\n[01:15]\n근의 공식\n판별식 D\n</화면 글자>" in req["messages"][0]["content"]
    assert req["system"] != GUIDE_PROMPT and "화면 글자" in req["system"]
    assert guide["page_labels"] == [{"start": 75, "label": "12쪽 · 근의 공식"}]


def test_study_guide_without_screens_sends_transcript_only():
    client = FakeClient(GUIDE)

    make_study_guide(client, "수학/1강", SEGMENTS)

    req = client.requests[0]
    assert "<화면 글자>" not in req["messages"][0]["content"]
    assert req["system"] == GUIDE_PROMPT


def test_study_guide_builds_on_the_academy_summary_and_keeps_overview_and_edits():
    reply = {**GUIDE, "overview": [{"name": "갈래", "value": "현대 수필"}],
             "glossary": [{"term": "울안", "meaning": "울타리를 둘러친 안"}],
             "edits": [{"before": "인물의 개념과 분류", "after": "", "reason": "다른 단원 내용이 섞임"}]}
    client = FakeClient(reply)

    guide = make_study_guide(client, "1강", SEGMENTS, references=["「성난 풀잎」(고2)\n개요: 갈래: 현대 수필"])

    req = client.requests[0]
    assert "<학원 요점 정리>\n「성난 풀잎」(고2)\n개요: 갈래: 현대 수필\n</학원 요점 정리>" in req["messages"][0]["content"]
    assert "학원 요점 정리" in req["system"]
    assert guide["overview"] == [{"name": "갈래", "value": "현대 수필"}]
    assert guide["glossary"] == [{"term": "울안", "meaning": "울타리를 둘러친 안"}]
    assert guide["edits"] == [{"before": "인물의 개념과 분류", "after": "", "reason": "다른 단원 내용이 섞임"}]


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
