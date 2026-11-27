import json
import logging
import unicodedata

import pytest

from academy.study import entry_problems, link_video, norm, read_links, read_study, usable_study
from tests.study_data import make_entry


def _with_quiz(**changes):
    entry = make_entry()
    entry["quiz"].update(changes)
    return entry


def _has(problems, *words):
    return any(all(w in line for w in words) for line in problems)


def test_valid_entry_has_no_problems():
    assert entry_problems(make_entry()) == []


def test_make_entry_is_fresh_each_call():
    first = make_entry()
    first["quiz"]["mc"].pop()
    assert len(make_entry()["quiz"]["mc"]) == 10


def test_wrong_counts_are_reported():
    base = make_entry()["quiz"]
    cases = {"mc": "객관식", "sub": "주관식", "ox": "OX", "short": "단답형"}
    for key, name in cases.items():
        for items in (base[key][:-1], base[key] + [base[key][0]]):
            problems = entry_problems(_with_quiz(**{key: items}))
            assert _has(problems, name, str({"mc": 10, "sub": 5, "ox": 10, "short": 10}[key])), (key, problems)


def test_choice_and_answer_shape():
    for field, value in (("choices", ["가", "나", "다", "라"]), ("answer", 5), ("answer", "1")):
        entry = make_entry()
        entry["quiz"]["mc"][0][field] = value
        assert _has(entry_problems(entry), "객관식"), (field, value)


def test_ox_and_short_answer_shape():
    entry = make_entry()
    entry["quiz"]["ox"][0]["answer"] = "true"
    assert _has(entry_problems(entry), "OX")
    entry = make_entry()
    entry["quiz"]["short"][0]["answer"] = ""
    assert _has(entry_problems(entry), "단답형")


def test_empty_scope_and_missing_blocks_are_reported():
    assert entry_problems(make_entry(scope=[]))
    assert entry_problems(make_entry(notes={}))
    entry = make_entry()
    del entry["quiz"]
    assert entry_problems(entry)
    assert entry_problems(make_entry(works="가짜작품"))
    assert entry_problems(_with_quiz(passages=[]))
    for key in ("id", "unit", "unit_title"):
        assert entry_problems(make_entry(**{key: " "})), key
    assert entry_problems("글")
    assert entry_problems(None)


def test_usable_study_drops_bad_and_duplicate_ids(caplog):
    good, bad = make_entry(), make_entry(id="bad", scope=[])
    duplicate = make_entry(unit_title="가짜 다른 제목입니다")
    with caplog.at_level(logging.WARNING):
        assert usable_study([good, bad, duplicate]) == [good]
    assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 2


def test_usable_study_drops_later_entry_sharing_id_with_broken_one(caplog):
    broken = make_entry(scope=[])
    with caplog.at_level(logging.WARNING):
        assert usable_study([broken, make_entry()]) == []
    assert len(caplog.records) == 2


def test_read_study_missing_or_empty_path_gives_empty_list():
    assert read_study(None) == []
    assert read_study("") == []


def test_read_study_reads_entries_and_bom(tmp_path):
    path = tmp_path / "study.json"
    path.write_text(json.dumps([make_entry()], ensure_ascii=False), encoding="utf-8-sig")
    assert read_study(str(path)) == [make_entry()]


def test_read_study_bad_file_exits_with_one_line(tmp_path):
    broken = tmp_path / "broken.json"
    broken.write_text("{깨짐", encoding="utf-8")
    not_list = tmp_path / "dict.json"
    not_list.write_text("{}", encoding="utf-8")
    for path in (tmp_path / "none.json", broken, not_list):
        with pytest.raises(SystemExit) as raised:
            read_study(str(path))
        message = str(raised.value)
        assert str(path) in message and "STUDY_FILE" in message and "\n" not in message


def test_blank_scope_and_works_items_are_problems():
    assert _has(entry_problems(make_entry(scope=[""])), "scope")
    assert _has(entry_problems(make_entry(scope=["  "])), "scope")
    assert _has(entry_problems(make_entry(scope=["미래엔", ""])), "scope")
    assert _has(entry_problems(make_entry(works=[""])), "works")
    assert _has(entry_problems(make_entry(works=["가짜작품", "   "])), "works")
    assert entry_problems(make_entry(works=[])) == []


# --- 영상 연결 규칙 ---
FOLDER = "2022개정/고1/미래엔/"


def _link(name, entries=None, links=None, folder=FOLDER):
    return link_video([make_entry()] if entries is None else entries, folder + name, links)


def test_norm_joins_hangul_and_drops_spaces_and_symbols():
    assert norm("가 나_다-라.") == "가나다라"
    assert norm(unicodedata.normalize("NFD", "한글 제목")) == "한글제목"


@pytest.mark.parametrize("name", ["4-2. 아무 제목", "4-2 아무 제목", "4-2_아무 제목", "4–2. 아무 제목"])
def test_unit_number_prefix_matches(name):
    result = _link(name)
    assert result["status"] == "number_only"
    assert result["entries"] == [make_entry()]


@pytest.mark.parametrize("name", ["3강 4-2 복습", "2024-4-2 수업", "4-21. 다른 단원"])
def test_unit_number_must_start_the_name_and_not_run_into_digits(name):
    assert _link(name)["status"] == "none"


def test_unit_title_and_work_names_match_anywhere_in_the_name():
    assert _link("1강 가짜 단원 제목입니다 (1)")["status"] == "matched"
    assert _link("1강 가짜단원-제목입니다")["status"] == "matched"
    assert _link("2강 가짜작품 읽기")["status"] == "matched"
    assert _link("2강 가짜 작품, 읽기")["status"] == "matched"
    assert _link("2강 가짜 읽기", [make_entry(works=["가짜"], unit_title="짧은제목")])["status"] == "none"


def test_scope_words_must_all_be_in_the_folder():
    assert _link("4-2. 제목", folder="2022개정/고1/비상/")["status"] == "none"
    two = [make_entry(scope=["미래엔", "고1"])]
    assert _link("4-2. 제목", two)["status"] == "number_only"
    assert _link("4-2. 제목", two, folder="2022개정/고2/미래엔/")["status"] == "none"
    assert link_video([make_entry()], "4-2. 제목")["status"] == "none"  # 폴더 없는 영상
    assert _link("미래엔 4-2. 제목", folder="2022개정/고1/비상/")["status"] == "none"


def test_blank_scope_word_never_matches():
    # usable_study를 거치지 않고 들어온 항목도 모든 폴더에 붙으면 안 됩니다
    assert _link("4-2. 제목", [make_entry(scope=["", "미래엔"])])["status"] == "none"
    assert _link("4-2. 제목", [make_entry(scope=["  "])])["status"] == "none"
    assert _link("4-2. 제목", [make_entry(scope=[])])["status"] == "none"


def test_nfd_titles_match():
    title = unicodedata.normalize("NFD", FOLDER + "1강 가짜 단원 제목입니다")
    assert link_video([make_entry()], title)["status"] == "matched"


def test_two_entries_make_it_ambiguous():
    other = make_entry(id="midaen-4-2-b")
    assert _link("4-2. 제목", [make_entry(), other]) == {"status": "ambiguous", "entries": []}
    # 한 항목이 규칙 둘에 걸리는 것은 하나로 센다
    assert _link("4-2 가짜작품 읽기")["status"] == "matched"


def test_direct_links_override_rules():
    title = FOLDER + "엉뚱한 이름"
    result = link_video([make_entry()], title, {title: "midaen-4-2"})
    assert result["status"] == "direct" and result["entries"] == [make_entry()]
    rule_title = FOLDER + "4-2. 제목"
    assert link_video([make_entry()], rule_title, {rule_title: None}) == {"status": "none", "entries": []}
    assert link_video([make_entry()], title, {title: "없는-id"}) == {"status": "none", "entries": []}
    nfd = unicodedata.normalize("NFD", title)
    assert link_video([make_entry()], nfd, {title: "midaen-4-2"})["status"] == "direct"


def test_read_links(tmp_path):
    path = tmp_path / "links.json"
    path.write_text(json.dumps({"a": "x", "b": None}), encoding="utf-8")
    assert read_links(str(path)) == {"a": "x", "b": None}
    path.write_text(json.dumps({unicodedata.normalize("NFD", "한글"): "x"}), encoding="utf-8")
    assert read_links(str(path)) == {"한글": "x"}
    assert read_links(None) == {}
    assert read_links("") == {}
    path.write_text("[1]", encoding="utf-8")
    with pytest.raises(SystemExit):
        read_links(str(path))
    path.write_text("{깨짐", encoding="utf-8")
    with pytest.raises(SystemExit):
        read_links(str(path))
    with pytest.raises(SystemExit):
        read_links(str(tmp_path / "없음.json"))


def test_entries_with_a_grade_do_not_link_other_grades_or_other_units():
    entry = make_entry(scope=["2022개정", "고1", "미래엔"], unit="5-1", unit_title="다섯째 단원 이름입니다", works=["공동 보고서"])
    own = "2022개정/고1/미래엔/"

    assert link_video([entry], own + "5-1. 아무 제목")["status"] == "number_only"
    assert link_video([entry], own + "5-1. 공동 보고서 쓰기")["status"] == "matched"
    assert link_video([entry], "2022개정/고2/미래엔/5-1. 공동 보고서 쓰기")["status"] == "none"  # 다른 학년
    assert link_video([entry], own + "3-1. 공동 보고서 쓰기")["status"] == "none"  # 다른 단원 번호로 시작
    assert link_video([entry], own + "3 - 1 공동 보고서 쓰기")["status"] == "none"
    assert link_video([entry], own + "공동 보고서 쓰기")["status"] == "matched"  # 번호 없는 이름은 그대로
    direct = own + "3-1. 공동 보고서 쓰기"
    assert link_video([entry], direct, {direct: "midaen-4-2"})["status"] == "direct"  # 직접 연결은 규칙보다 앞섭니다
