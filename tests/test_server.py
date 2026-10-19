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
        {"start": 20.0, "end": None, "text": "끝 시각을 비운 줄"},
    ]})

    res = client.get(f"/api/videos/{ids['1강']}/subtitles.vtt")

    assert res.status_code == 200
    assert res.text == ("WEBVTT\n\n"
                        "00:00:00.000 --> 00:00:05.000\n끝 시각을 지운 줄\n\n"
                        "00:00:10.000 --> 00:00:12.000\n첫 줄 둘째 줄\n\n"
                        "00:00:20.000 --> 00:00:25.000\n끝 시각을 비운 줄\n")


def test_no_subtitles_before_analysis(setup):
    client, ids, _ = setup

    assert client.get(f"/api/videos/{ids['2강']}/subtitles.vtt").status_code == 404
    assert client.get("/api/videos/nope/subtitles.vtt").status_code == 404


def test_search_finds_scenes_across_lectures(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    for name in ("1강", "2강", "3강"):
        (video_dir / f"{name}.mp4").write_bytes(b"x")
    ids = {v["title"]: v["id"] for v in find_videos(video_dir)}
    save_analysis(data_dir, ids["1강"], {"title": "1강", "segments": [
        {"start": 10.0, "end": 12.0, "text": "근의 공식을 유도합니다"},
        {"start": 20.0, "end": 22.0, "text": "다른 이야기"},
    ], "guide": {"summary": "", "quiz": [], "chapters": [
        {"start": 5, "title": "근의 공식", "points": ["판별식 b²-4ac"], "board": None}]}})
    save_analysis(data_dir, ids["2강"], {"title": "2강", "guide": None, "segments": [
        {"start": float(i), "end": i + 1.0, "text": f"근의 공식 {i}번째"} for i in range(7)]})
    # 3강은 분석 전 (JSON 없음)
    client = TestClient(create_app(video_dir, data_dir, lambda *a: ""))

    res = client.get("/api/search", params={"q": "근의 공식"}).json()

    assert res == [
        {"id": ids["1강"], "title": "1강", "total": 2, "hits": [
            {"start": 5, "text": "근의 공식"},
            {"start": 10.0, "text": "근의 공식을 유도합니다"}]},
        {"id": ids["2강"], "title": "2강", "total": 7, "hits": [
            {"start": float(i), "text": f"근의 공식 {i}번째"} for i in range(5)]},
    ]
    assert client.get("/api/search", params={"q": "B²-4AC"}).json()[0]["hits"] == [
        {"start": 5, "text": "판별식 b²-4ac"}]  # 대소문자 구분 없이, 요점에서도
    assert client.get("/api/search", params={"q": "없는말"}).json() == []

    (data_dir / f"{ids['3강']}.json").write_text('{"title": "3강",}', encoding="utf-8")  # 손으로 고치다 깨진 파일
    assert [r["title"] for r in client.get("/api/search", params={"q": "근의 공식"}).json()] == ["1강", "2강"]


@pytest.mark.parametrize("q", ["", " ", "의", "a" * 101])
def test_search_rejects_empty_one_letter_or_huge_queries(setup, q):
    client, _, _ = setup

    assert client.get("/api/search", params={"q": q}).status_code == 422


@pytest.mark.parametrize("bad", [
    {"segments": [{"start": "0:10", "end": 1.0, "text": "근의 공식"}, {"start": 3.0, "text": "근의 공식"}]},
    {"segments": [{"start": 1.0, "end": 2.0}]},  # text 없음
    {"segments": [], "guide": {"chapters": [{"start": 0, "title": "근의 공식"}]}},  # points 없음
], ids=["start-is-text", "no-text", "no-points"])
def test_one_hand_edited_file_does_not_break_search(tmp_path, bad):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    for name in ("1강", "2강"):
        (video_dir / f"{name}.mp4").write_bytes(b"x")
    ids = {v["title"]: v["id"] for v in find_videos(video_dir)}
    save_analysis(data_dir, ids["1강"], {"title": "1강", "guide": None, **bad})
    save_analysis(data_dir, ids["2강"], {"title": "2강", "guide": None,
                                         "segments": [{"start": 1.0, "end": 2.0, "text": "근의 공식"}]})
    client = TestClient(create_app(video_dir, data_dir, lambda *a: ""))

    res = client.get("/api/search", params={"q": "근의 공식"})

    assert res.status_code == 200
    assert [r["title"] for r in res.json()] == ["2강"]


def test_search_ignores_line_breaks_and_unicode_form(setup, tmp_path):
    import unicodedata

    client, ids, _ = setup
    save_analysis(tmp_path / "data", ids["1강"], {"title": "1강", "guide": None, "segments": [
        {"start": 1.0, "end": 2.0, "text": "근의\n공식"},
        {"start": 3.0, "end": 4.0, "text": unicodedata.normalize("NFD", "판별식")},  # 맥에서 고친 파일
    ]})

    hits = lambda q: [h["start"] for r in client.get("/api/search", params={"q": q}).json() for h in r["hits"]]

    assert hits("근의 공식") == [1.0]
    assert hits("판별식") == [3.0]


def test_search_sees_reanalysed_lecture(setup, tmp_path):
    client, ids, _ = setup  # 분석 결과를 기억해 두더라도, 다시 분석하면 새 내용으로 찾아야 합니다.
    assert client.get("/api/search", params={"q": "안녕하세요"}).json()[0]["total"] == 1

    save_analysis(tmp_path / "data", ids["1강"], {"title": "1강", "guide": None, "segments": [
        {"start": 1.0, "end": 2.0, "text": "다시 분석한 내용"}]})

    assert client.get("/api/search", params={"q": "안녕하세요"}).json() == []
    assert client.get("/api/search", params={"q": "다시 분석"}).json()[0]["total"] == 1


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


def test_ask_reports_ai_failure_clearly(tmp_path, caplog):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    (video_dir / "1강.mp4").write_bytes(b"x")
    video_id = find_videos(video_dir)[0]["id"]
    save_analysis(data_dir, video_id, {"title": "1강", "segments": SEGMENTS, "guide": GUIDE})

    def broken_answer(*args):
        raise TypeError("Could not resolve authentication method")  # API 키가 없을 때 SDK가 내는 오류

    client = TestClient(create_app(video_dir, data_dir, broken_answer))
    with caplog.at_level("ERROR"):
        res = client.post(f"/api/videos/{video_id}/ask", json={"question": "질문"})

    assert res.status_code == 502
    assert res.json()["detail"] == "AI 답변을 받지 못했습니다. 잠시 뒤 다시 해 주세요."  # 학생에게는 내부 오류를 보이지 않음
    assert "authentication" in caplog.text  # 선생님은 Container Manager 로그에서 원인을 봄


def test_responses_carry_browser_protection_headers(setup):
    client, ids, _ = setup

    page, api, media = client.get("/"), client.get("/api/videos"), client.get(f"/media/{ids['1강']}")

    for res in (page, api, media):
        assert res.headers["x-content-type-options"] == "nosniff"
        assert res.headers["x-frame-options"] == "DENY"  # 다른 사이트가 플레이어를 몰래 띄우지 못하게
        assert res.headers["referrer-policy"] == "same-origin"
    assert api.headers["cache-control"] == "no-store"
    assert media.headers["cache-control"] == "private"


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_api_description_pages_are_off(setup, path):
    client, _, _ = setup

    assert client.get(path).status_code == 404


def test_video_folder_is_not_rescanned_on_every_request(tmp_path, monkeypatch):
    import academy.server as server

    (tmp_path / "videos").mkdir()
    (tmp_path / "videos" / "1강.mp4").write_bytes(b"x" * 100)
    scans = []
    real = server.find_videos
    monkeypatch.setattr(server, "find_videos", lambda d: scans.append(d) or real(d))
    client = TestClient(create_app(tmp_path / "videos", tmp_path / "data", lambda *a: ""))
    video_id = client.get("/api/videos").json()[0]["id"]

    for start in range(0, 100, 10):  # 영상을 보며 여기저기 넘길 때마다 오는 요청들
        client.get(f"/media/{video_id}", headers={"Range": f"bytes={start}-{start + 9}"})
    client.get(f"/api/videos/{video_id}")

    assert len(scans) == 1


def test_video_deleted_moments_ago_is_not_found_instead_of_crashing(setup, tmp_path):
    client, ids, _ = setup
    client.get("/api/videos")  # 목록을 기억해 둔 상태에서
    (tmp_path / "videos" / "1강.mp4").unlink()  # 선생님이 영상을 지움

    assert client.get(f"/media/{ids['1강']}").status_code == 404


def test_new_video_shows_up_once_the_list_is_old(tmp_path, monkeypatch):
    import academy.server as server

    (tmp_path / "videos").mkdir()
    (tmp_path / "videos" / "1강.mp4").write_bytes(b"x")
    monkeypatch.setattr(server, "VIDEO_LIST_TTL", 0)  # 기억해 둔 목록이 바로 낡은 것으로
    client = TestClient(create_app(tmp_path / "videos", tmp_path / "data", lambda *a: ""))
    assert len(client.get("/api/videos").json()) == 1

    (tmp_path / "videos" / "2강.mp4").write_bytes(b"x")  # 선생님이 새 강의를 올림

    assert [v["title"] for v in client.get("/api/videos").json()] == ["1강", "2강"]


def test_serves_student_pages(setup):
    client, _, _ = setup

    assert "<html" in client.get("/").text
    assert client.get("/watch.html").status_code == 200
    assert "틀린 문제 복습" in client.get("/review.html").text
