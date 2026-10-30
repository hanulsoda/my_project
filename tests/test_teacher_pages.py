"""선생님 화면(현황·이번 주 강의·학원 정리 고치기)의 버그 찾기에서 나온 경우들."""

import json

import pytest
from fastapi.testclient import TestClient

import academy.server as server
from academy.library import find_videos, save_analysis
from academy.references import ref_key
from academy.server import create_app

LAN = ("192.168.0.5", 50000)
SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "안녕하세요"}]
TEACHER = {"x-teacher-key": "teacher-key-123"}


@pytest.fixture
def lectures(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    (video_dir / "고1").mkdir(parents=True)
    for name in ["1강 제망매가.mp4", "2강 청산별곡.mp4"]:
        (video_dir / "고1" / name).write_bytes(b"x")
    ids = [v["id"] for v in find_videos(video_dir)]
    for video_id in ids:
        save_analysis(data_dir, video_id, {"title": "강의", "duration": 2.0, "segments": SEGMENTS, "guide": None})
    return video_dir, data_dir, ids


def test_a_quiz_answer_with_line_separators_cannot_break_the_status_page(lectures, tmp_path):
    video_dir, data_dir, ids = lectures
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    # 예전에 그대로 적힌 줄(U+2028이 글 안에 날것으로), 줄 하나가 통째로 JSON 값이 아닌 것들
    (log_dir / "quiz.log").write_text('{"t": 1, "id": "x", "k": "a {} b", "who": "w", "right": false}\n'
                                      'null\n[1]\n{"t": 1}\n', encoding="utf-8")
    client = TestClient(create_app(video_dir, data_dir, None, log_dir=log_dir), client=LAN)

    for key in ["a {} b", "\x85null\x85", "c []"]:  # 줄 바꿈으로 읽히는 글자로 가짜 줄 넣기
        assert client.post("/api/quiz-result", json={"id": ids[0], "key": key, "right": False}).status_code == 204

    res = client.get("/api/status")
    assert res.status_code == 200
    assert res.json()["quiz"]["answered"] == 3


def test_an_empty_teacher_key_is_not_counted_as_a_wrong_guess(lectures):
    video_dir, data_dir, ids = lectures
    client = TestClient(create_app(video_dir, data_dir, None, teacher_key="teacher-key-123"), client=LAN)

    for _ in range(15):  # 열쇠를 넣기 전에 화면을 여러 번 연 것
        res = client.put("/api/picks", json={"ids": ids})
        assert res.status_code == 403 and res.json()["detail"] == "선생님 열쇠를 넣어 주세요"

    assert client.put("/api/picks", json={"ids": ids}, headers=TEACHER).status_code == 200
    assert client.put("/api/picks", json={"ids": ids}, headers={"x-teacher-key": "guess"}).json()["detail"] \
        == "선생님 열쇠가 맞지 않습니다"


def test_picks_drop_lectures_that_left_the_list(lectures):
    video_dir, data_dir, ids = lectures
    client = TestClient(create_app(video_dir, data_dir, None, teacher_key="teacher-key-123"), client=LAN)

    res = client.put("/api/picks", json={"ids": ["gone12345678", ids[1]]}, headers=TEACHER)  # NAS에서 이름이 바뀐 강의

    assert res.status_code == 200
    assert [l["id"] for l in res.json()["lectures"]] == [ids[1]]


def test_picks_saved_from_an_older_page_are_refused(lectures, monkeypatch):
    video_dir, data_dir, ids = lectures
    clock = [1000.0]
    monkeypatch.setattr(server, "wall_clock", lambda: clock[0])
    client = TestClient(create_app(video_dir, data_dir, None, teacher_key="teacher-key-123"), client=LAN)
    opened = client.get("/api/picks").json()["at"]  # 두 탭(또는 두 선생님)이 같은 목록을 엶

    first = client.put("/api/picks", json={"ids": ids[:1], "at": opened}, headers=TEACHER)
    clock[0] += 0.5  # 1초 안에 저장해도 가립니다
    late = client.put("/api/picks", json={"ids": ids, "note": "메모만 바꿈", "at": opened}, headers=TEACHER)

    assert first.status_code == 200
    assert late.status_code == 409
    assert [l["id"] for l in client.get("/api/picks").json()["lectures"]] == ids[:1]  # 먼저 저장한 것이 남음
    assert client.put("/api/picks", json={"ids": ids, "at": first.json()["at"]}, headers=TEACHER).status_code == 200


def test_the_suspect_count_drops_once_the_teacher_fixed_or_hid_the_item(lectures):
    video_dir, data_dir, _ = lectures
    long_one, other = "남장 모티프" + "가" * 250, "또 긴 항목" + "나" * 250
    ref = {"title": "제망매가", "grade": "고1", "features": [{"text": long_one}, {"text": other}, {"text": "짧은 특징"}]}
    client = TestClient(create_app(video_dir, data_dir, None, [ref], teacher_key="teacher-key-123"), client=LAN)
    key = ref_key(ref)
    assert client.get("/api/references").json()[0]["suspects"] == 2

    client.put(f"/api/references/{key}/fix", json={"section": "핵심 특징", "original": long_one, "hidden": True}, headers=TEACHER)
    client.put(f"/api/references/{key}/fix", json={"section": "핵심 특징", "original": other, "text": "줄인 항목"}, headers=TEACHER)

    assert client.get("/api/references").json()[0]["suspects"] == 0


def test_a_summary_with_every_item_hidden_is_not_shown_or_counted(lectures):
    video_dir, data_dir, ids = lectures
    ref = {"title": "제망매가", "grade": "고1", "meta": {"갈래": "향가"}, "features": [{"text": "누이의 죽음"}],
           "fillins": [{"no": "Q1", "passage": "누이", "answer_line": "종교 로 극복"}]}
    only_fillins = {"title": "청산별곡", "grade": "고1", "fillins": [{"no": "Q1", "passage": "청산", "answer_line": "청산 에 살어리랏다"}]}
    client = TestClient(create_app(video_dir, data_dir, None, [ref, only_fillins], teacher_key="teacher-key-123"), client=LAN)
    key = ref_key(ref)
    for section in client.get(f"/api/references/{key}").json()["sections"]:
        for item in section["items"]:
            client.put(f"/api/references/{key}/fix", json={"section": section["name"], "original": item["original"], "hidden": True},
                       headers=TEACHER)

    assert client.get(f"/api/videos/{ids[0]}").json()["references"] == []  # 빈 카드도, 빈칸 문제도 나오지 않음
    listed = {v["id"]: v for v in client.get("/api/videos").json()}
    assert listed[ids[0]]["guide"] is False
    status = client.get("/api/status").json()
    assert (status["summary"], status["pages"]) == (1, 1)  # 청산별곡(빈칸 문제만 있는 정리)은 그대로 학원 정리
    assert client.get(f"/api/videos/{ids[1]}").json()["references"][0]["quiz"]


def test_teachers_can_hide_a_wrong_fill_in_question_but_not_rewrite_it(lectures):
    video_dir, data_dir, ids = lectures
    ref = {"title": "제망매가", "grade": "고1", "meta": {"갈래": "향가"},
           "fillins": [{"passage": "누이의 죽음", "answer_line": "슬픔을   종교적  으로 극복함"},
                       {"passage": "지은이", "answer_line": "월명사가   지었다"}]}
    client = TestClient(create_app(video_dir, data_dir, None, [ref], teacher_key="teacher-key-123"), client=LAN)
    key = ref_key(ref)
    fills = next(s for s in client.get(f"/api/references/{key}").json()["sections"] if s["name"] == "빈칸 문제")["items"]
    asked = lambda: [q["context"] for q in client.get(f"/api/videos/{ids[0]}").json()["references"][0]["quiz"]]
    assert [f["original"] for f in fills] == ["누이의 죽음 → 슬픔을   종교적  으로 극복함", "지은이 → 월명사가   지었다"]
    hide = lambda hidden: client.put(f"/api/references/{key}/fix", json={"section": "빈칸 문제", "original": fills[1]["original"],
                                                                         "hidden": hidden}, headers=TEACHER)

    assert hide(True).status_code == 200
    assert asked() == ["누이의 죽음"]  # 숨긴 빈칸 문제는 학생 퀴즈에서 빠짐
    # 빈칸 표시(두 칸 띄어쓰기)가 깨지기 쉬워 글은 고치지 못하고 숨기기만 합니다
    rewrite = client.put(f"/api/references/{key}/fix", json={"section": "빈칸 문제", "original": fills[0]["original"],
                                                              "text": "누이의 죽음 → 다른 답"}, headers=TEACHER)
    assert rewrite.status_code == 400
    assert hide(False).status_code == 200
    assert asked() == ["누이의 죽음", "지은이"]


def test_a_teacher_key_a_browser_cannot_send_stops_the_server(tmp_path):
    path = tmp_path / "teacher-key"
    path.write_text("선생님열쇠\n", encoding="utf-8")  # 브라우저는 머리글에 한글을 보낼 수 없어 아무도 못 씀

    with pytest.raises(SystemExit, match="영문"):
        server._teacher_key(str(path))
    path.write_text("plain-key-123\n", encoding="utf-8")
    assert server._teacher_key(str(path)) == "plain-key-123"
    assert json.dumps(server._teacher_key(None)) == "null"
