import pytest
from fastapi.testclient import TestClient

from academy.library import find_videos, save_analysis, save_frame
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


def test_lists_videos_with_analysis_status(setup):
    client, ids, _ = setup

    res = client.get("/api/videos")

    assert res.json() == [
        {"id": ids["1강"], "title": "1강", "analyzed": True},
        {"id": ids["2강"], "title": "2강", "analyzed": False},
    ]


def test_video_detail(setup):
    client, ids, _ = setup

    analyzed = client.get(f"/api/videos/{ids['1강']}").json()
    not_yet = client.get(f"/api/videos/{ids['2강']}").json()

    assert analyzed["title"] == "1강"
    assert analyzed["analysis"]["guide"] == GUIDE
    assert not_yet == {"id": ids["2강"], "title": "2강", "analysis": None}
    assert client.get("/api/videos/nope").status_code == 404


def test_media_supports_range_requests_for_seeking(setup):
    client, ids, _ = setup

    res = client.get(f"/media/{ids['1강']}", headers={"Range": "bytes=100-199"})

    assert res.status_code == 206
    assert res.content == (bytes(range(256)) * 4)[100:200]
    assert client.get("/media/../1강.mp4").status_code == 404


def test_serves_board_photo(setup, tmp_path):
    client, ids, _ = setup
    save_frame(tmp_path / "data", ids["1강"], 60, b"\xff\xd8x")

    res = client.get(f"/frames/{ids['1강']}/60.jpg")

    assert res.status_code == 200
    assert res.headers["content-type"] == "image/jpeg"
    assert res.content == b"\xff\xd8x"


@pytest.mark.parametrize("name", ["61.jpg", "abc.jpg", "60.png", "..%2F..%2F1강.json"])
def test_board_photo_rejects_bad_requests(setup, tmp_path, name):
    client, ids, _ = setup
    save_frame(tmp_path / "data", ids["1강"], 60, b"\xff\xd8x")

    assert client.get(f"/frames/{ids['1강']}/{name}").status_code == 404
    assert client.get("/frames/nope/60.jpg").status_code == 404


def test_subtitles_are_webvtt_made_from_transcript(setup, tmp_path):
    client, ids, _ = setup
    save_analysis(tmp_path / "data", ids["1강"], {"title": "1강", "guide": GUIDE, "segments": [
        {"start": 0.0, "end": 2.0, "text": "안녕하세요"},
        {"start": 3661.5, "end": 3663.25, "text": "a < b & c --> d"},  # 자막 문법 기호가 섞인 대본
    ]})

    res = client.get(f"/api/videos/{ids['1강']}/subtitles.vtt")

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/vtt")
    assert res.text == ("WEBVTT\n\n"
                        "00:00:00.000 --> 00:00:02.000\n안녕하세요\n\n"
                        "01:01:01.500 --> 01:01:03.250\na &lt; b &amp; c --&gt; d\n")


def test_subtitles_survive_hand_edited_transcript(setup, tmp_path):
    client, ids, _ = setup
    save_analysis(tmp_path / "data", ids["1강"], {"title": "1강", "guide": GUIDE, "segments": [
        {"start": 0.0, "text": "끝 시각을 지운 줄"},
        {"start": 10.0, "end": 12.0, "text": "첫 줄\n\n둘째 줄"},  # 빈 줄이 있으면 자막이 거기서 끊김
    ]})

    res = client.get(f"/api/videos/{ids['1강']}/subtitles.vtt")

    assert res.status_code == 200
    assert res.text == ("WEBVTT\n\n"
                        "00:00:00.000 --> 00:00:05.000\n끝 시각을 지운 줄\n\n"
                        "00:00:10.000 --> 00:00:12.000\n첫 줄 둘째 줄\n")


def test_no_subtitles_before_analysis(setup):
    client, ids, _ = setup

    assert client.get(f"/api/videos/{ids['2강']}/subtitles.vtt").status_code == 404
    assert client.get("/api/videos/nope/subtitles.vtt").status_code == 404


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


def test_serves_student_pages(setup):
    client, _, _ = setup

    assert "<html" in client.get("/").text
    assert client.get("/watch.html").status_code == 200
