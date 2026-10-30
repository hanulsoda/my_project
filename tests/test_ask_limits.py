"""질문하기(유료 Claude API)를 한 사람이나 프로그램이 마구 쓰지 못하게 하는 제한."""

import threading
import time

import pytest
from fastapi.testclient import TestClient

import academy.server as server
from academy.entry import make_pass
from academy.library import find_videos, save_analysis
from academy.server import PASS_COOKIE, create_app

SECRET = "s" * 32
SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "안녕하세요"}]


@pytest.fixture
def lecture(tmp_path):
    (tmp_path / "videos").mkdir()
    (tmp_path / "videos" / "1강.mp4").write_bytes(b"x")
    video_id = find_videos(tmp_path / "videos")[0]["id"]
    save_analysis(tmp_path / "data", video_id, {"title": "1강", "segments": SEGMENTS, "guide": None})
    return tmp_path, video_id


_entered = iter(range(10_000))


def student(app):
    """입장 링크로 들어온 학생 한 명 (통과 쿠키를 가진 브라우저). 학생마다 들어온 시각(초)이 다릅니다."""
    client = TestClient(app)
    client.cookies.set(PASS_COOKIE, make_pass(SECRET, time.time() - next(_entered)))
    return client


def ask(client, video_id, **body):
    return client.post(f"/api/videos/{video_id}/ask", json={"question": "질문", **body})


def test_one_student_can_ask_ten_times_in_ten_minutes(lecture):
    tmp_path, video_id = lecture
    app = create_app(tmp_path / "videos", tmp_path / "data", lambda *a: "답", entry_secret=SECRET)
    me, friend = student(app), student(app)

    assert [ask(me, video_id).status_code for _ in range(10)] == [200] * 10
    over = ask(me, video_id)

    assert over.status_code == 429
    assert "몇 분 뒤" in over.json()["detail"]
    assert ask(friend, video_id).status_code == 200  # 다른 학생은 그대로


def test_whole_academy_has_an_hourly_cap(lecture, monkeypatch):
    tmp_path, video_id = lecture
    monkeypatch.setattr(server, "ASK_PER_HOUR", 3)
    app = create_app(tmp_path / "videos", tmp_path / "data", lambda *a: "답", entry_secret=SECRET)

    codes = [ask(student(app), video_id).status_code for _ in range(4)]  # 매번 다른 학생

    assert codes == [200, 200, 200, 429]


def test_without_entry_check_limit_is_per_computer(lecture):
    tmp_path, video_id = lecture
    client = TestClient(create_app(tmp_path / "videos", tmp_path / "data", lambda *a: "답"))

    assert [ask(client, video_id).status_code for _ in range(11)][-2:] == [200, 429]


def test_without_entry_check_made_up_cookies_do_not_dodge_the_limit(lecture):
    tmp_path, video_id = lecture
    client = TestClient(create_app(tmp_path / "videos", tmp_path / "data", lambda *a: "답"))

    codes = []
    for n in range(11):
        client.cookies.set(PASS_COOKIE, f"made-up-{n}")  # 입장 확인이 꺼져 있으면 아무도 쿠키를 확인하지 않음
        codes.append(ask(client, video_id).status_code)

    assert codes[-2:] == [200, 429]


def test_questions_turned_away_while_busy_do_not_use_up_the_limit(lecture, monkeypatch):
    tmp_path, video_id = lecture
    monkeypatch.setattr(server, "ASK_AT_ONCE", 1)
    entered, release = threading.Event(), threading.Event()

    def slow_answer(*args):
        entered.set()
        release.wait(5)
        return "답"

    app = create_app(tmp_path / "videos", tmp_path / "data", slow_answer, entry_secret=SECRET)
    with TestClient(app):
        first, second = student(app), student(app)
        worker = threading.Thread(target=lambda: ask(first, video_id))
        worker.start()
        assert entered.wait(5)

        busy = [ask(second, video_id).status_code for _ in range(server.ASK_PER_PERSON)]  # 바쁜 저녁에 다시 눌러 봄

        release.set()
        worker.join(5)
        later = ask(second, video_id).status_code
    assert busy == [503] * server.ASK_PER_PERSON
    assert later == 200  # 답을 한 번도 못 받았으니 막히지 않음


def test_request_without_size_is_refused(lecture):
    tmp_path, video_id = lecture
    client = TestClient(create_app(tmp_path / "videos", tmp_path / "data", lambda *a: "답", entry_secret=SECRET))

    # 크기를 미리 알리지 않고 조금씩 보내는 요청 (Transfer-Encoding: chunked)
    res = client.post(f"/api/videos/{video_id}/ask", content=iter([b'{"question": ', '"질문"}'.encode()]),
                      headers={"content-type": "application/json"})

    assert res.status_code == 411


def test_too_many_questions_at_once_are_turned_away_quickly(lecture, monkeypatch):
    tmp_path, video_id = lecture
    monkeypatch.setattr(server, "ASK_AT_ONCE", 1)
    entered, release = threading.Event(), threading.Event()

    def slow_answer(*args):
        entered.set()
        release.wait(5)
        return "답"

    app = create_app(tmp_path / "videos", tmp_path / "data", slow_answer, entry_secret=SECRET)
    with TestClient(app):
        first, second = student(app), student(app)
        results = {}
        worker = threading.Thread(target=lambda: results.setdefault("first", ask(first, video_id).status_code))
        worker.start()
        assert entered.wait(5)

        busy = ask(second, video_id)  # 첫 질문이 답을 기다리는 동안

        release.set()
        worker.join(5)
    assert busy.status_code == 503
    assert "잠시 뒤" in busy.json()["detail"]
    assert results["first"] == 200


def test_long_chat_history_is_refused(lecture):
    tmp_path, video_id = lecture
    client = TestClient(create_app(tmp_path / "videos", tmp_path / "data", lambda *a: "답"))
    history = [{"role": "user", "content": "가" * 9000}, {"role": "assistant", "content": "나" * 9000},
               {"role": "user", "content": "다" * 9000}]  # 한 줄씩은 괜찮지만 합치면 2만 자가 넘음

    assert ask(client, video_id, history=history).status_code == 422


def test_huge_request_is_refused_before_reading_it(lecture):
    tmp_path, video_id = lecture
    client = TestClient(create_app(tmp_path / "videos", tmp_path / "data", lambda *a: "답", entry_secret=SECRET))

    res = client.post(f"/api/videos/{video_id}/ask", content=b"x" * 5_000_000,
                      headers={"content-type": "application/json"})

    assert res.status_code == 413


def test_question_is_refused_while_asking_is_off(lecture):
    # 지금 학원은 질문하기를 꺼 두었습니다(server.py 맨 아래 answer=None).
    tmp_path, video_id = lecture
    client = TestClient(create_app(tmp_path / "videos", tmp_path / "data", None))

    assert ask(client, video_id).status_code == 403


def test_moving_large_records_is_not_blocked_by_the_size_limit(lecture):
    # 기기 옮기기는 기록 2MB까지 받습니다. 요청 크기 제한이 그보다 먼저 막으면 안 됩니다.
    tmp_path, _ = lecture
    client = TestClient(create_app(tmp_path / "videos", tmp_path / "data", None))

    res = client.post("/api/transfer", json={"data": {"notes": "가" * 500_000}})  # 약 1.5MB

    assert res.status_code == 200
