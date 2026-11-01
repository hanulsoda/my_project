"""전체 점검 4단계(운영 편의): 원장님이 서버 기록을 보지 않아도 현황 화면·설정 점검에서 무엇이 멈췄는지 알 수 있게."""

import os
import time
from pathlib import Path

from fastapi.testclient import TestClient

import academy.server as server
from academy.library import find_videos, save_analysis
from academy.server import create_app

SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "안녕하세요"}]


def site(tmp_path, *names):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    for name in names:
        (video_dir / f"{name}.mp4").write_bytes(b"x")
    return video_dir, data_dir, {v["title"]: v["id"] for v in find_videos(video_dir)}


def test_status_names_lectures_whose_paid_guide_keeps_coming_back_incomplete(tmp_path):
    video_dir, data_dir, ids = site(tmp_path, "1강", "2강")
    save_analysis(data_dir, ids["1강"], {"title": "1강", "segments": SEGMENTS, "guide": None, "guide_failures": 2})
    save_analysis(data_dir, ids["2강"], {"title": "2강", "segments": SEGMENTS, "guide": None, "guide_failures": 1})

    status = TestClient(create_app(video_dir, data_dir, None)).get("/api/status").json()

    assert status["guide_failed"] == ["1강"]  # 두 번 잘린 강의는 밤마다 다시 사지 않아 --retry-failed가 필요함


def test_status_says_when_the_video_folder_looks_empty(tmp_path, monkeypatch):
    video_dir, data_dir, ids = site(tmp_path)
    assert TestClient(create_app(video_dir, data_dir, None)).get("/api/status").json()["video_dir_empty"] is True

    (video_dir / "1강.mp4").write_bytes(b"x")
    client = TestClient(create_app(video_dir, data_dir, None))
    assert client.get("/api/status").json()["video_dir_empty"] is False
    (video_dir / "1강.mp4").unlink()  # 서버가 켜져 있는 동안 NAS 연결이 끊김
    monkeypatch.setattr(server, "REFRESH_SECONDS", 0)
    deadline = time.monotonic() + 5
    while not client.get("/api/status").json()["video_dir_empty"] and time.monotonic() < deadline:
        time.sleep(0.05)

    status = client.get("/api/status").json()
    assert status["video_dir_empty"] is True and status["total"] == 1  # 학생 목록은 이전 것을 그대로 씀


def test_recent_tables_of_contents_are_counted_by_when_they_were_made(tmp_path):
    video_dir, data_dir, ids = site(tmp_path, "어제", "열흘 전")
    for name, days in [("어제", 1), ("열흘 전", 10)]:
        save_analysis(data_dir, ids[name], {"title": name, "segments": SEGMENTS, "toc": {
            "model": "m", "chapters": [], "at": int(time.time() - days * 86400)}})
    os.utime(data_dir / f"{ids['열흘 전']}.json")  # 백업을 되살려 파일 날짜만 오늘로 바뀜

    progress = TestClient(create_app(video_dir, data_dir, None)).get("/api/status").json()["toc_progress"]

    assert progress == {"target": 2, "done": 2, "last_3_days": 1}


# ---- 설정 파일 하나를 서버·밤 작업·설정 점검이 함께 읽음 ----

def test_settings_are_read_from_one_file_that_cron_and_the_server_share(tmp_path):
    from academy.settings import load_env_file
    settings = tmp_path / "academy.env"
    settings.write_text("# 학원 설정\nVIDEO_DIR=/NAS/강의\nexport DATA_DIR=\"/NAS/분석\"\nLOG_DIR='~/logs'\n\n"
                        "ANTHROPIC_API_KEY = test-key\n", encoding="utf-8")
    env = {"ACADEMY_ENV": str(settings), "VIDEO_DIR": "/명령에 적은 곳"}

    assert load_env_file(env) == settings
    assert env == {"ACADEMY_ENV": str(settings), "VIDEO_DIR": "/명령에 적은 곳",  # 명령 앞에 적은 값이 이김
                   "DATA_DIR": "/NAS/분석", "LOG_DIR": os.path.expanduser("~/logs"),  # 셸처럼 ~는 집 폴더
                   "ANTHROPIC_API_KEY": "test-key"}


def test_the_settings_file_is_optional_but_a_named_or_broken_one_is_not(tmp_path, monkeypatch):
    import pytest

    from academy.settings import load_env_file
    monkeypatch.setenv("HOME", str(tmp_path))
    env = {}
    assert load_env_file(env) is None and env == {}  # ~/.config/academy/academy.env가 없으면 예전처럼

    with pytest.raises(SystemExit, match="설정 파일"):
        load_env_file({"ACADEMY_ENV": str(tmp_path / "없는 파일")})
    (tmp_path / "bad.env").write_text("VIDEO_DIR=/NAS\n영상 폴더 /NAS\n", encoding="utf-8")
    with pytest.raises(SystemExit, match="2번째 줄"):
        load_env_file({"ACADEMY_ENV": str(tmp_path / "bad.env")})


def test_the_check_names_the_settings_file_it_read(tmp_path, capsys):
    from academy.check import main
    settings = tmp_path / "academy.env"
    settings.write_text(f"VIDEO_DIR={tmp_path / '없음'}\n", encoding="utf-8")

    main({"ACADEMY_ENV": str(settings)})

    out = capsys.readouterr().out
    assert str(settings) in out and str(tmp_path / "없음") in out


# ---- 분석 실행: 비용이 드는 실수를 막고 결과를 날짜 줄로 남김 ----

def analysis_site(tmp_path, monkeypatch, *names):
    from tests.test_analyze import make_videos
    ids = make_videos(tmp_path / "videos", *names)
    (tmp_path / "data").mkdir()
    monkeypatch.setenv("HOME", str(tmp_path))  # 이 컴퓨터의 설정 파일을 읽지 않게
    monkeypatch.delenv("ACADEMY_ENV", raising=False)
    monkeypatch.setenv("VIDEO_DIR", str(tmp_path / "videos"))
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    return ids


def run_main(monkeypatch, *args):
    import sys

    import pytest

    from academy import analyze
    calls = []
    monkeypatch.setattr(analyze, "analyze_all", lambda *a, **k: calls.append(k) or 0)
    monkeypatch.setattr(sys, "argv", ["academy.analyze", *args])
    try:
        analyze.main()
    except SystemExit as e:
        return calls, e.code
    return calls, None


def test_the_analysis_says_what_to_do_without_an_api_key(tmp_path, monkeypatch):
    analysis_site(tmp_path, monkeypatch, "1강.mp4")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    calls, stop = run_main(monkeypatch)

    assert not calls and "ANTHROPIC_API_KEY" in stop and "--no-guide" in stop
    assert run_main(monkeypatch, "--no-guide")[0]  # 키 없이 받아쓰기·페이지만은 됨


def test_the_analysis_ends_with_a_dated_line(tmp_path, monkeypatch, capsys):
    import re
    analysis_site(tmp_path, monkeypatch, "1강.mp4")

    run_main(monkeypatch, "--no-guide")

    last = capsys.readouterr().out.strip().splitlines()[-1]
    assert re.match(r"\d{4}-\d\d-\d\d \d\d:\d\d ", last) and "분석" in last  # 현황의 '새 강의 분석'


def test_force_shows_the_cost_and_needs_yes_before_buying_every_guide_again(tmp_path, monkeypatch):
    ids = analysis_site(tmp_path, monkeypatch, "1강.mp4", "2강.mp4", "3강.mp4")
    for title in ["1강", "2강"]:
        save_analysis(tmp_path / "data", ids[title], {"title": title, "duration": 3600.0, "segments": SEGMENTS})
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    calls, stop = run_main(monkeypatch, "--force")
    assert not calls and "2개" in stop and "2시간" in stop and "$" in stop and "--yes" in stop
    assert run_main(monkeypatch, "--force", "--yes")[0]
    assert run_main(monkeypatch, "--force", "--no-guide")[0]  # Claude 비용이 들지 않음
    calls, stop = run_main(monkeypatch, "--force", "--only", "3강")  # 아직 분석하지 않은 강의만: 다시 사는 것 없음
    assert calls and calls[0]["only"] == "3강"


def test_only_lectures_whose_title_has_the_text_are_analyzed(tmp_path):
    import unicodedata

    from academy.analyze import analyze_all
    from tests.test_analyze import Recorder, make_videos
    make_videos(tmp_path / "videos", "1강 제망매가.mp4", "2강 청산별곡.mp4")
    (tmp_path / "data").mkdir()
    rec = Recorder()

    analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide,
                only=unicodedata.normalize("NFD", "제망매가"))  # 맥 터미널에서 친 한글(자모로 나뉨)

    assert rec.transcribed == ["1강 제망매가.mp4"]


def test_model_settings_in_the_file_are_used_even_though_they_are_read_after_import(monkeypatch):
    from academy import ai, toc
    from tests.fakes import FakeClient
    monkeypatch.setenv("CLAUDE_MODEL", "claude-from-file")  # 설정 파일은 main()에서 읽혀 모듈보다 늦음
    client = FakeClient("답")

    ai._ask_claude(client, max_tokens=10, messages=[])

    assert client.requests[0]["model"] == "claude-from-file"
    monkeypatch.setenv("TOC_MODEL", "toc-from-file")
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test:1")
    seen = []
    monkeypatch.setattr(toc.urllib.request, "urlopen", lambda req, timeout: seen.append(req) or (_ for _ in ()).throw(OSError()))
    try:
        toc.ollama_ask("목차", {})
    except OSError:
        pass
    assert seen[0].full_url.startswith("http://ollama.test:1/") and b"toc-from-file" in seen[0].data


def test_the_server_reads_the_settings_file_and_asks_claude_only_when_turned_on(tmp_path):
    import subprocess
    import sys
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    (video_dir / "1강.mp4").write_bytes(b"x")
    vid = find_videos(video_dir)[0]["id"]
    save_analysis(data_dir, vid, {"title": "1강", "duration": 2.0, "segments": SEGMENTS, "guide": None})

    def ask_shown(*lines):
        settings = tmp_path / "academy.env"
        settings.write_text("\n".join([f"VIDEO_DIR={video_dir}", f"DATA_DIR={data_dir}", *lines]), encoding="utf-8")
        code = ("from fastapi.testclient import TestClient; import academy.server as s; "
                f"print(TestClient(s.app).get('/api/videos/{vid}').json()['ask'])")
        run = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=Path(__file__).parent.parent,
                             env={**os.environ, "ACADEMY_ENV": str(settings), "HOME": str(tmp_path)})
        assert run.returncode == 0, run.stderr
        return run.stdout.strip()

    assert ask_shown() == "False"  # 질문하기는 Claude 비용이 들어 꺼 둠(플레이어에 탭이 나오지 않음)
    assert ask_shown("ASK_ENABLED=false") == "False"  # '끔'으로 적은 값이 비용이 드는 쪽으로 켜지지 않게
    assert ask_shown("ASK_ENABLED=1", "LOG_DIR=~/logs") == "True"
    assert (tmp_path / "logs").is_dir()  # 설정 파일의 ~는 집 폴더(셸이 풀어 주지 않아도)


def test_a_log_folder_with_a_tilde_and_a_folder_that_refuses_writes_are_checked(tmp_path, monkeypatch):
    from academy import check
    from tests.test_check import problems, setup
    env, _ = setup(tmp_path)
    monkeypatch.setenv("HOME", str(tmp_path))
    env["LOG_DIR"] = "~/logs"  # 따옴표 안에 적어 셸이 풀어 주지 않음

    assert any(level == "확인" and "로그 폴더" in text for level, text in check.checks(env))

    real = check.tempfile.NamedTemporaryFile

    def refuse(*args, dir=None, **kwargs):  # 다른 계정이 만든 로그 폴더(권한 없음)
        if Path(dir) == tmp_path / "logs":
            raise PermissionError(13, "Permission denied")
        return real(*args, dir=dir, **kwargs)
    monkeypatch.setattr(check.tempfile, "NamedTemporaryFile", refuse)
    assert any("로그 폴더" in text and "쓸 수 없" in text for text in problems(env))


def test_key_and_summary_files_saved_by_windows_notepad_are_handled(tmp_path):
    import pytest

    from academy.references import read_references
    from academy.settings import teacher_key
    from tests.test_check import problems, setup
    env, _ = setup(tmp_path)
    refs = tmp_path / "refs.json"
    refs.write_bytes("﻿".encode() + refs.read_bytes())  # 메모장이 붙이는 BOM
    assert read_references(refs) and not problems(env)

    (tmp_path / "key").write_text("teacher-key-1234", encoding="utf-16")  # 메모장 '유니코드' 저장
    with pytest.raises(SystemExit, match="UTF-8"):
        teacher_key(tmp_path / "key")
    assert any("UTF-8" in text for text in problems(env))


def test_a_missing_or_broken_summary_file_stops_with_one_korean_line(tmp_path):
    import pytest

    from academy.references import read_references
    with pytest.raises(SystemExit, match="학원 정리 파일"):
        read_references(tmp_path / "없는.json")
    (tmp_path / "broken.json").write_text('[{"title": "제망매가",}]', encoding="utf-8")
    with pytest.raises(SystemExit, match="REFERENCES_FILE"):
        read_references(tmp_path / "broken.json")


def test_a_key_file_the_server_account_cannot_read_is_a_problem(tmp_path, monkeypatch):
    import pathlib

    from tests.test_check import problems, setup
    env, _ = setup(tmp_path)
    real = pathlib.Path.read_bytes
    monkeypatch.setattr(pathlib.Path, "read_bytes", lambda self: (_ for _ in ()).throw(PermissionError(13, "Permission denied"))
                        if self == tmp_path / "key" else real(self))

    assert any("선생님 열쇠" in text and "읽기 권한" in text for text in problems(env))


def test_the_saved_index_is_refreshed_while_the_server_runs_for_weeks(tmp_path, monkeypatch):
    import json
    video_dir, data_dir, ids = site(tmp_path, "1강")
    client = TestClient(create_app(video_dir, data_dir, None))
    client.get("/api/videos")
    monkeypatch.setattr(server, "INDEX_SAVE_SECONDS", 0)  # 실제는 한 시간
    save_analysis(data_dir, ids["1강"], {"title": "1강", "duration": 60.0, "segments": SEGMENTS})  # 밤에 새로 분석됨

    index = data_dir / ".server-index.cache"
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and ids["1강"] not in (
            json.loads(index.read_text(encoding="utf-8"))["entries"] if index.exists() else {}):
        client.get("/api/videos")
        time.sleep(0.05)

    # 정전으로 꺼졌다 켜져도 켠 뒤 분석된 강의를 처음부터 다시 읽지 않게
    assert ids["1강"] in json.loads(index.read_text(encoding="utf-8"))["entries"]


def test_the_last_line_for_a_name_wins_and_comments_after_values_are_dropped(tmp_path):
    from academy.settings import load_env_file
    settings = tmp_path / "academy.env"
    settings.write_text("ANTHROPIC_API_KEY=old-key\nLOG_DIR=/logs   # 로그 폴더\n"
                        "SITE_URL=\"https://x.example/#a\"  # 학원 사이트\nENTRY_SECRET=abc#def\n"
                        "ANTHROPIC_API_KEY=new-key\n", encoding="utf-8")  # 키를 고치려고 README 명령을 다시 돌림
    env = {"ACADEMY_ENV": str(settings)}

    load_env_file(env)

    assert env["ANTHROPIC_API_KEY"] == "new-key"  # 셸에서 읽을 때처럼 나중 줄
    assert env["LOG_DIR"] == "/logs" and env["SITE_URL"] == "https://x.example/#a" and env["ENTRY_SECRET"] == "abc#def"


def test_an_analysis_that_did_not_run_does_not_leave_a_finished_line(tmp_path, capsys):
    import re

    from academy.analyze import analyze_all, run_lock
    from tests.test_analyze import Recorder, make_videos
    make_videos(tmp_path / "videos", "1강.mp4")
    (tmp_path / "data").mkdir()
    rec = Recorder()
    held = run_lock(tmp_path / "data", (1, 1))  # 어젯밤 분석이 아직 돌고 있음
    try:
        assert analyze_all(tmp_path / "videos", tmp_path / "data", rec.transcribe, rec.make_guide) is None
    finally:
        held.close()
    last = capsys.readouterr().out.strip().splitlines()[-1]
    assert re.match(r"\d{4}-\d\d-\d\d \d\d:\d\d ", last) and "하지 않았습니다" in last  # 현황의 '새 강의 분석'

    (tmp_path / "empty").mkdir()  # NAS가 붙지 않음
    assert analyze_all(tmp_path / "empty", tmp_path / "data", rec.transcribe, rec.make_guide) is None
    last = capsys.readouterr().out.strip().splitlines()[-1]
    assert re.match(r"\d{4}-\d\d-\d\d \d\d:\d\d ", last) and "멈춥니다" in last and "영상이 없습니다" in last


def test_the_status_page_reads_only_the_end_of_a_long_log(tmp_path, monkeypatch):
    import pathlib
    video_dir, data_dir, ids = site(tmp_path, "1강")
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "toc.log").write_text("2026-10-30 07:00 자동 목차 3개 만듦\n" + "목차: 2022개정/고1/긴 강의 제목\n" * 20000,
                                  encoding="utf-8")  # 밤 작업이 도는 중: 날짜 줄이 한참 앞에 있음
    (logs / "new-videos.log").write_text("[1/1] 1강\n  이미 분석됨, 건너뜀\n" * 20000 + "2026-10-31 23:50 영상 분석 끝\n",
                                         encoding="utf-8")
    real = pathlib.Path.read_text
    monkeypatch.setattr(pathlib.Path, "read_text", lambda self, *a, **k: (_ for _ in ()).throw(AssertionError(
        f"로그를 통째로 읽음: {self}")) if self.suffix == ".log" else real(self, *a, **k))  # 1년 치면 현황마다 몇 초

    ops = TestClient(create_app(video_dir, data_dir, None, log_dir=logs)).get("/api/status").json()["ops"]

    assert ops["night"] == "2026-10-30 07:00 자동 목차 3개 만듦" and ops["new_videos"] == "2026-10-31 23:50 영상 분석 끝"


def test_the_toc_job_exits_with_an_error_when_the_video_folder_is_empty(tmp_path, monkeypatch):
    import sys

    import pytest

    from academy import toc
    (tmp_path / "videos").mkdir()
    (tmp_path / "data").mkdir()
    monkeypatch.setenv("VIDEO_DIR", str(tmp_path / "videos"))
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("REFERENCES_FILE", raising=False)
    monkeypatch.setattr(sys, "argv", ["academy.toc"])

    with pytest.raises(SystemExit) as stop:
        toc.main()

    assert stop.value.code == 1  # 75는 '아침이 되어 멈춤(다음 밤에 이어서)'
