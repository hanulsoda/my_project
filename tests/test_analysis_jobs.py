"""분석·밤 작업(academy.analyze, academy.toc)의 버그 찾기에서 나온 경우들."""

import fcntl
import json
import os
import re
import subprocess
import time

import pytest

from academy.analyze import analyze_all, run_lock, whisper_transcriber
from academy.library import find_videos, load_analysis, save_analysis
from academy.toc import MODEL, add_tocs
from tests.test_analyze import GUIDE, SEGMENTS, Recorder, make_videos
from tests.test_toc import answer


def age(path, seconds):
    old = time.time() - seconds
    os.utime(path, (old, old))


def test_a_video_still_being_copied_is_left_for_a_later_run(tmp_path, capsys):
    ids = make_videos(tmp_path / "videos", "1강.mp4", "2강.mp4")
    age(tmp_path / "videos" / "1강.mp4", 3600)  # 1강은 한 시간 전에 다 올라옴, 2강은 방금까지 복사 중
    rec = Recorder()

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide, settle_seconds=600)

    assert rec.transcribed == ["1강.mp4"]
    assert load_analysis(tmp_path / "data", ids["2강"]) is None  # 반쯤 받아쓴 결과를 '분석됨'으로 남기지 않음
    assert "복사" in capsys.readouterr().out
    age(tmp_path / "videos" / "2강.mp4", 3600)
    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide, settle_seconds=600)
    assert rec.transcribed == ["1강.mp4", "2강.mp4"]


def test_force_keeps_the_old_guide_toc_and_page_labels_until_a_new_guide_is_saved(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    data_dir = tmp_path / "data"
    save_analysis(data_dir, ids["1강"], {"title": "1강", "duration": 120.0, "segments": SEGMENTS, "guide": GUIDE,
                                        "toc": {"model": MODEL, "chapters": []}, "pages": [{"start": 0.0, "label": "12쪽"}]})
    rec = Recorder()

    def out_of_credit(*args):
        raise RuntimeError("사용 한도에 닿음")

    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, out_of_credit, force=True, detect_pages=rec.detect_pages)
    kept = load_analysis(data_dir, ids["1강"])
    assert kept["guide"] == GUIDE and kept["toc"] and kept["pages"] == [{"start": 0.0, "label": "12쪽"}]

    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, None, force=True, detect_pages=rec.detect_pages)  # --no-guide
    assert load_analysis(data_dir, ids["1강"])["guide"] == GUIDE
    assert rec.transcribed == ["1강.mp4", "1강.mp4"]  # 받아쓰기는 새로 함


def test_a_second_run_at_the_same_time_does_nothing(tmp_path, capsys):
    make_videos(tmp_path / "videos", "1강.mp4")
    first = run_lock(tmp_path / "data", (1, 1))  # 앞서 시작한 분석이 아직 도는 중
    rec = Recorder()

    assert analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide) == 0
    assert rec.transcribed == [] and "이미" in capsys.readouterr().out
    other_part = run_lock(tmp_path / "data", (2, 2))  # GPU마다 다른 묶음을 맡는 것은 함께 돌 수 있음
    assert other_part is not None

    first.close()
    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide)
    assert rec.transcribed == ["1강.mp4"]


@pytest.mark.parametrize("broken", ['{"title": "1강",}', "[1, 2]"], ids=["trailing-comma", "not-an-object"])
def test_a_hand_edited_analysis_file_does_not_stop_either_batch(tmp_path, capsys, broken):
    ids = make_videos(tmp_path / "videos", "1강.mp4", "2강.mp4")
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / f"{ids['1강']}.json").write_text(broken, encoding="utf-8")  # 손으로 고치다 형식이 깨짐
    rec = Recorder()

    failures = analyze_all(tmp_path / "videos", data_dir, rec.transcribe, rec.make_guide)

    assert failures == 1 and rec.transcribed == ["2강.mp4"]
    assert (data_dir / f"{ids['1강']}.json").read_text(encoding="utf-8") == broken  # 덮어쓰지 않음
    assert "형식" in capsys.readouterr().err
    save_analysis(data_dir, ids["2강"], {"title": "2강", "duration": 900.0, "segments": SEGMENTS})
    failures, finished = add_tocs(tmp_path / "videos", data_dir, answer(("00:05", "도입"), ("05:00", "전개")), lambda t: False)
    assert finished and load_analysis(data_dir, ids["2강"])["toc"]["chapters"]


def test_the_night_toc_keeps_a_guide_saved_while_it_waited(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    data_dir = tmp_path / "data"
    save_analysis(data_dir, ids["1강"], {"title": "1강", "duration": 900.0, "segments": SEGMENTS})

    def slow_ollama(prompt, schema):  # ollama를 기다리는 동안 분석이 Claude 요점 정리를 저장함
        save_analysis(data_dir, ids["1강"], {"title": "1강", "duration": 900.0, "segments": SEGMENTS, "guide": GUIDE})
        return answer(("00:05", "도입"), ("05:00", "전개"))(prompt, schema)

    add_tocs(tmp_path / "videos", data_dir, slow_ollama, lambda t: False)

    assert load_analysis(data_dir, ids["1강"])["guide"] == GUIDE


def test_the_night_toc_ends_with_a_dated_line_the_status_page_reads(tmp_path, capsys):
    from datetime import datetime
    ids = make_videos(tmp_path / "videos", "1강.mp4", "2강.mp4")
    for title in ids:
        save_analysis(tmp_path / "data", ids[title], {"title": title, "duration": 900.0, "segments": SEGMENTS})
    clock = iter([datetime(2026, 10, 22, 22, 0), datetime(2026, 10, 22, 23, 0), datetime(2026, 10, 23, 7, 1),
                  datetime(2026, 10, 23, 7, 1)])

    add_tocs(tmp_path / "videos", tmp_path / "data", answer(("00:05", "도입"), ("05:00", "전개")), lambda t: False,
             until="07:00", now=lambda: next(clock))

    last = capsys.readouterr().out.strip().splitlines()[-1]
    assert re.match(r"\d{4}-\d\d-\d\d \d\d:\d\d ", last)  # 현황 화면은 날짜로 시작하는 줄만 읽음
    assert "1개" in last and "멈춤" in last and "멈춥니다" not in last  # 매일 아침의 정상 종료를 '고장'으로 보이지 않게


def test_a_video_without_an_audio_track_gets_an_empty_transcript(tmp_path):
    path = tmp_path / "silent.mp4"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x36:d=3", str(path)], check=True)

    segments, duration = whisper_transcriber()(path)  # 받아쓰기 모델을 불러오지 않고 바로 돌려줌

    assert segments == [] and 2.5 <= duration <= 3.5
