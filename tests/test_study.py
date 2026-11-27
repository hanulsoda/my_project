import json
import logging

import pytest

from academy.study import entry_problems, read_study, usable_study
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
