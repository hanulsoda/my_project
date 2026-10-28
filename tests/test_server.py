import os
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


def test_a_restarted_server_reuses_its_saved_index_and_rereads_only_changed_analyses(tmp_path, monkeypatch):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    for name in ["1강", "2강"]:
        (video_dir / f"{name}.mp4").write_bytes(b"x")
    ids = {v["title"]: v["id"] for v in find_videos(video_dir)}
    for name in ["1강", "2강"]:
        save_analysis(data_dir, ids[name], {"title": name, "duration": 60.0, "segments": SEGMENTS})
    with TestClient(create_app(video_dir, data_dir, None)):  # 켜자마자 목록을 준비하고 요약을 저장합니다
        deadline = time.monotonic() + 5
        while not (data_dir / ".server-index.cache").exists() and time.monotonic() < deadline:
            time.sleep(0.01)
    reads, real = [], server.load_analysis
    monkeypatch.setattr(server, "load_analysis", lambda d, video_id: reads.append(video_id) or real(d, video_id))
    save_analysis(data_dir, ids["2강"], {"title": "2강", "duration": 60.0,
                                          "segments": [{"start": 0.0, "end": 2.0, "text": "구개음화"}]})

    client = TestClient(create_app(video_dir, data_dir, None))  # 다시 켠 서버

    # 분석 결과 3,900개를 처음부터 다시 읽느라 몇 분 걸리던 것을, 바뀐 파일만 다시 읽어 줄입니다.
    assert [r["title"] for r in client.get("/api/search", params={"q": "안녕하세요"}).json()["exact"]] == ["1강"]
    assert [r["title"] for r in client.get("/api/search", params={"q": "구개음화"}).json()["exact"]] == ["2강"]
    assert reads == [ids["2강"]]


def test_a_damaged_analysis_file_only_takes_that_lecture_out(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    for name in ["1강", "2강"]:
        (video_dir / f"{name}.mp4").write_bytes(b"x")
    ids = {v["title"]: v["id"] for v in find_videos(video_dir)}
    save_analysis(data_dir, ids["1강"], {"title": "1강", "duration": 60.0, "segments": SEGMENTS})
    (data_dir / f"{ids['2강']}.json").write_text('{"title": "2강", "segments": [', encoding="utf-8")  # 손으로 고치다 깨짐
    client = TestClient(create_app(video_dir, data_dir, None))

    # 깨진 파일 하나 때문에 목록·검색·현황 전체가 오류가 나지 않고, 그 강의만 '분석 전'으로 보입니다.
    assert [(v["title"], v["analyzed"]) for v in client.get("/api/videos").json()] == [("1강", True), ("2강", False)]
    assert client.get(f"/api/videos/{ids['2강']}").json()["analysis"] is None
    assert [r["title"] for r in client.get("/api/search", params={"q": "안녕하세요"}).json()["exact"]] == ["1강"]
    assert client.get("/api/status").json()["unanalyzed"] == ["2강"]


def test_hides_api_docs_and_sends_security_headers(setup):
    client, ids, _ = setup

    for path in ["/docs", "/redoc", "/openapi.json"]:
        assert client.get(path).status_code == 404  # 서버가 자동으로 만드는 API 설명서를 바깥에 보이지 않습니다
    for path in ["/", f"/api/videos/{ids['1강']}"]:
        headers = client.get(path).headers
        assert headers["x-frame-options"] == "DENY"
        assert headers["x-content-type-options"] == "nosniff"
        assert headers["referrer-policy"] == "same-origin"


def test_lists_when_each_lecture_file_was_put_on_the_nas(tmp_path):
    video_dir = tmp_path / "videos"
    video_dir.mkdir()
    for name, stamp in [("1강", 1_700_000_000), ("2강", 1_760_000_000)]:
        (video_dir / f"{name}.mp4").write_bytes(b"x")
        os.utime(video_dir / f"{name}.mp4", (stamp, stamp))
    client = TestClient(create_app(video_dir, tmp_path / "data", None))

    # 목록 화면이 '새로 올라온 강의'를 고를 수 있게 파일 날짜(초)를 함께 보냅니다.
    assert [(v["title"], v["added"]) for v in client.get("/api/videos").json()] == [("1강", 1_700_000_000), ("2강", 1_760_000_000)]


def test_status_counts_tables_of_contents_made_in_the_last_three_days(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    toc = {"model": "m", "chapters": [{"start": 0.0, "title": "도입"}]}
    for name, days_ago in [("어제", 1), ("그제", 2), ("열흘 전", 10), ("아직", None)]:
        (video_dir / f"{name}.mp4").write_bytes(b"x")
    ids = {v["title"]: v["id"] for v in find_videos(video_dir)}
    for name, days_ago in [("어제", 1), ("그제", 2), ("열흘 전", 10), ("아직", None)]:
        save_analysis(data_dir, ids[name], {"title": name, "segments": SEGMENTS, **({"toc": toc} if days_ago else {})})
        if days_ago:
            stamp = time.time() - days_ago * 86400
            os.utime(data_dir / f"{ids[name]}.json", (stamp, stamp))

    progress = TestClient(create_app(video_dir, data_dir, None)).get("/api/status").json()["toc_progress"]

    # 현황 페이지가 최근 속도로 남은 날을 짐작할 수 있게 최근 3일 동안 만든 목차 수를 보냅니다.
    assert progress == {"target": 4, "done": 3, "last_3_days": 2}


def test_auto_toc_titles_take_the_spelling_of_the_work_in_the_file_name(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    (video_dir / "ebs").mkdir(parents=True)
    (video_dir / "ebs" / "성에꽃.mp4").write_bytes(b"x")
    video_id = find_videos(video_dir)[0]["id"]
    chapters = [{"start": 0.0, "title": "성의 꽃 배경 이해"}, {"start": 60.0, "title": "성의꽃과 시대"},
                {"start": 120.0, "title": "성에서 본 풍경"}]
    save_analysis(data_dir, video_id, {"title": "ebs/성에꽃", "segments": SEGMENTS, "toc": {"model": "m", "chapters": chapters}})
    client = TestClient(create_app(video_dir, data_dir, None))

    sent = client.get(f"/api/videos/{video_id}").json()["analysis"]["toc"]["chapters"]

    # 받아쓰기가 '성에꽃'을 '성의꽃'으로 적어 목차 제목에도 옮겨 오므로, 보낼 때 파일 이름의 철자로 바로잡습니다.
    assert [c["title"] for c in sent] == ["성에꽃 배경 이해", "성에꽃과 시대", "성에서 본 풍경"]


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

    listed = [{k: v for k, v in item.items() if k != "added"} for item in client.get("/api/videos").json()]
    assert listed == [
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


def test_finds_lectures_where_a_word_is_spoken_most_first(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    for name in ["1강", "2강", "3강", "4강"]:
        (video_dir / f"{name}.mp4").write_bytes(b"x")
    ids = {v["title"]: v["id"] for v in find_videos(video_dir)}
    said = {
        "1강": [(10.0, "오늘은 구개음화를 볼게"), (30.0, "구개 음화 예시"), (200.0, "다시 구개음화")],
        "2강": [(5.0, "비음화와"), (95.0, "구개음화의 조건"), (100.0, "구개음화 정리"), (300.0, "구개음화"), (400.0, "구개음화")],
        "3강": [(0.0, "비음화만 다룹니다")],
    }
    said["4강"] = said["1강"]  # 같은 녹화를 다른 폴더에도 넣어 둔 경우
    toc = {"model": "m", "chapters": [{"start": 0.0, "title": "도입"}, {"start": 90.0, "title": "구개음화의 조건"},
                                      {"start": 290.0, "title": "정리"}]}
    for name, lines in said.items():
        save_analysis(data_dir, ids[name], {"title": name, "duration": 500.0, **({"toc": toc} if name == "2강" else {}),
                                            "segments": [{"start": s, "end": s + 3, "text": t} for s, t in lines]})
    client = TestClient(create_app(video_dir, data_dir, None))

    # 띄어쓰기는 무시하고 많이 말한 강의부터, 1분 안에 다시 말한 것은 한 번으로 봅니다. 대본 글은 보내지 않습니다.
    # 시각마다 그때의 챕터 제목을 붙이고, 같은 녹화는 한 번만 보여 주며 다른 폴더의 것을 함께 적습니다.
    assert client.get("/api/search", params={"q": "구개 음화"}).json() == {"exact": [
        {"id": ids["2강"], "title": "2강", "count": 4, "times": [95.0, 300.0, 400.0],
         "chapters": ["구개음화의 조건", "정리", "정리"], "also": []},
        {"id": ids["1강"], "title": "1강", "count": 3, "times": [10.0, 200.0], "chapters": [None, None], "also": ["4강"]},
    ], "similar": [], "notes": []}
    assert client.get("/api/search", params={"q": "음"}).status_code == 400  # 한 글자는 너무 많이 걸립니다


def test_also_finds_lectures_where_the_word_was_transcribed_one_sound_off(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    said = {"정확": [(5.0, "성에꽃을 보자"), (20.0, "성의꽃")],
            "비슷": [(10.0, "최두석의 성의꽃을 볼게"), (90.0, "다시 성의꽃")],
            "군주로": [(0.0, "군주로서 백성을 다스린다")],
            "군지론": [(0.0, "마키아벨리의 군지론과 백상")]}
    for name in said:
        (video_dir / f"{name}.mp4").write_bytes(b"x")
    ids = {v["title"]: v["id"] for v in find_videos(video_dir)}
    for name, lines in said.items():
        save_analysis(data_dir, ids[name], {"title": name, "duration": 500.0,
                                            "segments": [{"start": s, "end": s + 3, "text": t} for s, t in lines]})
    client = TestClient(create_app(video_dir, data_dir, None))
    search = lambda q: client.get("/api/search", params={"q": q}).json()

    # 받아쓰기가 한 음절의 자음·모음 하나를 다르게 적은 강의는 따로, 실제로 적힌 말과 함께 보냅니다.
    assert [r["title"] for r in search("성에꽃")["exact"]] == ["정확"]
    assert search("성에꽃")["similar"] == [{"id": ids["비슷"], "title": "비슷", "count": 2, "times": [10.0, 90.0],
                                          "chapters": [None, None], "also": [], "heard_as": ["성의꽃"]}]
    # '군주로(서)'처럼 마지막 음절의 받침만 다른 말은 조사가 붙은 다른 말일 때가 많아 빼고, 두 글자 낱말은 비슷한 말을 찾지 않습니다.
    assert [r["title"] for r in search("군주론")["similar"]] == ["군지론"]
    assert search("백성")["similar"] == []


def test_also_finds_lectures_whose_summary_or_chapters_mention_the_word(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    for name in ["홍계월전", "목차", "말함"]:
        (video_dir / f"{name}.mp4").write_bytes(b"x")
    ids = {v["title"]: v["id"] for v in find_videos(video_dir)}
    lines = lambda text: [{"start": 0.0, "end": 3.0, "text": text}]  # 서로 다른 녹화(같으면 같은 녹화로 합쳐짐)
    save_analysis(data_dir, ids["홍계월전"], {"title": "홍계월전", "duration": 600.0, "segments": lines("고전 소설을 봅니다")})
    save_analysis(data_dir, ids["목차"], {"title": "목차", "duration": 600.0, "segments": lines("현대 소설을 봅니다"),
                                         "toc": {"model": "m", "chapters": [{"start": 0.0, "title": "도입"},
                                                                            {"start": 310.0, "title": "전지적 작가 시점의 효과"}]}})
    save_analysis(data_dir, ids["말함"], {"title": "말함", "duration": 600.0,
                                         "segments": [{"start": 5.0, "end": 8.0, "text": "전지적 작가 시점이야"}]})
    refs = [{"title": "홍계월전", "grade": "고1", "meta": {"시점": "전지적 작가 시점"}}]
    client = TestClient(create_app(video_dir, data_dir, None, refs))

    found = client.get("/api/search", params={"q": "전지적 작가 시점"}).json()

    # 선생님이 말하지 않았어도 학원 정리나 목차·챕터 제목에 있으면 따로 찾고, 걸린 줄(챕터면 시각도)을 함께 보냅니다.
    assert [r["title"] for r in found["exact"]] == ["말함"]
    assert sorted(found["notes"], key=lambda r: r["title"]) == [
        {"id": ids["목차"], "title": "목차", "matches": [{"text": "전지적 작가 시점의 효과", "time": 310.0}], "also": []},
        {"id": ids["홍계월전"], "title": "홍계월전", "matches": [{"text": "시점: 전지적 작가 시점", "time": None}], "also": []},
    ]


def test_status_shows_the_latest_ops_log_lines_when_given_a_log_folder(tmp_path):
    video_dir, logs = tmp_path / "videos", tmp_path / "logs"
    video_dir.mkdir()
    logs.mkdir()
    (logs / "backup.log").write_text("2026-10-27 14:58:46 백업 완료: 첫날\n2026-10-28 08:30:05 백업 완료: 둘째 날\n", encoding="utf-8")
    (logs / "toc.log").write_text("목차: 1강\n2026-10-28 07:00:31 7시가 되어 멈춤. 다음 밤에 이어서 합니다\n목차: 2강\n", encoding="utf-8")
    (logs / "new-videos.log").write_text("[1/2] 1강\n  이미 분석됨, 건너뜀\n9개 영상 분석 실패.\n\n", encoding="utf-8")

    status = TestClient(create_app(video_dir, tmp_path / "data", None, log_dir=logs)).get("/api/status").json()

    # 밤 작업은 강의마다 남기는 '목차:' 줄 말고 날짜로 시작하는 마지막 줄을 보여 줍니다.
    assert status["ops"] == {"backup": "2026-10-28 08:30:05 백업 완료: 둘째 날",
                             "night": "2026-10-28 07:00:31 7시가 되어 멈춤. 다음 밤에 이어서 합니다",
                             "new_videos": "9개 영상 분석 실패."}
    assert "ops" not in TestClient(create_app(video_dir, tmp_path / "data", None)).get("/api/status").json()


def test_status_counts_what_students_get_for_each_lecture(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    for name in ["Claude", "제망매가", "목차", "짧은 강의", "긴 강의", "소리 없는 강의", "망가진 파일"]:
        (video_dir / f"{name}.mp4").write_bytes(b"x")
    ids = {v["title"]: v["id"] for v in find_videos(video_dir)}
    base = {"segments": SEGMENTS, "duration": 600.0}
    save_analysis(data_dir, ids["Claude"], {**base, "title": "Claude", "guide": GUIDE})
    save_analysis(data_dir, ids["제망매가"], {**base, "title": "제망매가"})
    save_analysis(data_dir, ids["목차"], {**base, "title": "목차",
                                         "toc": {"model": "m", "chapters": [{"start": 0.0, "title": "도입"}]}})
    save_analysis(data_dir, ids["짧은 강의"], {**base, "title": "짧은 강의"})
    save_analysis(data_dir, ids["긴 강의"], {**base, "title": "긴 강의", "duration": 3000.0})
    save_analysis(data_dir, ids["소리 없는 강의"], {**base, "title": "소리 없는 강의", "segments": []})
    refs = [{"title": "제망매가", "grade": "고1", "meta": {"갈래": "향가"}}]
    client = TestClient(create_app(video_dir, data_dir, None, refs))

    # 자동 목차 대상: 대본이 있고 Claude 요점 정리가 없는 강의(제망매가, 목차, 짧은 강의, 긴 강의)
    assert client.get("/api/status").json() == {
        "total": 7, "analyzed": 6, "guide": 1, "summary": 1, "toc": 1, "pages": 3,
        "toc_progress": {"target": 4, "done": 1, "last_3_days": 1}, "unanalyzed": ["망가진 파일"]}


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
