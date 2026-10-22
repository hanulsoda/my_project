import threading
import time

import pytest
from fastapi.testclient import TestClient

from academy import server
from academy.library import find_videos, save_analysis
from academy.server import create_app

SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "안녕하세요"}]
GUIDE = {"summary": "요약", "chapters": [], "quiz": []}


@pytest.fixture
def setup(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    (video_dir / "1강.mp4").write_bytes(bytes(range(256)) * 4)
    (video_dir / "2강.mp4").write_bytes(b"x")
    ids = {v["title"]: v["id"] for v in find_videos(video_dir)}
    save_analysis(data_dir, ids["1강"], {"title": "1강", "duration": 2.0,
                                          "segments": SEGMENTS, "guide": GUIDE})
    calls = []

    def answer(title, segments, question, history, current_time):
        calls.append((title, segments, question, history, current_time))
        return "답변 [00:00]"

    client = TestClient(create_app(video_dir, data_dir, answer))
    return client, ids, calls


def count_scans(monkeypatch):
    scans, real = [], server.find_videos
    monkeypatch.setattr(server, "find_videos", lambda d: scans.append(d) or real(d))
    return scans


def fake_clock(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(server, "monotonic", lambda: clock[0])
    return clock


def test_scans_video_folder_once_for_many_requests(setup, monkeypatch):
    client, ids, _ = setup
    scans = count_scans(monkeypatch)

    client.get("/api/videos")
    client.get(f"/api/videos/{ids['1강']}")
    client.get(f"/media/{ids['1강']}", headers={"Range": "bytes=0-9"})
    client.get(f"/media/{ids['1강']}", headers={"Range": "bytes=10-19"})
    client.get(f"/api/videos/{ids['1강']}/pages/0.jpg")
    client.post(f"/api/videos/{ids['1강']}/ask", json={"question": "질문"})

    assert len(scans) == 1


def test_finds_new_video_on_cache_miss_but_not_rescanning_every_miss(setup, monkeypatch, tmp_path):
    client, _, _ = setup
    scans, clock = count_scans(monkeypatch), fake_clock(monkeypatch)
    client.get("/api/videos")
    (tmp_path / "videos" / "3강.mp4").write_bytes(b"x")
    new_id = next(v["id"] for v in find_videos(tmp_path / "videos") if v["title"] == "3강")

    clock[0] += server.MISS_SECONDS + 1
    assert client.get(f"/api/videos/{new_id}").status_code == 200
    assert client.get("/api/videos/nope").status_code == 404
    assert client.get("/media/nope").status_code == 404

    assert len(scans) == 2
    assert [v["title"] for v in client.get("/api/videos").json()] == ["1강", "2강", "3강"]


def test_serves_old_list_while_rescanning_in_background(setup, monkeypatch, tmp_path):
    client, _, _ = setup
    clock = fake_clock(monkeypatch)
    client.get("/api/videos")
    (tmp_path / "videos" / "3강.mp4").write_bytes(b"x")
    rescan_may_finish, real = threading.Event(), server.find_videos
    monkeypatch.setattr(server, "find_videos", lambda d: rescan_may_finish.wait(5) and real(d))

    clock[0] += server.REFRESH_SECONDS + 1
    assert len(client.get("/api/videos").json()) == 2  # 느린 재스캔을 기다리지 않습니다

    rescan_may_finish.set()
    deadline = time.monotonic() + 5
    while len(client.get("/api/videos").json()) < 3 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert len(client.get("/api/videos").json()) == 3


def test_prepares_the_list_in_the_background_when_the_server_starts(tmp_path, monkeypatch):
    video_dir = tmp_path / "videos"
    video_dir.mkdir()
    (video_dir / "제망매가.mp4").write_bytes(b"x")
    save_analysis(tmp_path / "data", find_videos(video_dir)[0]["id"], {"title": "제망매가", "segments": SEGMENTS})
    scans, matched, real = count_scans(monkeypatch), [], server.find_references
    monkeypatch.setattr(server, "find_references", lambda *a: matched.append(a) or real(*a))

    with TestClient(create_app(video_dir, tmp_path / "data", None, [{"title": "제망매가", "grade": "고1", "meta": {"갈래": "향가"}}])):
        deadline = time.monotonic() + 5
        while not matched and time.monotonic() < deadline:
            time.sleep(0.01)

    # 아무도 목록을 열지 않았는데 영상 폴더를 훑고 학원 정리까지 짝지어 두었습니다.
    assert len(scans) == 1 and len(matched) == 1


def test_lists_videos_with_analysis_and_guide_status(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    for name in ["1강.mp4", "2강.mp4", "3강.mp4"]:
        (video_dir / name).write_bytes(b"x")
    ids = {v["title"]: v["id"] for v in find_videos(video_dir)}
    save_analysis(data_dir, ids["1강"], {"title": "1강", "segments": SEGMENTS, "guide": GUIDE})
    save_analysis(data_dir, ids["2강"], {"title": "2강", "segments": SEGMENTS, "guide": None,
                                          "toc": {"model": "m", "chapters": [{"start": 0.0, "title": "도입"}]}})
    client = TestClient(create_app(video_dir, data_dir, None))

    assert client.get("/api/videos").json() == [
        {"id": ids["1강"], "title": "1강", "analyzed": True, "guide": True, "toc": False},
        {"id": ids["2강"], "title": "2강", "analyzed": True, "guide": False, "toc": True},  # 로컬 AI 자동 목차
        {"id": ids["3강"], "title": "3강", "analyzed": False, "guide": False, "toc": False},
    ]

    save_analysis(data_dir, ids["2강"], {"title": "2강", "segments": SEGMENTS, "guide": GUIDE})
    assert client.get("/api/videos").json()[1]["guide"] is True


def test_lectures_without_a_guide_show_the_academy_summary_as_is(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    (video_dir / "고1").mkdir(parents=True)
    for name in ["제망매가 학습활동", "속미인곡 학습활동", "1강"]:
        (video_dir / "고1" / f"{name}.mp4").write_bytes(b"x")
    ids = {v["title"]: v["id"] for v in find_videos(video_dir)}
    for title, guide in [("고1/제망매가 학습활동", None), ("고1/속미인곡 학습활동", GUIDE), ("고1/1강", None)]:
        said = [{"start": 30.0, "end": 35.0, "text": "이 작품의 갈래 향가"}] if "제망매가" in title else SEGMENTS
        save_analysis(data_dir, ids[title], {"title": title, "segments": said, "guide": guide})
    refs = [{"title": "제망매가", "grade": "고1", "meta": {"갈래": "향가"},
             "fillins": [{"passage": "누이의 죽음", "answer_line": "슬픔을   종교적  으로 극복함"}]},
            {"title": "속미인곡", "grade": "고1", "meta": {"갈래": "가사"}}]
    client = TestClient(create_app(video_dir, data_dir, None, refs))
    references = lambda title: client.get(f"/api/videos/{ids[title]}").json()["references"]

    # 빈칸 문제는 답이 미리 보이지 않게 요점 정리에서 빼고 퀴즈로 보냅니다. 항목마다 대본에서 찾은 시간이 붙습니다.
    assert references("고1/제망매가 학습활동") == [
        {"source": "고1 「제망매가」", "sections": [{"name": "개요", "items": ["갈래: 향가"], "times": [30.0]}],
         "quiz": [{"context": "누이의 죽음", "parts": ["슬픔을", "종교적", "으로 극복함"]}]}]
    assert references("고1/속미인곡 학습활동") == []  # 학원 정리를 바탕으로 만든 Claude 요점 정리가 이미 있습니다
    assert references("고1/1강") == []
    assert {v["title"]: v["guide"] for v in client.get("/api/videos").json()} == {
        "고1/1강": False, "고1/속미인곡 학습활동": True, "고1/제망매가 학습활동": True}


def test_serves_page_thumbnails(setup, tmp_path):
    client, ids, _ = setup
    thumbs = tmp_path / "data" / ids["1강"]
    thumbs.mkdir()
    (thumbs / "0.jpg").write_bytes(b"\xff\xd8jpeg")

    res = client.get(f"/api/videos/{ids['1강']}/pages/0.jpg")

    assert res.content == b"\xff\xd8jpeg"
    assert res.headers["content-type"] == "image/jpeg"
    assert client.get(f"/api/videos/{ids['1강']}/pages/1.jpg").status_code == 404
    assert client.get(f"/api/videos/{ids['1강']}/pages/..%2Fx.jpg").status_code in (404, 422)
    assert client.get("/api/videos/nope/pages/0.jpg").status_code == 404


def test_video_detail(setup):
    client, ids, _ = setup

    analyzed = client.get(f"/api/videos/{ids['1강']}").json()
    not_yet = client.get(f"/api/videos/{ids['2강']}").json()

    assert analyzed["title"] == "1강"
    assert analyzed["analysis"]["guide"] == GUIDE
    assert "segments" not in analyzed["analysis"]  # 받아쓰기 대본은 학생 브라우저로 보내지 않습니다
    assert not_yet == {"id": ids["2강"], "title": "2강", "analysis": None, "references": []}
    assert client.get("/api/videos/nope").status_code == 404


def test_media_supports_range_requests_for_seeking(setup):
    client, ids, _ = setup

    res = client.get(f"/media/{ids['1강']}", headers={"Range": "bytes=100-199"})

    assert res.status_code == 206
    assert res.content == (bytes(range(256)) * 4)[100:200]
    assert client.get("/media/../1강.mp4").status_code == 404


def test_ask_passes_question_to_tutor(setup):
    client, ids, calls = setup
    history = [{"role": "user", "content": "앞 질문"}, {"role": "assistant", "content": "앞 답"}]

    res = client.post(f"/api/videos/{ids['1강']}/ask",
                      json={"question": "무슨 뜻이에요?", "history": history, "current_time": 1.5})

    assert res.json() == {"answer": "답변 [00:00]"}
    assert calls == [("1강", SEGMENTS, "무슨 뜻이에요?", history, 1.5)]


def test_ask_rejects_bad_requests(setup):
    client, ids, calls = setup

    assert client.post(f"/api/videos/{ids['2강']}/ask", json={"question": "질문"}).status_code == 409
    assert client.post(f"/api/videos/{ids['1강']}/ask", json={"question": ""}).status_code == 422
    assert calls == []


def test_ask_reports_ai_failure_clearly(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    (video_dir / "1강.mp4").write_bytes(b"x")
    video_id = find_videos(video_dir)[0]["id"]
    save_analysis(data_dir, video_id, {"title": "1강", "segments": SEGMENTS, "guide": GUIDE})

    def broken_answer(*args):
        raise TypeError("Could not resolve authentication method")  # API 키가 없을 때 SDK가 내는 오류

    client = TestClient(create_app(video_dir, data_dir, broken_answer))
    res = client.post(f"/api/videos/{video_id}/ask", json={"question": "질문"})

    assert res.status_code == 502
    assert "authentication" in res.json()["detail"]


def test_student_server_does_not_take_questions():
    # 질문하기는 Claude API 크레딧을 써서 막아 두었습니다. 학생 서버로 띄우는 server.app 그대로 확인합니다.
    res = TestClient(server.app).post("/api/videos/any/ask", json={"question": "질문"})

    assert res.status_code == 403
    assert "질문하기" in res.json()["detail"]


def test_serves_student_pages(setup):
    client, _, _ = setup

    assert "<html" in client.get("/").text
    assert client.get("/watch.html").status_code == 200


def test_student_pages_are_revalidated_so_updates_reach_browsers(setup):
    client, _, _ = setup

    for path in ["/", "/watch.html", "/watch.js"]:
        assert client.get(path).headers["cache-control"] == "no-cache"


def test_video_detail_sends_page_labels_but_not_screen_text(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    (video_dir / "1강.mp4").write_bytes(b"x")
    video_id = find_videos(video_dir)[0]["id"]
    save_analysis(data_dir, video_id, {"title": "1강", "duration": 9.0, "segments": SEGMENTS, "guide": GUIDE,
                                       "pages": [{"start": 0.0, "text": ["교재 글자"], "label": "12쪽 · 도입"}]})
    client = TestClient(create_app(video_dir, data_dir, None))

    pages = client.get(f"/api/videos/{video_id}").json()["analysis"]["pages"]

    assert pages == [{"start": 0.0, "label": "12쪽 · 도입"}]


def test_video_detail_keeps_teacher_only_edits_on_the_server(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    (video_dir / "1강.mp4").write_bytes(b"x")
    video_id = find_videos(video_dir)[0]["id"]
    guide = {**GUIDE, "overview": [{"name": "갈래", "value": "수필"}],
             "edits": [{"before": "엉뚱한 항목", "after": "", "reason": "다른 단원"}]}
    save_analysis(data_dir, video_id, {"title": "1강", "duration": 9.0, "segments": SEGMENTS, "guide": guide})
    client = TestClient(create_app(video_dir, data_dir, None))

    sent = client.get(f"/api/videos/{video_id}").json()["analysis"]["guide"]

    assert "edits" not in sent
    assert sent["overview"] == [{"name": "갈래", "value": "수필"}]
