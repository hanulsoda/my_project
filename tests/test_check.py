"""설정 점검(python -m academy.check): 원장님이 서버 기록을 보지 않아도 무엇이 문제인지 알 수 있게."""

import json

from academy.check import checks, main
from academy.library import find_videos, save_analysis

SEGMENTS = [{"start": 0.0, "end": 2.0, "text": "안녕하세요"}]


def setup(tmp_path, refs=None, key="teacher-key-123"):
    videos, data, logs = tmp_path / "videos", tmp_path / "data", tmp_path / "logs"
    (videos / "고1").mkdir(parents=True)
    for name in ["1강 제망매가.mp4", "2강 청산별곡.mp4"]:
        (videos / "고1" / name).write_bytes(b"x")
    ids = [v["id"] for v in find_videos(videos)]
    save_analysis(data, ids[0], {"title": "고1/1강 제망매가", "duration": 2.0, "segments": SEGMENTS, "guide": None})
    logs.mkdir()
    (tmp_path / "refs.json").write_text(json.dumps(refs if refs is not None else
                                                   [{"title": "제망매가", "grade": "고1", "meta": {"갈래": "향가"}}],
                                                   ensure_ascii=False), encoding="utf-8")
    (tmp_path / "key").write_text(key, encoding="utf-8")
    return {"VIDEO_DIR": str(videos), "DATA_DIR": str(data), "LOG_DIR": str(logs),
            "REFERENCES_FILE": str(tmp_path / "refs.json"), "TEACHER_KEY_FILE": str(tmp_path / "key")}, ids


def problems(env):
    return [text for level, text in checks(env) if level == "문제"]


def test_a_good_setup_has_no_problems(tmp_path, capsys):
    env, _ = setup(tmp_path)

    assert problems(env) == []
    assert main(env) == 0
    out = capsys.readouterr().out
    assert "강의 2개" in out and "분석 1개" in out and "학원 정리 1개" in out
    assert "teacher-key-123" not in out  # 열쇠는 보여 주지 않음


def test_each_mistake_is_named_in_korean(tmp_path, capsys):
    refs = [{"title": "제망매가", "grade": "고1", "meta": {"갈래": "향가"}}, {"title": "관동별곡", "grade": "고1", "meta": ["가사"]}]
    env, ids = setup(tmp_path, refs=refs, key="선생님열쇠")
    (tmp_path / "data" / f"{ids[1]}.json").write_text('{"title": "2강",}', encoding="utf-8")  # 손으로 고치다 깨짐
    env.update(ENTRY_SECRET="짧은키", LOG_DIR=str(tmp_path / "없는 폴더"))

    found = " / ".join(problems(env))

    assert "학원 정리" in found and "1개를 건너뜀" in found  # 모양이 다른 정리
    assert "형식" in found and ids[1] in found  # 깨진 분석 파일
    assert "영문" in found  # 한글 열쇠
    assert "ENTRY_SECRET" in found
    assert "로그 폴더" in found
    assert main(env) == 1
    assert "문제 5개" in capsys.readouterr().out


def test_a_missing_video_folder_is_a_problem_and_optional_settings_are_notes(tmp_path):
    env = {"VIDEO_DIR": str(tmp_path / "없음"), "DATA_DIR": str(tmp_path / "data")}

    found = checks(env)

    assert any(level == "문제" and "영상 폴더" in text for level, text in found)
    notes = " / ".join(text for level, text in found if level == "참고")
    assert "학원 정리" in notes and "선생님 열쇠" in notes and "내부망" in notes  # 안 쓰는 기능은 문제가 아님
