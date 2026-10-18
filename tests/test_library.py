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
