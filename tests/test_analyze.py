import os
import subprocess
import sys
from pathlib import Path

import pytest

from academy.analyze import analyze_all
from academy.library import find_videos, load_analysis, save_analysis

PROJECT_ROOT = Path(__file__).resolve().parent.parent

SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "안녕하세요"}]
FRAMES = [(0, b"A"), (60, b"B")]
GUIDE = {"summary": "요약", "quiz": [], "chapters": [
    {"start": 0, "title": "도입", "points": [], "board": 60},
    {"start": 30, "title": "예제", "points": [], "board": 60},
]}


class Recorder:
    def __init__(self, fail_on=None, segments=SEGMENTS):
        self.transcribed, self.guided, self.captured, self.frames_seen = [], [], [], []
        self.fail_on = fail_on
        self.segments = segments

    def transcribe(self, path):
        self.transcribed.append(path.name)
        if path.name == self.fail_on:
            raise RuntimeError("받아쓰기 실패")
        return self.segments, 120.0

    def extract_frames(self, path):
        self.captured.append(path.name)
        return FRAMES

    def make_guide(self, title, segments, frames):
        self.guided.append(title)
        self.frames_seen.append(frames)
        return GUIDE


def make_videos(root, *names):
    root.mkdir(parents=True, exist_ok=True)
    for name in names:
        (root / name).write_bytes(b"x")
    return {v["title"]: v["id"] for v in find_videos(root)}


def test_analyzes_new_videos_and_saves_results(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    rec = Recorder()

    failures = analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide, rec.extract_frames)

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

    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, rec.make_guide, rec.extract_frames)

    assert rec.transcribed == []
    assert rec.guided == ["2강"]


def test_force_redoes_everything(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    save_analysis(tmp_path / "data", ids["1강"], {"title": "1강", "segments": SEGMENTS, "guide": GUIDE})
    rec = Recorder()

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide, rec.extract_frames, force=True)

    assert rec.transcribed == ["1강.mp4"]


def test_one_failure_does_not_stop_the_rest(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4", "2강.mp4")
    rec = Recorder(fail_on="1강.mp4")

    failures = analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide, rec.extract_frames)

    assert failures == 1
    assert load_analysis(tmp_path / "data", ids["1강"]) is None
    assert load_analysis(tmp_path / "data", ids["2강"])["guide"] == GUIDE


def test_silent_video_skips_claude(tmp_path):
    ids = make_videos(tmp_path / "videos", "무음.mp4")
    rec = Recorder(segments=[])

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide, rec.extract_frames)

    assert rec.guided == []
    assert rec.captured == []
    assert load_analysis(tmp_path / "data", ids["무음"])["guide"]["chapters"] == []


def test_saves_only_chosen_frames_once(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    rec = Recorder()

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide, rec.extract_frames)

    assert rec.captured == ["1강.mp4"]
    assert rec.frames_seen == [FRAMES]
    frame_dir = tmp_path / "data" / "frames" / ids["1강"]
    assert list(frame_dir.iterdir()) == [frame_dir / "60.jpg"]
    assert (frame_dir / "60.jpg").read_bytes() == b"B"
    assert [c["board"] for c in load_analysis(tmp_path / "data", ids["1강"])["guide"]["chapters"]] == [60, 60]


@pytest.mark.parametrize("make_dir", [True, False], ids=["empty-folder", "missing-folder"])
def test_cli_tells_user_when_no_videos_found(tmp_path, make_dir):
    video_dir = tmp_path / "videos"
    if make_dir:
        video_dir.mkdir()
    env = {**os.environ, "VIDEO_DIR": str(video_dir), "DATA_DIR": str(tmp_path / "data")}

    result = subprocess.run([sys.executable, "-m", "academy.analyze"], cwd=PROJECT_ROOT,
                            env=env, capture_output=True, text=True)

    assert result.returncode == 1
    assert str(video_dir.resolve()) in result.stderr


def test_cli_stops_before_transcribing_when_pillow_is_missing(tmp_path):
    # 판서 사진 기능 전에 설치한 컴퓨터에는 Pillow가 없습니다. 받아쓰기 전에 알려 줘야 합니다.
    make_videos(tmp_path / "videos", "1강.mp4")
    (tmp_path / "fake" / "PIL").mkdir(parents=True)
    (tmp_path / "fake" / "PIL" / "__init__.py").write_text(
        'raise ModuleNotFoundError("No module named \'PIL\'", name="PIL")', encoding="utf-8")
    env = {**os.environ, "VIDEO_DIR": str(tmp_path / "videos"), "DATA_DIR": str(tmp_path / "data"),
           "PYTHONPATH": str(tmp_path / "fake")}

    result = subprocess.run([sys.executable, "-m", "academy.analyze"], cwd=PROJECT_ROOT,
                            env=env, capture_output=True, text=True)

    assert result.returncode == 1
    assert "pip install -r requirements.txt" in result.stderr
    assert "받아쓰는 중" not in result.stdout


def test_broken_analysis_file_fails_only_that_video(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4", "2강.mp4")
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / f"{ids['1강']}.json").write_text('{"title": "1강",}', encoding="utf-8")  # 손으로 고치다 생긴 오타
    rec = Recorder()

    failures = analyze_all(tmp_path / "videos", data_dir, rec.transcribe, rec.make_guide, rec.extract_frames)

    assert failures == 1
    assert load_analysis(data_dir, ids["2강"])["guide"] == GUIDE
