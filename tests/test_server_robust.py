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
