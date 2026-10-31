"""강의 3,900개 규모 점검에서 나온 속도 개선: 빨라져도 결과는 그대로이고, 바뀐 것은 바로 보여야 합니다."""

import random

from fastapi.testclient import TestClient

import academy.references as refs_module
from academy.library import find_videos, save_analysis
from academy.references import ref_key
from academy.server import _near, _near_filter, create_app

LAN = ("192.168.0.5", 50000)
SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "안녕하세요"}]
TEACHER = {"x-teacher-key": "teacher-key-123"}
REF = {"title": "제망매가", "grade": "고1", "meta": {"갈래": "향가"}, "features": [{"text": "누이의 죽음"}]}


def site(tmp_path, n=3):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    (video_dir / "고1").mkdir(parents=True)
    for i in range(1, n + 1):
        (video_dir / "고1" / f"{i}강 제망매가.mp4").write_bytes(b"x")
    ids = [v["id"] for v in find_videos(video_dir)]
    return video_dir, data_dir, ids


def test_the_lecture_list_shows_changes_right_away(tmp_path):
    video_dir, data_dir, ids = site(tmp_path)
    save_analysis(data_dir, ids[0], {"title": "1강", "duration": 2.0, "segments": SEGMENTS, "guide": None})
    client = TestClient(create_app(video_dir, data_dir, None, [REF], teacher_key="teacher-key-123"), client=LAN)
    listed = lambda: {v["id"]: v for v in client.get("/api/videos").json()}
    assert listed()[ids[0]]["guide"] is True and listed()[ids[1]]["analyzed"] is False

    save_analysis(data_dir, ids[1], {"title": "2강", "duration": 2.0, "segments": SEGMENTS, "guide": None})  # 밤 분석이 끝남
    assert listed()[ids[1]]["analyzed"] is True
    for item in ["갈래: 향가", "누이의 죽음"]:  # 선생님이 정리를 모두 숨김
        section = "개요" if "갈래" in item else "핵심 특징"
        client.put(f"/api/references/{ref_key(REF)}/fix", json={"section": section, "original": item, "hidden": True}, headers=TEACHER)
    assert listed()[ids[0]]["guide"] is False


def test_the_lecture_list_is_sent_compressed(tmp_path):
    video_dir, data_dir, _ = site(tmp_path, n=40)
    client = TestClient(create_app(video_dir, data_dir, None), client=LAN)

    first, again = client.get("/api/videos"), client.get("/api/videos")

    assert first.headers["content-encoding"] == "gzip" and first.json() == again.json() and len(first.json()) == 40
    assert client.get("/api/videos", headers={"accept-encoding": "identity"}).json() == first.json()  # 압축을 못 받는 기기


def test_each_summary_is_prepared_once_however_many_lectures_match(tmp_path, monkeypatch):
    video_dir, data_dir, ids = site(tmp_path, n=30)
    for video_id in ids:
        save_analysis(data_dir, video_id, {"title": "강의", "duration": 2.0, "segments": SEGMENTS, "guide": None})
    calls = []
    real = refs_module.reference_sections
    monkeypatch.setattr(refs_module, "reference_sections", lambda ref: calls.append(1) or real(ref))
    client = TestClient(create_app(video_dir, data_dir, None, [REF]), client=LAN)

    assert all(v["guide"] for v in client.get("/api/videos").json())
    assert len(calls) < 10  # 강의 30개마다 다시 만들지 않음(서버를 켠 뒤 첫 목록이 오래 걸리던 까닭)


def test_the_quick_near_check_finds_exactly_what_the_pattern_finds():
    rng = random.Random(7)
    syllables = [chr(c) for c in range(0xAC00, 0xAC00 + 11172, 37)]
    for word in ["반어법", "제망매가", "사잇소리현상", "가나다라마바사아자차", "화자의"]:
        near, quick = _near(word), _near_filter(word)
        for _ in range(300):
            text = "".join(rng.choice(syllables) for _ in range(rng.randint(0, 40)))
            spot = rng.randint(0, len(word) - 1)
            variant = word[:spot] + rng.choice(syllables) + word[spot + 1:]  # 한 음절이 다른 말을 섞어 봄
            text = text[:20] + (variant if rng.random() < 0.5 else "") + text[20:]
            assert quick(text) == bool(near.search(text)), (word, text)


def test_status_counts_quiz_answers_added_after_the_last_look(tmp_path):
    video_dir, data_dir, ids = site(tmp_path)
    client = TestClient(create_app(video_dir, data_dir, None, log_dir=tmp_path / "logs"), client=LAN)
    (tmp_path / "logs").mkdir(exist_ok=True)
    answer = lambda key: client.post("/api/quiz-result", json={"id": ids[0], "key": key, "right": False})

    answer("Q1")
    assert client.get("/api/status").json()["quiz"]["answered"] == 1
    answer("Q2")
    assert client.get("/api/status").json()["quiz"]["answered"] == 2


def test_the_same_spoken_search_from_many_students_is_worked_out_once(tmp_path, monkeypatch):
    import academy.server as server
    video_dir, data_dir, ids = site(tmp_path)
    said = [{"start": 0.0, "end": 2.0, "text": "반어법을 봅시다"}]
    save_analysis(data_dir, ids[0], {"title": "1강", "duration": 2.0, "segments": said, "guide": None})
    worked = []
    real = server._near_filter
    monkeypatch.setattr(server, "_near_filter", lambda word: worked.append(word) or real(word))
    client = TestClient(create_app(video_dir, data_dir, None), client=LAN)

    first = client.get("/api/search", params={"q": "반어법"}).json()
    again = client.get("/api/search", params={"q": " 반어법 "}).json()  # 띄어쓰기만 다른 같은 낱말

    assert first == again and len(worked) == 1  # 수업 중 여러 학생이 같은 낱말을 찾아도 한 번만 찾음
    save_analysis(data_dir, ids[1], {"title": "2강", "duration": 3.0, "segments": said, "guide": None})  # 새 분석(다른 녹화)
    assert len(client.get("/api/search", params={"q": "반어법"}).json()["exact"]) == 2
