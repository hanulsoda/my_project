"""전체 점검 2단계(안정성·보안): 한 사람·한 파일이 모든 학생의 화면을 멈추거나 기록을 새게 하지 못하게."""

import json
import threading
import time
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

import academy.server as server
from academy.library import find_videos, load_analysis, save_analysis
from academy.server import create_app

SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "안녕하세요"}]
QUIZ = [{"question": "제망매가의 갈래는?", "choices": ["향가", "가사"], "answer": 0, "explanation": "향가", "time": 1.0}]


@pytest.fixture
def site(tmp_path):
    video_dir, data_dir, log_dir = tmp_path / "videos", tmp_path / "data", tmp_path / "logs"
    video_dir.mkdir()
    (video_dir / "1강.mp4").write_bytes(b"x")
    vid = find_videos(video_dir)[0]["id"]
    save_analysis(data_dir, vid, {"title": "1강", "duration": 2.0, "segments": SEGMENTS,
                                  "guide": {"summary": "요약", "chapters": [], "quiz": QUIZ}})
    return video_dir, data_dir, log_dir, vid


def test_unknown_lecture_numbers_do_not_make_everyone_wait_for_a_rescan(site, monkeypatch):
    video_dir, data_dir, _, vid = site
    real = server.find_videos
    client = TestClient(create_app(video_dir, data_dir, None))
    client.get("/api/videos")
    monkeypatch.setattr(server, "find_videos", lambda d: time.sleep(1.5) or real(d))  # NAS를 훑는 데 오래 걸림
    monkeypatch.setattr(server, "MISS_SECONDS", 0)

    started = time.monotonic()
    assert client.get("/media/0123456789ab").status_code == 404  # 없는 번호: 기다리지 않고 바로
    assert client.get("/api/videos/not-a-number").status_code == 404  # 번호 모양이 아니면 훑지도 않음
    assert client.get(f"/api/videos/{vid}").status_code == 200  # 다른 학생의 요청도 그대로
    assert time.monotonic() - started < 1


def test_a_new_lecture_is_found_by_a_rescan_in_the_background(site, monkeypatch):
    video_dir, data_dir, _, _ = site
    client = TestClient(create_app(video_dir, data_dir, None))
    client.get("/api/videos")
    (video_dir / "2강.mp4").write_bytes(b"xy")
    new = next(v["id"] for v in find_videos(video_dir) if v["title"] == "2강")
    monkeypatch.setattr(server, "MISS_SECONDS", 0)

    client.get(f"/api/videos/{new}")
    deadline = time.monotonic() + 5
    while client.get(f"/api/videos/{new}").status_code != 200 and time.monotonic() < deadline:
        time.sleep(0.05)

    assert client.get(f"/api/videos/{new}").status_code == 200


def test_device_transfer_keeps_only_records_and_has_a_total_memory_cap(site, monkeypatch):
    video_dir, data_dir, _, vid = site
    client = TestClient(create_app(video_dir, data_dir, None))
    code = client.post("/api/transfer", json={"data": {f"notes:{vid}": [{"t": 1, "text": "메모"}], "speed": 1.5,
                                                         "other": [[]] * 1000}}).json()["code"]
    assert client.post(f"/api/transfer/{code}").json()["data"] == {f"notes:{vid}": [{"t": 1, "text": "메모"}], "speed": 1.5}

    monkeypatch.setattr(server, "TRANSFER_BYTES", 2000)  # 서버 전체 상한(실제는 50MB)
    big = {"data": {f"notes:{vid}": [{"t": 1, "text": "가" * 500}]}}
    client2 = TestClient(create_app(video_dir, data_dir, None))
    answers = [client2.post("/api/transfer", json=big).status_code for _ in range(5)]
    assert 503 in answers  # 남은 코드가 상한을 넘으면 새 코드를 만들지 않음


def test_one_odd_analysis_file_does_not_break_the_list_for_everyone(site):
    video_dir, data_dir, _, vid = site
    (video_dir / "2강.mp4").write_bytes(b"xy")
    other = next(v["id"] for v in find_videos(video_dir) if v["title"] == "2강")
    save_analysis(data_dir, other, {"title": "2강", "duration": 2.0, "segments": [{"start": 0.0}],  # 'text'가 빠짐
                                    "guide": {"chapters": [{"start": "1분", "title": "x"}, {"start": 2, "title": "y"}]}})
    client = TestClient(create_app(video_dir, data_dir, None))

    listed = {v["id"]: v["analyzed"] for v in client.get("/api/videos").json()}
    assert listed == {vid: True, other: False}  # 그 강의만 '분석 전'
    assert client.get("/api/status").status_code == 200
    assert client.get("/api/search", params={"q": "안녕하세요"}).status_code == 200


def test_summaries_and_fixes_are_for_teachers_only_from_the_internet(site):
    video_dir, data_dir, _, _ = site
    ref = {"title": "1강", "grade": "고1", "features": [{"text": "숨긴 항목"}]}
    secret = "s" * 40
    app = create_app(video_dir, data_dir, None, [ref], teacher_key="teacher-key-1234", entry_secret=secret)
    student = TestClient(app, client=("203.0.113.5", 1))
    student.cookies.set(server.PASS_COOKIE, server.make_pass(secret, time.time()))  # 입장한 학생

    assert student.get("/api/references").status_code == 403
    assert student.get(f"/api/references/{server.ref_key(ref)}").status_code == 403
    teacher = {"x-teacher-key": "teacher-key-1234"}
    assert student.get("/api/references", headers=teacher).status_code == 200
    assert TestClient(app, client=("192.168.0.5", 1)).get("/api/references").status_code == 200  # 학원 안은 그대로


def test_requests_from_the_proxy_without_its_headers_count_as_internet(site, caplog):
    video_dir, data_dir, _, _ = site
    app = create_app(video_dir, data_dir, None, entry_secret="s" * 40, proxy_addrs=("192.168.0.2",))
    nas = TestClient(app, client=("192.168.0.2", 1))  # 시놀로지 설정에서 X-Forwarded-For를 빠뜨림

    assert nas.get("/api/videos").status_code == 401
    assert TestClient(app, client=("192.168.0.9", 1)).get("/api/videos").status_code == 200

    from academy.entry import sign
    expired = int(time.time()) - 100
    nas.get("/enter", params={"exp": expired, "sig": sign("s" * 40, f"enter:{expired}")})
    nas.get("/enter", params={"exp": expired, "sig": "0" * 64})
    assert "만료" in caplog.text and "비밀 키" in caplog.text  # 왜 막혔는지 서버 기록에


@pytest.mark.parametrize("host, inside", [("192.168.0.5", True), ("10.1.2.3", True), ("100.80.1.2", True),
                                          ("fd12::1", True), ("::ffff:192.168.0.5", True), ("127.0.0.1", True),
                                          ("203.0.113.5", False), ("2002:cb00:7105::1", False), ("2001::1", False),
                                          ("64:ff9b:1::1", False)])
def test_only_academy_and_vpn_addresses_count_as_inside(host, inside):
    class Request:
        headers = type("H", (), {"getlist": lambda self, k: [], "get": lambda self, k, d=None: None})()
        client = type("C", (), {"host": host})()

    assert (server._where(Request()) == "lan") is inside


def test_device_numbers_change_every_month(site, monkeypatch):
    video_dir, data_dir, log_dir, vid = site
    client = TestClient(create_app(video_dir, data_dir, None, log_dir=log_dir), client=("192.168.0.7", 1))

    def open_in(month):
        class Fixed(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2026, month, 15, 12, 0)
        monkeypatch.setattr(server, "datetime", Fixed)
        client.get(f"/api/videos/{vid}", params={"view": 1})

    open_in(10)
    open_in(10)
    open_in(11)
    who = [json.loads(line)["who"] for line in (log_dir / "usage.log").read_text().splitlines()]
    assert who[0] == who[1] != who[2]  # 지난달 기록과 이어 볼 수 없게
    assert "2026-10" not in (log_dir / ".usage-salt").read_text()  # 지난달 비밀값은 지움


def test_only_questions_that_exist_in_the_lecture_are_counted(site):
    video_dir, data_dir, log_dir, vid = site
    client = TestClient(create_app(video_dir, data_dir, None, log_dir=log_dir), client=("192.168.0.7", 1))

    client.post("/api/quiz-result", json={"id": vid, "key": "NOT A REAL QUESTION", "right": False})
    client.post("/api/quiz-result", json={"id": vid, "key": "제망매가의 갈래는?", "right": False})

    rows = [json.loads(line) for line in (log_dir / "quiz.log").read_text().splitlines()]
    assert [r["k"] for r in rows] == ["제망매가의 갈래는?"]  # 학생이 지어낸 글이 '많이 틀리는 문제'에 오르지 않음


def test_teacher_key_and_transfer_code_guessing_from_the_internet_has_a_total_cap(site, monkeypatch):
    video_dir, data_dir, _, _ = site
    monkeypatch.setattr(server, "GUESSES_PER_HOUR", 5)
    secret = "s" * 40
    app = create_app(video_dir, data_dir, None, teacher_key="teacher-key-1234", entry_secret=secret)
    tries = []
    for n in range(8):  # 주소를 바꿔 가며 맞혀 봄
        guesser = TestClient(app, client=(f"203.0.113.{n}", 1))
        guesser.cookies.set(server.PASS_COOKIE, server.make_pass(secret, time.time()))
        tries.append(guesser.put("/api/picks", json={"ids": []}, headers={"x-teacher-key": f"guess{n}"}).status_code)
        tries.append(guesser.post("/api/transfer/123456").status_code)
    assert 429 in tries[10:]
    assert TestClient(app, client=("192.168.0.5", 1)).put(  # 학원 안의 선생님은 막히지 않음
        "/api/picks", json={"ids": []}, headers={"x-teacher-key": "teacher-key-1234"}).status_code == 200


def test_odd_times_in_a_hand_edited_log_do_not_break_the_status_page(site):
    video_dir, data_dir, log_dir, vid = site
    log_dir.mkdir()
    now = int(time.time())
    (log_dir / "usage.log").write_text("\n".join([
        '{"t": NaN, "id": "x", "who": "a"}', '{"t": Infinity, "id": "x", "who": "a"}',
        json.dumps({"t": now * 1000, "id": vid, "who": "a"}),  # 밀리초로 적음
        json.dumps({"t": now, "id": vid, "who": "b"})]) + "\n", encoding="utf-8")
    client = TestClient(create_app(video_dir, data_dir, None, log_dir=log_dir))

    assert client.get("/api/status").json()["usage"]["opens"] == 1


def test_a_log_emptied_in_place_is_read_again(site):
    video_dir, data_dir, log_dir, vid = site
    log_dir.mkdir()
    log = log_dir / "usage.log"
    line = lambda who: json.dumps({"t": int(time.time()), "id": vid, "who": who}) + "\n"
    log.write_text(line("a") * 5, encoding="utf-8")
    client = TestClient(create_app(video_dir, data_dir, None, log_dir=log_dir))
    assert client.get("/api/status").json()["usage"]["opens"] == 5

    with log.open("r+") as f:  # logrotate copytruncate: 같은 파일을 비운 뒤 다시 씀
        f.truncate(0)
    log.write_text(line("b" * 20) * 4, encoding="utf-8")  # 예전보다 커져 읽던 자리 뒤까지 이어짐

    assert client.get("/api/status").json()["usage"]["opens"] == 4


def test_an_empty_analysis_file_left_by_a_power_cut_is_analyzed_again(tmp_path):
    from academy.analyze import analyze_all
    from tests.test_analyze import Recorder, make_videos
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / f"{ids['1강']}.json").write_text("", encoding="utf-8")  # 정전으로 0바이트
    rec = Recorder()

    assert analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide) == 0
    assert rec.transcribed == ["1강.mp4"] and load_analysis(tmp_path / "data", ids["1강"])["guide"]
