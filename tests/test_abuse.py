"""인터넷에 열었을 때, 한 기기가 마구 보내도 서버가 버티고 선생님 정보가 새지 않는지."""

import time

import pytest
from fastapi.testclient import TestClient

import academy.server as server
from academy.entry import make_pass
from academy.library import find_videos, save_analysis
from academy.server import PASS_COOKIE, create_app

SECRET = "s" * 32
ACADEMY = ("192.168.0.5", 50000)
OTHER_PC = ("192.168.0.6", 50000)
HOME = ("121.130.20.30", 50000)
SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "오늘은 제망매가를 배웁니다"}]


@pytest.fixture
def lecture(tmp_path):
    (tmp_path / "videos").mkdir()
    (tmp_path / "videos" / "1강.mp4").write_bytes(b"x")
    video_id = find_videos(tmp_path / "videos")[0]["id"]
    save_analysis(tmp_path / "data", video_id, {"title": "1강", "duration": 2.0, "segments": SEGMENTS, "guide": None})
    return tmp_path, video_id


def test_very_long_search_words_are_refused_quickly(lecture):
    tmp_path, video_id = lecture
    client = TestClient(create_app(tmp_path / "videos", tmp_path / "data", None), client=ACADEMY)

    started = time.monotonic()
    everywhere = client.get("/api/search", params={"q": "가나다라" * 100})
    here = client.get(f"/api/videos/{video_id}/search", params={"q": "가나다라" * 100})

    assert everywhere.status_code == 400 and here.status_code == 400
    assert "30글자" in everywhere.json()["detail"]
    assert time.monotonic() - started < 1  # 비슷한 소리 찾기를 만들기 전에 거절
    assert client.get("/api/search", params={"q": "제망매가"}).json()["exact"][0]["id"] == video_id


def test_one_device_cannot_fill_the_disk_with_quiz_results_or_opens(lecture, monkeypatch):
    tmp_path, video_id = lecture
    monkeypatch.setattr(server, "LOG_WRITES_PER_HOUR", 5)
    app = create_app(tmp_path / "videos", tmp_path / "data", None, log_dir=tmp_path / "logs")
    (tmp_path / "logs").mkdir()
    me, other = TestClient(app, client=ACADEMY), TestClient(app, client=OTHER_PC)

    for n in range(8):
        assert me.post("/api/quiz-result", json={"id": video_id, "key": f"문제 {n}", "right": True}).status_code == 204
        me.get(f"/api/videos/{video_id}", params={"view": 1})
    other.post("/api/quiz-result", json={"id": video_id, "key": "문제", "right": False})
    other.get(f"/api/videos/{video_id}", params={"view": 1})

    assert len((tmp_path / "logs" / "quiz.log").read_text().splitlines()) == 5 + 1  # 넘친 것은 기록만 하지 않음
    assert len((tmp_path / "logs" / "usage.log").read_text().splitlines()) == 5 + 1


def test_one_device_cannot_take_every_transfer_slot(lecture, monkeypatch):
    tmp_path, _ = lecture
    monkeypatch.setattr(server, "TRANSFERS_PER_DEVICE", 3)
    app = create_app(tmp_path / "videos", tmp_path / "data", None)
    me, other = TestClient(app, client=ACADEMY), TestClient(app, client=OTHER_PC)

    codes = [me.post("/api/transfer", json={"data": {"n": n}}).status_code for n in range(4)]

    assert codes == [200, 200, 200, 429]
    assert other.post("/api/transfer", json={"data": {}}).status_code == 200  # 다른 학생은 그대로


def test_teacher_status_needs_the_teacher_key_from_the_internet(lecture):
    tmp_path, _ = lecture
    app = create_app(tmp_path / "videos", tmp_path / "data", None, teacher_key="teacher-key-123", entry_secret=SECRET)
    home = TestClient(app, client=HOME)
    home.cookies.set(PASS_COOKIE, make_pass(SECRET, time.time()))

    assert home.get("/api/status").status_code == 403  # 입장한 학생도 이용 통계·운영 기록은 못 봄
    assert home.get("/api/status", headers={"x-teacher-key": "teacher-key-123"}).status_code == 200
    assert TestClient(app, client=ACADEMY).get("/api/status").status_code == 200  # 학원 안은 지금처럼
