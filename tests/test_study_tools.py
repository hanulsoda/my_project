"""교사용 PDF 만들기(build_pdf)와 승인한 항목 모으기(promote) 시험. 브라우저·네트워크 없이 HTML 글만 확인합니다."""

import importlib.util
import json
from pathlib import Path

import pytest

from tests.study_data import make_entry

TOOLS = Path(__file__).resolve().parent.parent / "tools" / "study"


def _load(name):
    spec = importlib.util.spec_from_file_location(f"study_tool_{name}", TOOLS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def build_pdf():
    return _load("build_pdf")


@pytest.fixture(scope="module")
def promote_mod():
    return _load("promote")


def test_quiz_html_has_all_sections_and_answers_on_a_new_page(build_pdf):
    html = build_pdf.quiz_html(make_entry())
    positions = [html.index(word) for word in ("객관식", "주관식", "OX", "단답형")]
    assert positions == sorted(positions)
    answers = html.index("정답과 해설")
    assert answers > positions[-1]
    assert "break-before: page" in html[:answers]
    assert "⑤" in html
    assert "가짜 지문 제목" in html


def test_html_escapes_everything_but_allowed_markup(build_pdf):
    entry = make_entry()
    entry["quiz"]["passages"][0]["paras"] = ["<script>alert(1)</script> <b>굵게</b> <u>밑줄</u><br>끝"]
    entry["notes"]["blocks"] = [{"t": "def", "text": "<img src=x onerror=1> <b>굵게</b>"}]
    for html in (build_pdf.quiz_html(entry), build_pdf.notes_html(entry)):
        assert "<script>" not in html and "<img" not in html
    quiz = build_pdf.quiz_html(entry)
    assert "&lt;script&gt;" in quiz and "<b>굵게</b>" in quiz and "<u>밑줄</u>" in quiz and "<br>" in quiz
    assert "&lt;img" in build_pdf.notes_html(entry)


def test_notes_html_has_unit_title_and_blocks(build_pdf):
    html = build_pdf.notes_html(make_entry())
    assert "가짜 단원 제목입니다" in html
    assert "가짜 <b>뜻풀이</b>입니다" in html
    assert "가짜말" in html and "가짜 뜻풀이입니다" in html


def _draft(tmp_path, *entries):
    path = tmp_path / "draft.json"
    path.write_text(json.dumps(list(entries), ensure_ascii=False), encoding="utf-8")
    return str(path)


def test_promote_writes_only_approved_and_replaces_same_id(promote_mod, tmp_path):
    a, b = make_entry(), make_entry(id="midaen-5-1", unit="5-1")
    draft, out = _draft(tmp_path, a, b), tmp_path / "study.json"
    assert promote_mod.promote(draft, str(out), ["midaen-4-2"]) == ["midaen-4-2"]
    assert [e["id"] for e in json.loads(out.read_text(encoding="utf-8"))] == ["midaen-4-2"]
    again = _draft(tmp_path, make_entry(unit_title="고친 제목입니다"))
    promote_mod.promote(again, str(out), ["midaen-4-2"])
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert len(saved) == 1 and saved[0]["unit_title"] == "고친 제목입니다"


def test_promote_refuses_unknown_id_and_bad_entries(promote_mod, tmp_path):
    out = tmp_path / "study.json"
    with pytest.raises(SystemExit):
        promote_mod.promote(_draft(tmp_path, make_entry()), str(out), ["없는-id"])
    assert not out.exists()
    bad = make_entry(scope=[])
    with pytest.raises(SystemExit):
        promote_mod.promote(_draft(tmp_path, bad), str(out), ["midaen-4-2"])
    assert not out.exists()
