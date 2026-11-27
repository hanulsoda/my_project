"""요점노트·시험대비문제를 영상에 연결해 보내는 서버 시험(가짜 항목 사용)."""

import time

import pytest
from fastapi.testclient import TestClient

from academy.library import find_videos
from academy.server import create_app
from tests.study_data import make_entry
from tests.test_entry_server import ACADEMY, HOME, SECRET, entry_query

NOT_FOUND = {"detail": "자료를 찾을 수 없습니다"}


def build(tmp_path, folder="고1/미래엔", **kwargs):
    video_dir = tmp_path / "videos"
    (video_dir / folder).mkdir(parents=True, exist_ok=True)
    (video_dir / folder / "4-2. 가짜 제목.mp4").write_bytes(b"x" * 100)
    video_id = find_videos(video_dir)[0]["id"]
    return create_app(video_dir, tmp_path / "data", lambda *a: "답", **kwargs), video_id


def test_video_detail_lists_linked_study(tmp_path):
    app, vid = build(tmp_path, study=[make_entry()])
    client = TestClient(app, client=ACADEMY)

    detail = client.get(f"/api/videos/{vid}").json()

    assert detail["study"] == [{"id": "midaen-4-2", "title": "가짜 단원 제목입니다", "unit": "4-2"}]


def test_unlinked_video_has_empty_study(tmp_path):
    app, vid = build(tmp_path, folder="고1/다른출판사", study=[make_entry()])

    assert TestClient(app, client=ACADEMY).get(f"/api/videos/{vid}").json()["study"] == []


def test_study_endpoint_returns_notes_and_quiz(tmp_path):
    app, _ = build(tmp_path, study=[make_entry()])

    body = TestClient(app, client=ACADEMY).get("/api/study/midaen-4-2").json()

    assert body["id"] == "midaen-4-2" and body["unit"] == "4-2" and body["unit_title"] == "가짜 단원 제목입니다"
    assert [len(body["quiz"][k]) for k in ("mc", "sub", "ox", "short")] == [10, 5, 10, 10]
    assert body["notes"]["blocks"]


def test_unknown_study_id_is_404(tmp_path):
    app, _ = build(tmp_path, study=[make_entry()])

    res = TestClient(app, client=ACADEMY).get("/api/study/nothing")

    assert res.status_code == 404 and res.json() == NOT_FOUND


@pytest.mark.parametrize("opt_in", [False, True])
def test_internet_requests_get_nothing_without_opt_in(tmp_path, opt_in):
    app, vid = build(tmp_path, study=[make_entry()], entry_secret=SECRET, study_internet=opt_in)
    client = TestClient(app, follow_redirects=False, client=HOME)
    client.get(f"/enter?{entry_query(int(time.time()) + 300)}")

    detail = client.get(f"/api/videos/{vid}")
    study = client.get("/api/study/midaen-4-2")

    assert detail.status_code == 200
    if opt_in:
        assert detail.json()["study"] == [{"id": "midaen-4-2", "title": "가짜 단원 제목입니다", "unit": "4-2"}]
        assert study.status_code == 200
    else:
        assert detail.json()["study"] == [] and study.status_code == 404 and study.json() == NOT_FOUND


def test_server_without_study_works_as_before(tmp_path):
    app, vid = build(tmp_path)

    res = TestClient(app, client=ACADEMY)
    detail = res.get(f"/api/videos/{vid}").json()

    assert detail["study"] == []
    assert set(detail) == {"id", "title", "analysis", "references", "prev", "next", "ask", "study"}
    assert res.get("/api/study/midaen-4-2").status_code == 404


def test_one_broken_entry_does_not_stop_the_others(tmp_path):
    broken = make_entry(id="broken", unit="9-9", unit_title=3)
    app, vid = build(tmp_path, study=[broken, make_entry()])
    client = TestClient(app, client=ACADEMY)

    assert [s["id"] for s in client.get(f"/api/videos/{vid}").json()["study"]] == ["midaen-4-2"]
    assert client.get("/api/study/broken").status_code == 404
