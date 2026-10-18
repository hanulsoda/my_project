from academy.analyze import analyze_all
from academy.library import find_videos, load_analysis, save_analysis

SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "안녕하세요"}]
GUIDE = {"summary": "요약", "chapters": [], "quiz": []}


class Recorder:
    def __init__(self, fail_on=None, segments=SEGMENTS):
        self.transcribed, self.guided = [], []
        self.fail_on = fail_on
        self.segments = segments

    def transcribe(self, path):
        self.transcribed.append(path.name)
        if path.name == self.fail_on:
            raise RuntimeError("받아쓰기 실패")
        return self.segments, 120.0

    def make_guide(self, title, segments):
        self.guided.append(title)
        return GUIDE


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
