from pathlib import Path

import pytest

from academy.library import find_videos, load_analysis, save_analysis, save_frame


def touch(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x")


def test_finds_video_files_recursively_in_lecture_order(tmp_path):
    touch(tmp_path / "수학" / "10강.mp4")
    touch(tmp_path / "수학" / "2강.MP4")
    touch(tmp_path / "영어" / "1강.webm")
    touch(tmp_path / "수학" / "교재.pdf")

    videos = find_videos(tmp_path)

    assert [v["title"] for v in videos] == ["수학/2강", "수학/10강", "영어/1강"]
    assert videos[0]["path"] == tmp_path / "수학" / "2강.MP4"


def test_video_ids_are_stable_and_url_safe(tmp_path):
    touch(tmp_path / "수학" / "1강.mp4")
    touch(tmp_path / "영어" / "1강.mp4")

    first = [v["id"] for v in find_videos(tmp_path)]
    again = [v["id"] for v in find_videos(tmp_path)]

    assert first == again
    assert len(set(first)) == 2
    assert all(i.isalnum() and i.isascii() for i in first)


def test_missing_video_dir_gives_empty_list(tmp_path):
    assert find_videos(tmp_path / "없음") == []


def test_save_and_load_analysis(tmp_path):
    data = {"title": "1강", "segments": [{"start": 0, "end": 1, "text": "안녕하세요"}]}

    save_analysis(tmp_path / "data", "abc", data)

    assert load_analysis(tmp_path / "data", "abc") == data
    assert load_analysis(tmp_path / "data", "없는영상") is None


def test_interrupted_save_keeps_previous_analysis(tmp_path, monkeypatch):
    save_analysis(tmp_path, "abc", {"title": "원래 내용"})
    real_write_text = Path.write_text

    def write_half_then_fail(self, text, *args, **kwargs):  # 저장 도중 네트워크가 끊긴 상황
        real_write_text(self, text[: len(text) // 2], *args, **kwargs)
        raise OSError("연결 끊김")

    monkeypatch.setattr(Path, "write_text", write_half_then_fail)
    with pytest.raises(OSError):
        save_analysis(tmp_path, "abc", {"title": "새 내용", "segments": [{"start": 0, "end": 1, "text": "안녕"}]})
    monkeypatch.undo()

    assert load_analysis(tmp_path, "abc") == {"title": "원래 내용"}


def test_save_frame_writes_jpeg_under_frames_dir(tmp_path):
    save_frame(tmp_path, "abc", 60, b"\xff\xd8x")

    assert (tmp_path / "frames" / "abc" / "60.jpg").read_bytes() == b"\xff\xd8x"
    assert list((tmp_path / "frames" / "abc").iterdir()) == [tmp_path / "frames" / "abc" / "60.jpg"]


def test_skips_nas_trash_thumbnails_and_hidden_files(tmp_path):
    touch(tmp_path / "수학" / "1강.mp4")
    touch(tmp_path / "#recycle" / "수학" / "지난학기 3강.mp4")  # 시놀로지 휴지통
    touch(tmp_path / "수학" / "@eaDir" / "1강.mp4" / "SYNOPHOTO_FILM_M.mp4")  # 시놀로지 썸네일
    touch(tmp_path / "수학" / "._1강.mp4")  # 맥이 만드는 숨김 파일
    touch(tmp_path / ".숨김" / "2강.mp4")

    assert [v["title"] for v in find_videos(tmp_path)] == ["수학/1강"]


def test_skips_broken_shortcuts_but_keeps_working_ones(tmp_path):
    touch(tmp_path / "원본" / "1강.mp4")
    (tmp_path / "강의").mkdir()
    (tmp_path / "강의" / "1강.mp4").symlink_to(tmp_path / "원본" / "1강.mp4")  # 바로가기
    (tmp_path / "강의" / "2강.mp4").symlink_to(tmp_path / "지운영상.mp4")  # 원본이 지워진 바로가기
    (tmp_path / "강의" / "폴더이름.mp4").mkdir()  # 이름만 영상인 폴더

    assert [v["title"] for v in find_videos(tmp_path)] == ["강의/1강", "원본/1강"]
