import sys

import pytest

from academy.analyze import analyze_all, main, part_arg
from academy.library import find_videos, load_analysis, save_analysis

SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "안녕하세요"}]
GUIDE = {"summary": "요약", "chapters": [], "quiz": []}


class Recorder:
    def __init__(self, fail_on=None, segments=SEGMENTS, guide=GUIDE):
        self.transcribed, self.guided = [], []
        self.fail_on = fail_on
        self.segments = segments
        self.guide = guide

    def transcribe(self, path):
        self.transcribed.append(path.name)
        if path.name == self.fail_on:
            raise RuntimeError("받아쓰기 실패")
        return self.segments, 120.0

    def make_guide(self, title, segments):
        self.guided.append(title)
        return self.guide


def make_videos(root, *names):
    root.mkdir(parents=True, exist_ok=True)
    for name in names:
        (root / name).write_bytes(b"x")
    return {v["title"]: v["id"] for v in find_videos(root)}


def test_analyzes_new_videos_and_saves_results(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    rec = Recorder()

    failures = analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide)

    assert failures == 0
    data = load_analysis(tmp_path / "data", ids["1강"])
    assert data["title"] == "1강"
    assert data["duration"] == 120.0
    assert data["segments"] == SEGMENTS
    assert data["guide"] == GUIDE


def test_skips_finished_videos_and_resumes_half_done_ones(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4", "2강.mp4")
    data_dir = tmp_path / "data"
    save_analysis(data_dir, ids["1강"], {"title": "1강", "segments": SEGMENTS, "guide": GUIDE})
    save_analysis(data_dir, ids["2강"], {"title": "2강", "segments": SEGMENTS, "guide": None})
    rec = Recorder()

    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, rec.make_guide)

    assert rec.transcribed == []
    assert rec.guided == ["2강"]


def test_force_redoes_everything(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    save_analysis(tmp_path / "data", ids["1강"], {"title": "1강", "segments": SEGMENTS, "guide": GUIDE})
    rec = Recorder()

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide, force=True)

    assert rec.transcribed == ["1강.mp4"]


def test_one_failure_does_not_stop_the_rest(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4", "2강.mp4")
    rec = Recorder(fail_on="1강.mp4")

    failures = analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide)

    assert failures == 1
    assert load_analysis(tmp_path / "data", ids["1강"]) is None
    assert load_analysis(tmp_path / "data", ids["2강"])["guide"] == GUIDE


def test_silent_video_skips_claude(tmp_path):
    ids = make_videos(tmp_path / "videos", "무음.mp4")
    rec = Recorder(segments=[])

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide)

    assert rec.guided == []
    assert load_analysis(tmp_path / "data", ids["무음"])["guide"]["chapters"] == []


def test_empty_video_folder_says_so(tmp_path, capsys):
    (tmp_path / "videos").mkdir()
    rec = Recorder()

    failures = analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide)

    assert failures == 0
    assert "영상이 없습니다" in capsys.readouterr().out


def test_missing_video_folder_stops_with_message(tmp_path, monkeypatch):
    monkeypatch.setenv("VIDEO_DIR", str(tmp_path / "없는폴더"))
    monkeypatch.setattr(sys, "argv", ["analyze"])

    with pytest.raises(SystemExit) as stop:
        main()

    assert "영상 폴더가 없습니다" in str(stop.value.code)


def test_parts_split_videos_without_overlap(tmp_path):
    make_videos(tmp_path / "videos", "1강.mp4", "2강.mp4", "3강.mp4")
    first, second = Recorder(), Recorder()

    analyze_all(tmp_path / "videos", tmp_path / "data", first.transcribe, first.make_guide, part=(1, 2))
    analyze_all(tmp_path / "videos", tmp_path / "data", second.transcribe, second.make_guide, part=(2, 2))

    assert first.transcribed == ["1강.mp4", "3강.mp4"]
    assert second.transcribed == ["2강.mp4"]


def test_part_arg():
    assert part_arg("2/2") == (2, 2)
    for bad in ["3/2", "0/2", "1"]:
        with pytest.raises(ValueError):
            part_arg(bad)


def test_guide_corrections_fix_the_saved_transcript(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    rec = Recorder(segments=[{"start": 0.0, "end": 2.0, "text": "요령의 경률과 관용의 경률"}],
                   guide={**GUIDE, "corrections": [{"wrong": "경률", "right": "격률"}]})

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide)

    segments = load_analysis(tmp_path / "data", ids["1강"])["segments"]
    assert segments[0]["text"] == "요령의 격률과 관용의 격률"
