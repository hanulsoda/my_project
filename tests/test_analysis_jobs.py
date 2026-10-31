"""분석·밤 작업(academy.analyze, academy.toc)의 버그 찾기에서 나온 경우들."""

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


def moved_site(tmp_path, *names):
    videos = tmp_path / "videos"
    for name in names:
        (videos / name).parent.mkdir(parents=True, exist_ok=True)
        (videos / name).write_bytes(b"x")
    return videos, tmp_path / "data"


def test_a_lecture_moved_to_a_renamed_folder_keeps_its_analysis(tmp_path, capsys):
    videos, data_dir = moved_site(tmp_path, "2022개정/1강 제망매가.mp4")
    rec = Recorder()
    run = lambda: analyze_all(videos, data_dir, rec.transcribe, rec.make_guide, detect_pages=rec.detect_pages,
                              probe=lambda path: 120.4)  # 영상 길이(받아쓰기 길이 120초와 1초 안)
    run()
    old_id = find_videos(videos)[0]["id"]
    (data_dir / old_id / "0.jpg").parent.mkdir(parents=True, exist_ok=True)
    (data_dir / old_id / "0.jpg").write_bytes(b"jpg")
    (videos / "2022개정").rename(videos / "2022 개정 교육과정")  # 선생님이 폴더 이름을 바꿈

    run()

    new = find_videos(videos)[0]
    assert rec.transcribed == ["1강 제망매가.mp4"] and len(rec.guided) == 1  # 받아쓰기·Claude를 다시 하지 않음
    moved = load_analysis(data_dir, new["id"])
    assert moved["title"] == "2022 개정 교육과정/1강 제망매가" and moved["guide"] == GUIDE
    assert load_analysis(data_dir, old_id) is None and (data_dir / new["id"] / "0.jpg").exists()
    assert "옮긴" in capsys.readouterr().out


@pytest.mark.parametrize("case", ["different-length", "two-candidates"])
def test_a_new_lecture_is_analyzed_when_the_old_analysis_is_not_clearly_its_own(tmp_path, case):
    names = ["A/1강.mp4"] if case == "different-length" else ["A/1강.mp4", "B/1강.mp4"]
    videos, data_dir = moved_site(tmp_path, *names)
    rec = Recorder()
    analyze_all(videos, data_dir, rec.transcribe, rec.make_guide)
    for folder in {name.split("/")[0] for name in names}:
        (videos / folder).rename(videos / f"{folder}-옮김")

    analyze_all(videos, data_dir, rec.transcribe, rec.make_guide, probe=lambda path: 300.0 if case == "different-length" else 120.0)

    assert len(rec.transcribed) == 2 * len(names)  # 길이가 다르거나 후보가 둘이면 짐작하지 않고 새로 분석


def test_a_silent_lecture_shows_its_academy_summary(tmp_path):
    from fastapi.testclient import TestClient

    from academy.analyze import SILENT_GUIDE
    from academy.server import create_app
    ids = make_videos(tmp_path / "videos", "제망매가.mp4", "청산별곡.mp4")
    data_dir = tmp_path / "data"
    save_analysis(data_dir, ids["청산별곡"], {"title": "청산별곡", "duration": 60.0, "segments": [], "guide": SILENT_GUIDE,
                                           "pages": []})  # 예전 분석: 소리 없는 강의에 빈 요점 정리를 넣었음
    rec = Recorder(segments=[])

    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, rec.make_guide, detect_pages=rec.detect_pages)

    assert rec.guided == []
    assert load_analysis(data_dir, ids["청산별곡"])["guide"] is None  # 다음 실행에서 빈 요점 정리를 걷어 냄
    refs = [{"title": title, "grade": "고1", "meta": {"갈래": "고전 시가"}} for title in ("제망매가", "청산별곡")]
    client = TestClient(create_app(tmp_path / "videos", data_dir, None, refs))
    for title in ("제망매가", "청산별곡"):
        assert client.get(f"/api/videos/{ids[title]}").json()["references"], title  # 판서만 있는 강의도 학원 정리를 봄


def test_a_force_run_whose_guide_step_failed_finishes_on_a_plain_rerun(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    data_dir = tmp_path / "data"
    save_analysis(data_dir, ids["1강"], {"title": "1강", "duration": 120.0, "segments": SEGMENTS, "guide": {"summary": "예전"}})
    rec = Recorder()

    def out_of_credit(*args):
        raise RuntimeError("사용 한도에 닿음")

    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, out_of_credit, force=True)
    assert load_analysis(data_dir, ids["1강"])["guide"] == {"summary": "예전"}  # 학생은 그동안 예전 요점 정리를 봄

    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, rec.make_guide)  # 다음 달, --force 없이

    assert rec.transcribed == ["1강.mp4"] and rec.guided == ["1강"]  # 받아쓰기는 다시 하지 않고 요점 정리만 새로
    assert load_analysis(data_dir, ids["1강"])["guide"] == GUIDE
    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, rec.make_guide)
    assert rec.guided == ["1강"]  # 새 요점 정리가 생긴 뒤에는 다시 묻지 않음


def test_a_moved_lecture_is_recorded_so_picks_follow_it(tmp_path):
    from fastapi.testclient import TestClient

    from academy.server import create_app
    videos, data_dir = moved_site(tmp_path, "2022개정/1강 제망매가.mp4")
    rec = Recorder()
    run = lambda: analyze_all(videos, data_dir, rec.transcribe, rec.make_guide, probe=lambda path: 120.0)
    run()
    old_id = find_videos(videos)[0]["id"]
    teacher = {"x-teacher-key": "teacher-key-123"}
    TestClient(create_app(videos, data_dir, None, teacher_key="teacher-key-123")).put("/api/picks", json={"ids": [old_id]},
                                                                                      headers=teacher)
    (videos / "2022개정").rename(videos / "2022 개정")
    run()
    new_id = find_videos(videos)[0]["id"]

    client = TestClient(create_app(videos, data_dir, None))
    assert client.get("/api/moves").json() == {old_id: new_id}  # 학생 기기가 이어 보기·메모를 옮길 때 씀
    assert [l["id"] for l in client.get("/api/picks").json()["lectures"]] == [new_id]  # '이번 주 강의'도 따라감


def test_a_force_run_without_claude_does_not_buy_the_guide_again_the_next_night(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    data_dir = tmp_path / "data"
    save_analysis(data_dir, ids["1강"], {"title": "1강", "duration": 120.0, "segments": SEGMENTS, "guide": {"summary": "예전"}})
    rec = Recorder()

    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, None, force=True)  # --force --no-guide: 받아쓰기만 새로
    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, rec.make_guide)  # 다음 밤 작업

    assert rec.guided == []  # 비용을 들인 요점 정리를 강의마다 다시 사지 않음
    assert load_analysis(data_dir, ids["1강"])["guide"] == {"summary": "예전"}


def test_a_video_moved_away_during_the_run_does_not_stop_the_rest(tmp_path):
    make_videos(tmp_path / "videos", "1강.mp4", "2강.mp4", "3강.mp4")
    for path in (tmp_path / "videos").iterdir():
        age(path, 3600)
    rec = Recorder()

    def transcribe(path):
        (tmp_path / "videos" / "2강.mp4").unlink(missing_ok=True)  # 1강을 받아쓰는 동안 선생님이 2강을 다른 폴더로 옮김
        return rec.transcribe(path)

    failures = analyze_all(tmp_path / "videos", tmp_path / "data", transcribe, rec.make_guide, settle_seconds=600,
                           probe=lambda path: 120.0)

    assert rec.transcribed == ["1강.mp4", "3강.mp4"] and failures == 1


def test_an_unreadable_file_in_the_data_folder_does_not_stop_the_analysis(tmp_path):
    make_videos(tmp_path / "videos", "1강.mp4")
    (tmp_path / "data" / "old-thing.json").mkdir(parents=True)  # 이름만 .json인 폴더(읽을 수 없는 파일과 같음)
    rec = Recorder()

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide, probe=lambda path: 120.0)

    assert rec.transcribed == ["1강.mp4"]


@pytest.mark.parametrize("when", ["analyzed-now", "analyzed-before-sizes-were-kept"])
def test_a_new_lecture_with_the_same_name_and_length_does_not_take_a_deleted_lectures_analysis(tmp_path, when):
    videos, data_dir = moved_site(tmp_path, "2025 고1/1강.mp4")
    rec = Recorder()
    run = lambda: analyze_all(videos, data_dir, rec.transcribe, rec.make_guide, probe=lambda path: 120.0)
    if when == "analyzed-now":
        run()
    else:
        save_analysis(data_dir, find_videos(videos)[0]["id"], {"title": "2025 고1/1강", "duration": 120.0,
                                                               "segments": SEGMENTS, "guide": GUIDE})
        run()  # 밤 작업이 지금 있는 강의의 파일 크기를 적어 둠
    (videos / "2025 고1" / "1강.mp4").unlink()  # 작년 폴더를 지움(분석 파일은 남음)
    (videos / "2026 고1").mkdir()
    (videos / "2026 고1" / "1강.mp4").write_bytes(b"new recording")  # 올해 새 1강(길이는 우연히 같음)

    run()

    assert rec.transcribed[-1] == "1강.mp4" and len(rec.transcribed) == (2 if when == "analyzed-now" else 1)


def test_an_analysis_kept_before_file_sizes_were_recorded_is_still_carried_over_when_moved(tmp_path):
    videos, data_dir = moved_site(tmp_path, "A/1강.mp4")
    save_analysis(data_dir, find_videos(videos)[0]["id"], {"title": "A/1강", "duration": 120.0, "segments": SEGMENTS,
                                                           "guide": GUIDE})
    (videos / "A").rename(videos / "B")  # 크기를 적기 전에 옮김
    rec = Recorder()

    analyze_all(videos, data_dir, rec.transcribe, rec.make_guide, probe=lambda path: 120.0)

    assert rec.transcribed == [] and load_analysis(data_dir, find_videos(videos)[0]["id"])["guide"] == GUIDE


def test_two_batches_running_together_do_not_both_take_one_old_analysis(tmp_path):
    import shutil
    videos, data_dir = moved_site(tmp_path, "A/1강.mp4")
    rec = Recorder()
    analyze_all(videos, data_dir, rec.transcribe, rec.make_guide, detect_pages=rec.detect_pages)
    (videos / "A").rename(videos / "B")
    (videos / "C").mkdir()
    shutil.copyfile(videos / "B" / "1강.mp4", videos / "C" / "1강.mp4")  # 같은 녹화를 다른 반 폴더에도 올림
    started = []

    def probe(path):  # 1/2 묶음이 길이를 재는 사이에 함께 돌던 2/2 묶음이 같은 예전 분석을 먼저 가져감
        if not started:
            started.append(path)
            analyze_all(videos, data_dir, rec.transcribe, rec.make_guide, part=(2, 2), detect_pages=rec.detect_pages,
                        probe=lambda p: 120.0)
        return 120.0

    analyze_all(videos, data_dir, rec.transcribe, rec.make_guide, part=(1, 2), detect_pages=rec.detect_pages, probe=probe)

    assert len(rec.transcribed) == 2  # 처음 한 번 + 둘째 강의는 새로 받아씀(그림 없는 페이지 목록을 물려받지 않음)


def test_a_guide_left_to_redo_is_still_redone_after_a_force_run_without_claude(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    data_dir = tmp_path / "data"
    save_analysis(data_dir, ids["1강"], {"title": "1강", "duration": 120.0, "segments": SEGMENTS, "guide": {"summary": "예전"}})
    rec = Recorder()

    def out_of_credit(*args):
        raise RuntimeError("사용 한도에 닿음")

    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, out_of_credit, force=True)  # 새 요점 정리를 못 만듦
    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, None, force=True)  # 그 뒤 --force --no-guide
    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, rec.make_guide)

    assert rec.guided == ["1강"]


def test_a_new_lecture_at_a_moved_lectures_old_place_keeps_its_own_picks(tmp_path):
    from fastapi.testclient import TestClient

    from academy.library import record_move
    from academy.server import create_app
    videos, data_dir = moved_site(tmp_path, "고1/1강.mp4", "2025/고1/1강.mp4")
    ids = {v["title"]: v["id"] for v in find_videos(videos)}
    new, old = ids["고1/1강"], ids["2025/고1/1강"]
    data_dir.mkdir()
    record_move(data_dir, new, old)  # 작년에 고1을 2025/고1로 옮겼고, 올해 같은 자리(같은 번호)에 새 1강
    (data_dir / ".moved-lectures").write_text((data_dir / ".moved-lectures").read_text()[:-1] + ', "x": ["y"]}')
    teacher = {"x-teacher-key": "teacher-key-123"}
    client = TestClient(create_app(videos, data_dir, None, teacher_key="teacher-key-123"))
    client.put("/api/picks", json={"ids": [new]}, headers=teacher)

    assert client.get("/api/moves").json() == {}  # 학생 기기가 새 1강의 기록을 작년 녹화로 옮기지 않음
    assert [l["id"] for l in client.get("/api/picks").json()["lectures"]] == [new]  # 손으로 고친 줄이 있어도 500 없이


def test_a_night_run_with_nothing_to_do_leaves_the_analysis_files_alone(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    data_dir = tmp_path / "data"
    save_analysis(data_dir, ids["1강"], {"title": "1강", "duration": 120.0, "segments": SEGMENTS, "guide": GUIDE})
    path = data_dir / f"{ids['1강']}.json"
    age(path, 3600)
    before = path.stat().st_mtime_ns

    analyze_all(tmp_path / "videos", data_dir, Recorder().transcribe, None, probe=lambda p: 120.0)

    # 파일 시각은 현황의 '최근 3일 동안 만든 목차' 셈에 쓰이고, 바뀌면 서버가 3,900개를 다시 읽습니다
    assert path.stat().st_mtime_ns == before


def test_a_force_run_without_claude_keeps_the_old_guides_spelling_fixes(tmp_path):
    ids = make_videos(tmp_path / "videos", "1강.mp4")
    data_dir = tmp_path / "data"
    guide = {**GUIDE, "corrections": [{"wrong": "재망매가", "right": "제망매가"}]}
    save_analysis(data_dir, ids["1강"], {"title": "1강", "duration": 120.0, "segments": SEGMENTS, "guide": guide})
    rec = Recorder(segments=[{"start": 0.0, "end": 2.0, "text": "오늘은 재망매가를 봅니다"}])

    analyze_all(tmp_path / "videos", data_dir, rec.transcribe, None, force=True)  # --force --no-guide

    assert load_analysis(data_dir, ids["1강"])["segments"][0]["text"] == "오늘은 제망매가를 봅니다"  # 대본 탭·검색
