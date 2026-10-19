import os
import subprocess
import sys
from pathlib import Path

import pytest

from academy.analyze import analyze_all, part_arg
from academy.library import find_videos, load_analysis, save_analysis, save_frame

PROJECT_ROOT = Path(__file__).resolve().parent.parent

SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "안녕하세요"}]
FRAMES = [(0, b"A"), (60, b"B")]
GUIDE = {"summary": "요약", "quiz": [], "chapters": [
    {"start": 0, "title": "도입", "points": [], "board": 60},
    {"start": 30, "title": "예제", "points": [], "board": 60},
]}


class Recorder:
    def __init__(self, fail_on=None, segments=SEGMENTS, guide=GUIDE):
        self.transcribed, self.guided, self.captured, self.frames_seen = [], [], [], []
        self.page_dirs = []
        self.fail_on = fail_on
        self.segments = segments
        self.guide = guide

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
        return self.guide

    def detect_pages(self, path, out_dir):
        self.page_dirs.append(out_dir)
        return [{"start": 0.0}]


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


@pytest.mark.parametrize("segments", [SEGMENTS, []], ids=["with-speech", "silent"])
def test_reanalysis_removes_old_photos(tmp_path, segments):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    frame_dir = tmp_path / "data" / "frames" / ids["1강"]
    save_frame(tmp_path / "data", ids["1강"], 999, b"old")  # 지난번 분석이 고른 사진
    rec = Recorder(segments=segments)

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide, rec.extract_frames,
                force=True)

    assert sorted(p.name for p in frame_dir.glob("*")) == (["60.jpg"] if segments else [])


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


def test_parts_split_videos_without_overlap(tmp_path):
    make_videos(tmp_path / "videos", "1강.mp4", "2강.mp4", "3강.mp4")
    first, second = Recorder(), Recorder()

    analyze_all(tmp_path / "videos", tmp_path / "data", first.transcribe, first.make_guide, first.extract_frames,
                part=(1, 2))
    analyze_all(tmp_path / "videos", tmp_path / "data", second.transcribe, second.make_guide, second.extract_frames,
                part=(2, 2))

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

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide, rec.extract_frames)

    segments = load_analysis(tmp_path / "data", ids["1강"])["segments"]
    assert segments[0]["text"] == "요령의 격률과 관용의 격률"


def test_finds_pages_and_adds_them_to_already_analyzed_videos(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4", "2강.mp4")
    data_dir = tmp_path / "data"
    save_analysis(data_dir, ids["1강"], {"title": "1강", "segments": SEGMENTS, "guide": GUIDE})
    rec = Recorder()

    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, rec.make_guide, rec.extract_frames,
                detect_pages=rec.detect_pages)

    assert rec.page_dirs == [data_dir / ids["1강"], data_dir / ids["2강"]]
    assert rec.transcribed == ["2강.mp4"]
    assert rec.guided == ["2강"]
    assert rec.captured == ["2강.mp4"]  # 요점 정리가 이미 있으면 판서 사진도 다시 찍지 않음
    assert load_analysis(data_dir, ids["1강"])["pages"] == [{"start": 0.0}]


def test_page_detection_failure_does_not_block_the_guide(tmp_path, capsys):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    rec = Recorder()
    tries = []

    def broken_pages(path, out_dir):
        tries.append(path.name)
        raise ValueError("페이지를 읽지 못함")  # 깨진 파일, 시각 정보가 없는 화면 등

    first = analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide, rec.extract_frames,
                        detect_pages=broken_pages)
    second = analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide, rec.extract_frames,
                         detect_pages=broken_pages)

    data = load_analysis(tmp_path / "data", ids["1강"])
    assert (first, second) == (0, 0)  # 페이지는 덤이라 실패로 세지 않음
    assert data["guide"] == GUIDE and data["pages"] == []
    assert tries == ["1강.mp4"]  # 다음 실행에서 같은 영상을 계속 다시 시도하지 않음
    assert "페이지" in capsys.readouterr().err


def test_without_guide_skips_claude_and_the_guide_can_be_added_later(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    first, later = Recorder(), Recorder()

    failures = analyze_all(tmp_path / "videos", tmp_path / "data", first.transcribe, None, first.extract_frames,
                           detect_pages=first.detect_pages)
    analyze_all(tmp_path / "videos", tmp_path / "data", later.transcribe, later.make_guide, later.extract_frames,
                detect_pages=later.detect_pages)

    assert failures == 0
    assert first.transcribed == ["1강.mp4"]
    assert first.captured == []  # 판서 사진은 요점 정리를 만들 때만 찍음
    assert (later.transcribed, later.page_dirs, later.guided) == ([], [], ["1강"])
    assert load_analysis(tmp_path / "data", ids["1강"])["guide"] == GUIDE
