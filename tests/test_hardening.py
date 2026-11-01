"""전체 점검 2단계(안정성·보안): 한 사람·한 파일이 모든 학생의 화면을 멈추거나 기록을 새게 하지 못하게."""

import json
import threading
import time
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

import academy.server as server
from academy.library import find_videos, load_analysis, save_analysis
from academy.references import ref_key
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


# ---- 재검토: 한 사람이 모두를 막거나 서버를 붙잡지 못하게 ----

def test_searches_waiting_in_line_do_not_hold_the_workers_videos_need(site, monkeypatch):
    video_dir, data_dir, _, vid = site
    monkeypatch.setattr(server, "SEARCH_WAITERS", 2)
    client = TestClient(create_app(video_dir, data_dir, None))
    client.get("/api/videos")
    real_near = server._near
    monkeypatch.setattr(server, "_near", lambda *a, **k: time.sleep(1.0) or real_near(*a, **k))  # 낱말마다 1초 걸림
    answers = []
    threads = [threading.Thread(target=lambda w=f"낱말{n}가": answers.append(
        client.get("/api/search", params={"q": w}).status_code)) for n in range(6)]
    started = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert answers.count(503) >= 3  # 줄이 차면 기다리지 않고 바로 "잠시 뒤"(줄 선 요청이 작업자를 붙잡지 않게)
    assert time.monotonic() - started < 4  # 6개가 1초씩 줄 서지 않음


def test_one_network_guessing_from_the_internet_does_not_lock_out_everyone(site, monkeypatch):
    video_dir, data_dir, _, _ = site
    monkeypatch.setattr(server, "GUESSES_PER_HOUR", 5)
    secret = "s" * 40
    app = create_app(video_dir, data_dir, None, teacher_key="teacher-key-1234", entry_secret=secret)

    def from_(address):
        c = TestClient(app, client=(address, 1))
        c.cookies.set(server.PASS_COOKIE, server.make_pass(secret, time.time()))
        return c
    for n in range(12):  # 한 곳에서 주소를 바꿔 가며
        from_(f"203.0.113.{n}").post("/api/transfer/123456")
    assert from_("203.0.113.200").post("/api/transfer/654321").status_code == 429  # 그 망은 막힘

    code = from_("198.51.100.7").post("/api/transfer", json={"data": {"speed": 1.5}}).json()["code"]
    assert from_("198.51.100.8").post(f"/api/transfer/{code}").status_code == 200  # 다른 학생은 그대로


def test_internet_codes_cannot_fill_the_transfer_space_for_the_academy(site, monkeypatch):
    video_dir, data_dir, _, vid = site
    monkeypatch.setattr(server, "TRANSFER_BYTES", 40_000)
    secret = "s" * 40
    app = create_app(video_dir, data_dir, None, entry_secret=secret)
    outsider = TestClient(app, client=("203.0.113.5", 1))
    outsider.cookies.set(server.PASS_COOKIE, server.make_pass(secret, time.time()))
    big = {"data": {f"notes:{vid}": [{"t": 1, "text": "가" * 3000}]}}

    answers = [outsider.post("/api/transfer", json=big).status_code for _ in range(10)]

    assert 503 in answers  # 인터넷 몫이 차면 그 기기는 잠시 뒤
    assert TestClient(app, client=("192.168.0.9", 1)).post("/api/transfer", json=big).status_code == 200  # 학원 안은 그대로
    small = outsider.post("/api/transfer", json={"data": {"speed": 1.0}}).status_code
    assert small != 429  # 거절된 시도까지 세어 '너무 많이 만들었습니다'가 되지 않음


def test_an_unreadable_analysis_file_only_takes_that_lecture_out(site, monkeypatch):
    video_dir, data_dir, _, vid = site
    (video_dir / "2강.mp4").write_bytes(b"xy")
    other = next(v["id"] for v in find_videos(video_dir) if v["title"] == "2강")
    save_analysis(data_dir, other, {"title": "2강", "duration": 2.0, "segments": SEGMENTS, "guide": None})
    real = server.load_analysis

    def locked(d, video_id):
        if video_id == other:
            raise PermissionError(13, "Permission denied")  # 다른 계정이 만든 파일
        return real(d, video_id)
    monkeypatch.setattr(server, "load_analysis", locked)
    client = TestClient(create_app(video_dir, data_dir, None))

    assert {v["id"]: v["analyzed"] for v in client.get("/api/videos").json()} == {vid: True, other: False}
    assert client.get("/api/search", params={"q": "안녕하세요"}).status_code == 200
    assert client.get("/api/status").status_code == 200
    monkeypatch.setattr(server, "load_analysis", real)  # 권한을 고치면 다시 읽음(목록은 1분 안에)
    assert client.get("/api/status").json()["analyzed"] == 2


def test_only_device_transfer_takes_big_requests(site):
    video_dir, data_dir, _, vid = site
    client = TestClient(create_app(video_dir, data_dir, None))
    big = "가" * 120_000  # 약 360KB

    assert client.post("/api/quiz-result", content=json.dumps({"id": vid, "key": big, "right": True}),
                       headers={"content-type": "application/json"}).status_code == 413
    assert client.post("/api/transfer", json={"data": {"speed": 1.0, "other": big}}).status_code == 200


def test_a_made_up_lecture_number_does_not_throw_away_everyones_search_answers(site, monkeypatch):
    video_dir, data_dir, _, _ = site
    client = TestClient(create_app(video_dir, data_dir, None))
    client.get("/api/search", params={"q": "안녕하세요"})
    real_find, real_near, scans, searched = server.find_videos, server._near, [], []
    monkeypatch.setattr(server, "find_videos", lambda d: scans.append(1) or real_find(d))
    monkeypatch.setattr(server, "_near", lambda *a, **k: searched.append(1) or real_near(*a, **k))
    monkeypatch.setattr(server, "MISS_SECONDS", 0)

    client.get("/api/videos/0123456789ab")  # 없는 번호: 뒤에서 다시 훑음
    deadline = time.monotonic() + 5
    while not scans and time.monotonic() < deadline:
        time.sleep(0.02)
    time.sleep(0.1)
    answer = client.get("/api/search", params={"q": "안녕하세요"}).json()

    assert answer["exact"] and not searched  # 강의 목록이 그대로면 찾아 둔 답을 씀(다시 찾지 않음)


def test_an_infinite_length_written_by_hand_does_not_break_search_for_everyone(site):
    video_dir, data_dir, _, vid = site
    (video_dir / "2강.mp4").write_bytes(b"xy")
    other = next(v["id"] for v in find_videos(video_dir) if v["title"] == "2강")
    (data_dir / f"{other}.json").write_text('{"title": "2강", "duration": Infinity, "segments": '
                                            '[{"start": 0.0, "end": 2.0, "text": "안녕하세요"}], "guide": null}',
                                            encoding="utf-8")
    client = TestClient(create_app(video_dir, data_dir, None))

    assert client.get("/api/search", params={"q": "안녕하세요"}).status_code == 200


def test_the_proxy_address_is_recognized_when_the_server_listens_on_ipv6(site):
    video_dir, data_dir, _, _ = site
    app = create_app(video_dir, data_dir, None, entry_secret="s" * 40, proxy_addrs=("192.168.0.2",))

    # uvicorn --host :: 이면 IPv4 주소가 ::ffff:192.168.0.2 모양으로 옵니다
    assert TestClient(app, client=("::ffff:192.168.0.2", 1)).get("/api/videos").status_code == 401


# ---- 2단계 고친 것 다시 보기 ----

def internet(app, address, secret="s" * 40):
    c = TestClient(app, client=(address, 1))
    c.cookies.set(server.PASS_COOKIE, server.make_pass(secret, time.time()))
    return c


@pytest.fixture
def two(site):
    video_dir, data_dir, log_dir, vid = site
    (video_dir / "2강.mp4").write_bytes(b"xy")
    other = next(v["id"] for v in find_videos(video_dir) if v["title"] == "2강")
    save_analysis(data_dir, other, {"title": "2강", "duration": 3.0, "guide": None,
                                    "segments": [{"start": 0.0, "end": 3.0, "text": "여러분 안녕하세요 반갑습니다"}]})
    return video_dir, data_dir, log_dir, vid, other


@pytest.fixture
def jemang(tmp_path):  # 파일 이름으로 학원 정리 '제망매가'와 짝지어지는 강의(Claude 요점 정리 없음)
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    (video_dir / "고1").mkdir(parents=True)
    (video_dir / "고1" / "1강 제망매가.mp4").write_bytes(b"x")
    vid = find_videos(video_dir)[0]["id"]
    save_analysis(data_dir, vid, {"title": "강의", "duration": 2.0, "segments": SEGMENTS, "guide": None})
    return video_dir, data_dir, vid


def test_a_class_searching_the_same_word_at_once_all_get_the_answer(site, monkeypatch):
    video_dir, data_dir, _, _ = site
    client = TestClient(create_app(video_dir, data_dir, None))
    client.get("/api/videos")
    real_near = server._near
    monkeypatch.setattr(server, "_near", lambda *a, **k: time.sleep(1.0) or real_near(*a, **k))
    answers = []
    threads = [threading.Thread(target=lambda: answers.append(
        client.get("/api/search", params={"q": "안녕하세요"}).status_code)) for _ in range(10)]
    for t in threads:  # 선생님이 "제망매가 찾아 봐" 하면 반 학생이 한꺼번에 누름
        t.start()
    for t in threads:
        t.join()

    assert answers.count(200) == 10  # 한 번 찾은 답을 모두가 받음(줄이 찼다고 돌려보내지 않음)


def test_one_internet_network_cannot_take_every_internet_transfer_code(site):
    video_dir, data_dir, _, _ = site
    app = create_app(video_dir, data_dir, None, entry_secret="s" * 40)
    for n in range(10):  # 한 IPv6 집 회선(/64) 안의 주소 10개에서 작은 코드를 10개씩
        c = internet(app, f"2001:db8:1:2::{n + 1:x}")
        for _ in range(10):
            c.post("/api/transfer", json={"data": {}})

    other = internet(app, "198.51.100.7").post("/api/transfer", json={"data": {"speed": 1.5}})
    assert other.status_code == 200  # 다른 곳의 학생은 코드를 받음


def test_a_search_made_while_a_file_was_unreadable_is_not_kept_after_it_is_fixed(two, monkeypatch):
    video_dir, data_dir, _, vid, other = two
    real = server.load_analysis
    client = TestClient(create_app(video_dir, data_dir, None))
    monkeypatch.setattr(server, "load_analysis",
                        lambda d, i: (_ for _ in ()).throw(PermissionError(13, "Permission denied")) if i == other
                        else real(d, i))
    assert len(client.get("/api/search", params={"q": "안녕하세요"}).json()["exact"]) == 1
    monkeypatch.setattr(server, "load_analysis", real)  # 권한을 고침(파일 시각·크기는 그대로)

    found = client.get("/api/search", params={"q": "안녕하세요"}).json()["exact"]
    assert {r["id"] for r in found} == {vid, other}


def test_quiz_results_are_counted_again_once_the_analysis_file_is_readable(site, monkeypatch):
    video_dir, data_dir, log_dir, vid = site
    real = server.load_analysis
    client = TestClient(create_app(video_dir, data_dir, None, log_dir=log_dir), client=("192.168.0.5", 1))
    monkeypatch.setattr(server, "load_analysis", lambda d, i: (_ for _ in ()).throw(OSError(5, "Input/output error")))
    client.post("/api/quiz-result", json={"id": vid, "key": "제망매가의 갈래는?", "right": False})
    monkeypatch.setattr(server, "load_analysis", real)  # NAS가 돌아옴

    client.post("/api/quiz-result", json={"id": vid, "key": "제망매가의 갈래는?", "right": False})
    assert len((log_dir / "quiz.log").read_text().splitlines()) == 1


def test_a_broken_analysis_file_is_read_once_not_on_every_request(two, monkeypatch):
    video_dir, data_dir, _, _, other = two
    (data_dir / f"{other}.json").write_text('{"title": "2강", "segments": [', encoding="utf-8")  # 저장하다 끊김
    real, reads = server.load_analysis, []
    monkeypatch.setattr(server, "load_analysis", lambda d, i: (i == other and reads.append(1)) or real(d, i))
    client = TestClient(create_app(video_dir, data_dir, None))
    for word in ["안녕하세요", "반갑습니다", "여러분"]:
        client.get("/api/status")
        client.get("/api/search", params={"q": word})

    assert len(reads) == 1


def test_an_infinite_failure_count_written_by_hand_does_not_break_the_list_for_everyone(two):
    video_dir, data_dir, _, _, other = two
    (data_dir / f"{other}.json").write_text(
        '{"title": "2강", "duration": 3.0, "guide": null, "guide_failures": Infinity, '
        '"segments": [{"start": 0.0, "end": 2.0, "text": "안녕하세요"}]}', encoding="utf-8")
    client = TestClient(create_app(video_dir, data_dir, None), raise_server_exceptions=False)

    assert [client.get("/api/videos").status_code, client.get("/api/search", params={"q": "안녕하세요"}).status_code,
            client.get("/api/status").status_code] == [200, 200, 200]


def test_a_lecture_with_an_infinite_length_still_opens_in_the_player(two):
    video_dir, data_dir, _, _, other = two
    (data_dir / f"{other}.json").write_text('{"title": "2강", "duration": Infinity, "segments": '
                                            '[{"start": 0.0, "end": 2.0, "text": "안녕하세요"}], "guide": null}',
                                            encoding="utf-8")
    client = TestClient(create_app(video_dir, data_dir, None), raise_server_exceptions=False)

    res = client.get(f"/api/videos/{other}")
    assert res.status_code == 200 and res.json()["analysis"] is None  # 목록처럼 '분석 전'


def test_a_listed_video_the_nas_cannot_open_right_now_is_worth_trying_again(site):
    video_dir, data_dir, _, vid = site
    client = TestClient(create_app(video_dir, data_dir, None))
    client.get("/api/videos")
    (video_dir / "1강.mp4").rename(video_dir / "1강.tmp")  # NAS가 잠깐 끊김: 목록에는 있는데 열리지 않음

    assert client.get(f"/media/{vid}").status_code == 503  # 플레이어가 다시 받아 봄(404면 '찾을 수 없습니다'로 그만둠)
    (video_dir / "1강.tmp").rename(video_dir / "1강.mp4")
    assert client.get(f"/media/{vid}").status_code == 200


def test_lectures_are_worth_trying_again_while_the_video_folder_looks_empty(tmp_path):
    (tmp_path / "videos").mkdir()  # 서버가 NAS보다 먼저 켜짐
    client = TestClient(create_app(tmp_path / "videos", tmp_path / "data", None))

    assert client.get("/media/0123456789ab").status_code == 503
    assert client.get("/api/videos/0123456789ab").status_code == 503


def test_hiding_one_of_two_near_identical_fill_ins_keeps_the_other_in_the_quiz(jemang):
    video_dir, data_dir, vid = jemang
    ref = {"title": "제망매가", "grade": "고1", "meta": {"갈래": "향가"},  # PDF에서 두 번 뽑힌 빈칸 문제(끝 마침표만 다름)
           "fillins": [{"passage": "누이의 죽음", "answer_line": "슬픔을   종교적  으로 극복함"},
                       {"passage": "누이의 죽음", "answer_line": "슬픔을   종교적  으로 극복함."}]}
    key = ref_key(ref)
    client = TestClient(create_app(video_dir, data_dir, None, [ref], teacher_key="teacher-key-1234"),
                        client=("192.168.0.5", 1))
    fills = next(s for s in client.get(f"/api/references/{key}").json()["sections"] if s["name"] == "빈칸 문제")["items"]
    client.put(f"/api/references/{key}/fix", json={"section": "빈칸 문제", "original": fills[1]["original"], "hidden": True},
               headers={"x-teacher-key": "teacher-key-1234"})

    assert len(client.get(f"/api/videos/{vid}").json()["references"][0]["quiz"]) == 1  # 숨기지 않은 하나는 남음


def flaky_reads(monkeypatch, name, fail_on):
    """name 파일을 읽을 때 fail_on번째(1부터) 읽기에서 입출력 오류(NAS가 잠깐 답하지 않음)."""
    import pathlib
    real, state = pathlib.Path.read_text, {"reads": 0, "armed": False}

    def read_text(self, *a, **k):
        if self.name == name and state["armed"]:
            state["reads"] += 1
            if state["reads"] in fail_on:
                raise OSError(5, "Input/output error")
        return real(self, *a, **k)
    monkeypatch.setattr(pathlib.Path, "read_text", read_text)
    return state


def test_one_nas_read_error_does_not_bring_back_what_the_teacher_hid(jemang, monkeypatch):
    video_dir, data_dir, vid = jemang
    ref = {"title": "제망매가", "grade": "고1", "features": [{"text": "틀린 설명"}, {"text": "향가"}]}
    (data_dir / ".reference-fixes").write_text(json.dumps({ref_key(ref): {"핵심 특징": {"틀린 설명": {"hidden": True}}}},
                                                          ensure_ascii=False), encoding="utf-8")
    state = flaky_reads(monkeypatch, ".reference-fixes", fail_on={1})
    client = TestClient(create_app(video_dir, data_dir, None, [ref]), client=("192.168.0.5", 1))
    state["armed"] = True
    client.get("/api/videos")  # 이 읽기만 NAS가 답하지 않음

    assert client.get(f"/api/videos/{vid}").json()["references"][0]["sections"][0]["items"] == ["향가"]
    assert client.get("/api/search", params={"q": "틀린설명"}).json()["notes"] == []


def test_a_read_error_while_saving_a_fix_does_not_erase_the_other_fixes(jemang, monkeypatch):
    video_dir, data_dir, _ = jemang
    ref = {"title": "제망매가", "grade": "고1", "features": [{"text": "틀린 설명"}, {"text": "향가"}]}
    before = {ref_key(ref): {"핵심 특징": {"틀린 설명": {"hidden": True}}}, "other-ref": {"어휘": {"x": {"hidden": True}}}}
    (data_dir / ".reference-fixes").write_text(json.dumps(before, ensure_ascii=False), encoding="utf-8")
    client = TestClient(create_app(video_dir, data_dir, None, [ref], teacher_key="teacher-key-1234"),
                        client=("192.168.0.5", 1))
    state = flaky_reads(monkeypatch, ".reference-fixes", fail_on={2})
    state["armed"] = True
    client.put(f"/api/references/{ref_key(ref)}/fix", json={"section": "핵심 특징", "original": "향가", "text": "향가(신라)"},
               headers={"x-teacher-key": "teacher-key-1234"})
    state["armed"] = False

    saved = json.loads((data_dir / ".reference-fixes").read_text(encoding="utf-8"))
    assert "other-ref" in saved and "틀린 설명" in saved[ref_key(ref)]["핵심 특징"]


def test_a_fix_written_by_hand_with_a_number_for_text_does_not_break_search(jemang):
    video_dir, data_dir, vid = jemang
    ref = {"title": "제망매가", "grade": "고1", "features": [{"text": "누이의 죽음"}]}
    (data_dir / ".reference-fixes").write_text(
        json.dumps({ref_key(ref): {"핵심 특징": {"누이의 죽음": {"text": 3}}}}), encoding="utf-8")
    client = TestClient(create_app(video_dir, data_dir, None, [ref]), client=("192.168.0.5", 1),
                        raise_server_exceptions=False)

    assert client.get("/api/search", params={"q": "향가입니다"}).status_code == 200
    assert client.get(f"/api/videos/{vid}").json()["references"][0]["sections"][0]["items"] == ["누이의 죽음"]
