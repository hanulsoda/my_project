from pathlib import Path

import pytest

from academy.library import find_videos, load_analysis, save_analysis


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


def test_a_lecture_comes_before_its_longer_named_follow_up(tmp_path):
    # 확장자까지 비교하면 '1강 제망매가 학습활동.mp4'(빈칸)가 '1강 제망매가.mp4'(.)보다 앞섰습니다.
    for name in ["1강 제망매가 학습활동.mp4", "1강 제망매가.mp4", "2강 청산별곡.mp4"]:
        touch(tmp_path / "고1" / name)

    assert [v["title"] for v in find_videos(tmp_path)] == ["고1/1강 제망매가", "고1/1강 제망매가 학습활동", "고1/2강 청산별곡"]


def test_video_ids_are_stable_and_url_safe(tmp_path):
    touch(tmp_path / "수학" / "1강.mp4")
    touch(tmp_path / "영어" / "1강.mp4")

    first = [v["id"] for v in find_videos(tmp_path)]
    again = [v["id"] for v in find_videos(tmp_path)]

    assert first == again
    assert len(set(first)) == 2
    assert all(i.isalnum() and i.isascii() for i in first)


def test_skips_nas_recycle_bin_thumbnail_and_hidden_folders_and_files(tmp_path):
    touch(tmp_path / "1강.mp4")
    touch(tmp_path / "#recycle" / "지운 강의.mp4")  # 시놀로지 휴지통
    touch(tmp_path / "@eaDir" / "1강.mp4" / "SYNOVIDEO_VIDEO_SCREENSHOT.mp4")  # 시놀로지 썸네일
    touch(tmp_path / ".숨김" / "3강.mp4")
    touch(tmp_path / "수학" / "._4강.mp4")  # 맥이 남기는 숨김 파일
    touch(tmp_path / "수학" / "4강.mp4")
    touch(tmp_path / "창비" / "#지구 #소통.mp4")  # 이름이 #으로 시작하는 진짜 강의(NAS에 실제로 있음)

    assert [v["title"] for v in find_videos(tmp_path)] == ["1강", "수학/4강", "창비/#지구 #소통"]


def test_missing_video_dir_gives_empty_list(tmp_path):
    assert find_videos(tmp_path / "없음") == []


def test_save_and_load_analysis(tmp_path):
    data = {"title": "1강", "segments": [{"start": 0, "end": 1, "text": "안녕하세요"}]}

    save_analysis(tmp_path / "data", "abc", data)

    assert load_analysis(tmp_path / "data", "abc") == data
    assert load_analysis(tmp_path / "data", "없는영상") is None


def test_a_save_cut_off_midway_keeps_the_previous_analysis(tmp_path, monkeypatch):
    save_analysis(tmp_path, "abc", {"title": "예전 분석"})
    real = Path.write_text

    def cut_off(self, text, **kwargs):  # 쓰는 도중 작업이 끊기거나 디스크가 찬 경우
        real(self, text[:5], **kwargs)
        raise OSError("디스크가 가득 참")

    monkeypatch.setattr(Path, "write_text", cut_off)
    with pytest.raises(OSError):
        save_analysis(tmp_path, "abc", {"title": "새 분석"})
    monkeypatch.undo()

    # 서버가 읽는 파일은 늘 온전한 이전 분석이거나 새 분석입니다.
    assert load_analysis(tmp_path, "abc") == {"title": "예전 분석"}
