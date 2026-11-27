"""영상과 요점노트·시험대비의 연결 현황 보고(python -m academy.study_links)."""

import json

from academy.study_links import main, report
from tests.study_data import make_entry


def video(title, n=0):
    return {"id": f"{n:012x}", "title": title}


def test_report_counts_and_lists_each_kind():
    grade = ["고1", "미래엔"]
    entries = [make_entry(scope=grade),
               make_entry(id="midaen-5-1", unit="5-1", unit_title="다섯째 단원 이름입니다", works=["다섯작품"], scope=grade),
               make_entry(id="midaen-6-1", unit="6-1", unit_title="여섯째 단원 이름입니다", works=["여섯작품"], scope=grade),
               make_entry(id="midaen-6-1b", unit="6-1", unit_title="여섯째 겹치는 단원입니다", works=["겹침작품"], scope=grade)]
    videos = [video("고1/미래엔/4-2. 가짜작품 강의", 1),  # 이름으로도 맞음
              video("고1/미래엔/5-1. 아무 제목", 2),  # 번호로만 맞음
              video("고1/미래엔/6-1. 아무 제목", 3),  # 두 항목이 맞아 모호함
              video("고2/다른출판사/1강 제망매가", 4)]  # 연결 안 됨

    lines = report(videos, entries)

    assert lines == ["연결됨 1개 · 번호로만 연결 1개 · 직접 연결 0개 · 모호함 1개 · 연결 안 됨 1개",
                     "[번호로만 연결] 고1/미래엔/5-1. 아무 제목 → midaen-5-1",
                     "[모호함] 고1/미래엔/6-1. 아무 제목 → midaen-6-1, midaen-6-1b",
                     "[연결 안 됨] 고2/다른출판사/1강 제망매가"]


def test_report_shows_number_only_and_direct():
    entries = [make_entry(scope=["고1", "미래엔"]),
               make_entry(id="other", unit="9-9", unit_title="직접 연결할 단원입니다", works=["직접작품"], scope=["고3"])]
    videos = [video("고1/미래엔/4-2. 아무 제목", 1), video("고3/아무데나/그냥 영상", 2)]

    lines = report(videos, entries, {"고3/아무데나/그냥 영상": "other"})

    assert lines[0] == "연결됨 0개 · 번호로만 연결 1개 · 직접 연결 1개 · 모호함 0개 · 연결 안 됨 0개"
    assert "[번호로만 연결] 고1/미래엔/4-2. 아무 제목 → midaen-4-2" in lines
    assert len(lines) == 2


def test_report_flags_linked_entries_whose_scope_has_no_grade():
    entries = [make_entry(), make_entry(id="graded", unit="5-1", unit_title="다섯째 단원 이름입니다", works=["다섯작품"],
                                        scope=["고1", "미래엔"]),
               make_entry(id="unused", unit="9-9", unit_title="아무도 안 맞는 단원입니다", works=["없는작품"], scope=["없는폴더"])]
    videos = [video("고1/미래엔/4-2. 아무 제목", 1), video("고2/미래엔/4-2. 아무 제목", 2), video("고1/미래엔/5-1. 아무 제목", 3)]

    lines = report(videos, entries)

    flag = ("[학년 미확인] 항목 midaen-4-2: scope에 학년(중1~고3)이 없어 같은 출판사의 다른 학년 영상에도 연결될 수 있습니다. "
            "scope에 학년 낱말을 넣어 주세요.")
    assert lines.count(flag) == 1 and lines[-1] == flag
    assert not any("graded" in line and "학년 미확인" in line for line in lines)
    assert not any("unused" in line for line in lines)


def test_report_truncates_unlinked_after_50():
    videos = [video(f"고1/없음/영상 {n}", n) for n in range(60)]

    lines = report(videos, [make_entry()])

    assert lines[0].endswith("연결 안 됨 60개")
    assert sum(line.startswith("[연결 안 됨]") for line in lines) == 50
    assert lines[-1] == "… 외 10개"


def test_main_prints_report_and_returns_zero(tmp_path, capsys):
    folder = tmp_path / "videos" / "고1" / "미래엔"
    folder.mkdir(parents=True)
    (folder / "4-2. 가짜작품.mp4").write_bytes(b"x")
    (tmp_path / "study.json").write_text(json.dumps([make_entry()], ensure_ascii=False), encoding="utf-8")
    env = {"VIDEO_DIR": str(tmp_path / "videos"), "STUDY_FILE": str(tmp_path / "study.json"),
           "ACADEMY_ENV": str(tmp_path / "none.env")}
    (tmp_path / "none.env").write_text("", encoding="utf-8")

    assert main(env) == 0

    assert "연결됨 1개 · 번호로만 연결 0개 · 직접 연결 0개 · 모호함 0개 · 연결 안 됨 0개" in capsys.readouterr().out
