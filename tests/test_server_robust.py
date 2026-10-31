"""저쪽(z840-player) 서버 기능의 버그 찾기에서 나온 경우들."""

import pytest
from fastapi.testclient import TestClient

import academy.server as server
from academy.library import find_videos, save_analysis
from academy.server import create_app

LAN = ("192.168.0.5", 50000)
SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "안녕하세요"}]


@pytest.fixture
def two_lectures(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    for name in ["1강.mp4", "2강.mp4"]:
        (video_dir / name).write_bytes(b"x")
    ids = [v["id"] for v in find_videos(video_dir)]
    for video_id in ids:
        save_analysis(data_dir, video_id, {"title": "강의", "duration": 2.0, "segments": SEGMENTS, "guide": None})
    return video_dir, data_dir, ids


def test_a_nas_blip_does_not_empty_the_lecture_list(two_lectures, monkeypatch, caplog):
    video_dir, data_dir, ids = two_lectures
    clock = [1000.0]
    monkeypatch.setattr(server, "monotonic", lambda: clock[0])
    client = TestClient(create_app(video_dir, data_dir, None), client=LAN)
    assert len(client.get("/api/videos").json()) == 2

    monkeypatch.setattr(server, "find_videos", lambda d: [])  # NAS 연결이 잠깐 끊겨 영상 폴더가 비어 보임
    clock[0] += server.MISS_SECONDS + 1
    client.get("/api/videos/모르는강의")  # 처음 보는 강의라 그 자리에서 다시 훑음

    assert len(client.get("/api/videos").json()) == 2  # 이전 목록을 그대로 씀
    assert client.get(f"/api/videos/{ids[0]}").status_code == 200
    assert "비어" in caplog.text


def test_hidden_or_fixed_words_are_not_asked_in_the_quiz(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    (video_dir / "제망매가.mp4").write_bytes(b"x")
    video_id = find_videos(video_dir)[0]["id"]
    save_analysis(data_dir, video_id, {"title": "제망매가", "duration": 2.0, "segments": SEGMENTS, "guide": None})
    refs = [{"title": "제망매가", "grade": "고1", "words": [{"w": f"낱말{n}", "pos": "명사", "def": f"뜻{n}"} for n in range(1, 6)]}]
    client = TestClient(create_app(video_dir, data_dir, None, refs, teacher_key="teacher-key-123"), client=LAN)
    key = client.get("/api/references").json()[0]["key"]
    words = next(s for s in client.get(f"/api/references/{key}").json()["sections"] if s["name"] == "어휘")["items"]
    teacher = {"x-teacher-key": "teacher-key-123"}
    hidden, fixed = words[2]["original"], words[3]["original"]
    assert client.put(f"/api/references/{key}/fix", json={"section": "어휘", "original": hidden, "hidden": True},
                      headers=teacher).status_code == 200
    assert client.put(f"/api/references/{key}/fix", json={"section": "어휘", "original": fixed, "text": "낱말4(명사): 바로잡은 뜻"},
                      headers=teacher).status_code == 200

    quiz = client.get(f"/api/videos/{video_id}").json()["references"][0]["quiz"]
    asked = [q["question"] for q in quiz if "choices" in q]

    assert "‘낱말3’의 뜻으로 알맞은 것은?" not in asked  # 선생님이 숨긴 낱말
    assert "‘낱말4’의 뜻으로 알맞은 것은?" not in asked  # 선생님이 뜻을 고친 낱말(예전 뜻이 정답으로 나오면 안 됨)
    assert "‘낱말1’의 뜻으로 알맞은 것은?" in asked


def test_teacher_picks_saved_at_the_same_time_all_succeed(two_lectures):
    import threading

    video_dir, data_dir, ids = two_lectures
    client = TestClient(create_app(video_dir, data_dir, None, teacher_key="teacher-key-123"), client=LAN)
    codes, start = [], threading.Barrier(12)

    def save():
        start.wait()
        codes.append(client.put("/api/picks", json={"ids": ids}, headers={"x-teacher-key": "teacher-key-123"}).status_code)

    workers = [threading.Thread(target=save) for _ in range(12)]
    for w in workers:
        w.start()
    for w in workers:
        w.join(10)

    assert codes == [200] * 12  # 두 선생님 PC에서 거의 동시에 저장해도 오류 없이


@pytest.mark.parametrize("text", ["[]", "3", '"글"'], ids=["list", "number", "string"])
def test_an_analysis_that_is_not_an_object_only_takes_that_lecture_out(two_lectures, text):
    video_dir, data_dir, ids = two_lectures
    (data_dir / f"{ids[0]}.json").write_text(text, encoding="utf-8")  # 손으로 고치다 내용을 통째로 바꿈
    client = TestClient(create_app(video_dir, data_dir, None), client=LAN)

    listed = client.get("/api/videos")

    assert listed.status_code == 200 and [v["analyzed"] for v in listed.json()] == [False, True]
    assert client.get("/api/search", params={"q": "안녕하세요"}).status_code == 200
    assert client.get("/api/status").status_code == 200
    assert client.get(f"/api/videos/{ids[0]}").json()["analysis"] is None


def test_toc_titles_keep_the_spacing_of_the_work_name():
    # 받아쓰기가 '운수 좋은 날'을 '운수 조은 날'로 적었을 때, 바로잡으면서 띄어쓰기를 지우지 않습니다.
    assert server._respell("운수 조은 날의 결말", "고1/운수 좋은 날") == "운수 좋은 날의 결말"
    assert server._respell("성의 꽃 감상", "고1/성에꽃") == "성에꽃 감상"


def test_one_odd_summary_does_not_stop_the_lecture_list(two_lectures):
    video_dir, data_dir, ids = two_lectures
    refs = [{"title": "1강", "grade": "고1", "meta": ["가사"]},  # 손으로 고치다 모양이 바뀐 정리
            {"title": "2강", "grade": "고1", "persons": ["김첨지: 인력거꾼"]}]
    client = TestClient(create_app(video_dir, data_dir, None, refs), client=LAN)

    for path in ["/api/videos", f"/api/videos/{ids[0]}", "/api/references", "/api/status", "/api/search?q=안녕하세요"]:
        assert client.get(path).status_code == 200, path
    assert [r["title"] for r in client.get("/api/references").json()] == ["2강"]


def test_a_summary_with_only_fill_ins_gives_a_quiz_but_does_not_count_as_a_summary(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    (video_dir / "고1").mkdir(parents=True)
    (video_dir / "고1" / "청산별곡.mp4").write_bytes(b"x")
    video_id = find_videos(video_dir)[0]["id"]
    save_analysis(data_dir, video_id, {"title": "고1/청산별곡", "duration": 2.0, "segments": SEGMENTS, "guide": None})
    ref = {"title": "청산별곡", "grade": "고1", "fillins": [{"passage": "청산", "answer_line": "청산에   살어리랏다  "}]}
    client = TestClient(create_app(video_dir, data_dir, None, [ref]), client=LAN)

    assert client.get("/api/videos").json()[0]["guide"] is False  # 목록에 '요점 정리' 배지를 달지 않음
    assert client.get("/api/status").json()["summary"] == 0
    assert client.get(f"/api/videos/{video_id}").json()["references"][0]["quiz"]  # 빈칸 문제는 퀴즈로 그대로


def test_mac_file_names_are_listed_like_any_other(tmp_path):
    import unicodedata
    video_dir = tmp_path / "videos"
    (video_dir / "고1").mkdir(parents=True)
    (video_dir / "고1" / unicodedata.normalize("NFD", "제망매가.mp4")).write_bytes(b"x")  # 맥에서 옮긴 이름(자모로 나뉨)

    title = find_videos(video_dir)[0]["title"]

    assert title == "고1/제망매가"  # 학생이 친 '제망매가'로 찾을 수 있게


def test_a_log_folder_that_does_not_exist_yet_does_not_stop_students(two_lectures, tmp_path):
    video_dir, data_dir, ids = two_lectures
    log_dir = tmp_path / "아직 없는 로그"
    client = TestClient(create_app(video_dir, data_dir, None, log_dir=log_dir), client=LAN)

    assert client.get(f"/api/videos/{ids[0]}", params={"view": 1}).status_code == 200  # 플레이어가 강의를 엶
    assert client.post("/api/quiz-result", json={"id": ids[0], "key": "Q1", "right": True}).status_code == 204
    assert (log_dir / "usage.log").exists()  # 켤 때 만들어 둠


def test_an_unwritable_log_folder_only_loses_the_log_line(two_lectures, tmp_path, caplog):
    video_dir, data_dir, ids = two_lectures
    blocked = tmp_path / "logs"
    blocked.write_text("폴더가 아니라 파일")  # 쓸 수 없는 로그 자리
    client = TestClient(create_app(video_dir, data_dir, None, log_dir=blocked), client=LAN)

    assert client.get(f"/api/videos/{ids[0]}", params={"view": 1}).status_code == 200
    assert client.post("/api/quiz-result", json={"id": ids[0], "key": "Q1", "right": True}).status_code == 204
    assert "로그" in caplog.text


def test_usage_ignore_accepts_spaces_after_commas(monkeypatch):
    from academy.server import _ignored_hosts

    assert _ignored_hosts("192.168.0.6, 192.168.0.7 ,") == ("192.168.0.6", "192.168.0.7")
