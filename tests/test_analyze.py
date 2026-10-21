import sys

import numpy as np
import pytest

from academy.analyze import analyze_all, main, part_arg, tidy_repeats, voice_channel
from academy.library import find_videos, load_analysis, save_analysis

SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "안녕하세요"}]
GUIDE = {"summary": "요약", "chapters": [], "quiz": []}


class Recorder:
    def __init__(self, fail_on=None, segments=SEGMENTS, guide=GUIDE):
        self.transcribed, self.guided, self.page_dirs = [], [], []
        self.screen_reads, self.screens, self.references = [], [], []
        self.fail_on = fail_on
        self.segments = segments
        self.guide = guide

    def transcribe(self, path):
        self.transcribed.append(path.name)
        if path.name == self.fail_on:
            raise RuntimeError("받아쓰기 실패")
        return self.segments, 120.0

    def make_guide(self, title, segments, screens=None, references=None):
        self.guided.append(title)
        self.screens.append(screens)
        self.references.append(references)
        return self.guide

    def read_screens(self, path, pages, duration):
        self.screen_reads.append(path.name)
        return [["교재 글자"] for _ in pages]

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


def test_finds_pages_and_adds_them_to_already_analyzed_videos(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4", "2강.mp4")
    data_dir = tmp_path / "data"
    save_analysis(data_dir, ids["1강"], {"title": "1강", "segments": SEGMENTS, "guide": GUIDE})
    rec = Recorder()

    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, rec.make_guide, detect_pages=rec.detect_pages)

    assert rec.page_dirs == [data_dir / ids["1강"], data_dir / ids["2강"]]
    assert rec.transcribed == ["2강.mp4"]
    assert rec.guided == ["2강"]
    assert load_analysis(data_dir, ids["1강"])["pages"] == [{"start": 0.0}]


def test_without_guide_skips_claude_and_the_guide_can_be_added_later(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    first, later = Recorder(), Recorder()

    failures = analyze_all(tmp_path / "videos", tmp_path / "data", first.transcribe, None,
                           detect_pages=first.detect_pages)
    analyze_all(tmp_path / "videos", tmp_path / "data", later.transcribe, later.make_guide,
                detect_pages=later.detect_pages)

    assert failures == 0
    assert first.transcribed == ["1강.mp4"]
    assert (later.transcribed, later.page_dirs, later.guided) == ([], [], ["1강"])
    assert load_analysis(tmp_path / "data", ids["1강"])["guide"] == GUIDE


VOICE = np.sin(np.linspace(0, 300, 16000)).astype(np.float32)


def test_voice_channel_keeps_normal_stereo_as_is():
    assert np.allclose(voice_channel(VOICE, VOICE), VOICE)


def test_voice_channel_recovers_voice_from_phase_inverted_stereo():
    # 두 채널을 그냥 평균 내면 0이 되어 받아쓸 말소리가 사라집니다.
    assert np.allclose(voice_channel(VOICE, -VOICE), VOICE)


def seg(start, end, text):
    return {"start": start, "end": end, "text": text}


def test_tidy_merges_lines_repeated_back_to_back():
    segments = [seg(0, 1, "자 보자"), seg(1, 2, "니"), seg(2, 3, "니"), seg(3, 4, "니"), seg(4, 5, "다음")]

    assert tidy_repeats(segments) == [seg(0, 1, "자 보자"), seg(1, 4, "니"), seg(4, 5, "다음")]


def test_tidy_keeps_repeats_that_are_not_back_to_back():
    segments = [seg(0, 1, "그치?"), seg(1, 2, "이건 원관념"), seg(2, 3, "그치?")]

    assert tidy_repeats(segments) == segments


def test_tidy_keeps_one_of_a_word_repeated_four_or_more_times_in_a_line():
    assert tidy_repeats([seg(0, 9, "ㄱ, ㄴ, ㅇ, ㅇ, ㅇ, ㅇ, ㅇ,")]) == [seg(0, 9, "ㄱ, ㄴ, ㅇ,")]
    assert tidy_repeats([seg(0, 9, "네 네 네 알겠어요")]) == [seg(0, 9, "네 네 네 알겠어요")]


def test_guide_step_reads_screens_and_labels_pages(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    rec = Recorder(guide={**GUIDE, "page_labels": [{"start": 0, "label": "12쪽 · 도입"}]})

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide,
                detect_pages=rec.detect_pages, read_screens=rec.read_screens)

    data = load_analysis(tmp_path / "data", ids["1강"])
    assert rec.screens == [[{"start": 0.0, "text": ["교재 글자"]}]]
    assert data["pages"] == [{"start": 0.0, "text": ["교재 글자"], "label": "12쪽 · 도입"}]
    assert "page_labels" not in data["guide"]


def test_screens_are_read_only_when_making_a_guide(tmp_path):
    make_videos(tmp_path / "videos", "1강.mp4")
    rec = Recorder()

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, None,
                detect_pages=rec.detect_pages, read_screens=rec.read_screens)

    assert rec.screen_reads == []


def test_without_ocr_the_guide_uses_the_transcript_only(tmp_path):
    make_videos(tmp_path / "videos", "1강.mp4")
    rec = Recorder()

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide,
                detect_pages=rec.detect_pages)

    assert rec.screens == [None]


def test_guide_builds_on_matched_academy_summaries_and_records_them(tmp_path):
    ids = make_videos(tmp_path / "videos", "성난 풀잎.mp4")
    rec = Recorder(guide=dict(GUIDE))
    asked = []

    def find_references(title, screen_lines):
        asked.append((title, screen_lines))
        return [{"source": "고2 「성난 풀잎」", "text": "학원 정리 글"}]

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide,
                detect_pages=rec.detect_pages, read_screens=rec.read_screens, find_references=find_references)

    assert asked == [("성난 풀잎", ["교재 글자"])]
    assert rec.references == [["학원 정리 글"]]
    assert load_analysis(tmp_path / "data", ids["성난 풀잎"])["guide"]["sources"] == ["고2 「성난 풀잎」"]


def test_guide_without_a_matched_summary_gets_no_references(tmp_path):
    ids = make_videos(tmp_path / "videos", "녹화.mp4")
    rec = Recorder(guide=dict(GUIDE))

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide,
                detect_pages=rec.detect_pages, find_references=lambda title, lines: [])

    assert rec.references == [None]
    assert "sources" not in load_analysis(tmp_path / "data", ids["녹화"])["guide"]
