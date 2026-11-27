"""요점노트 탭(브라우저 테스트): 연결된 영상에만 보이고, 글은 <b> <u> <br> 말고는 글자 그대로 보입니다."""

import pytest

pytest.importorskip("playwright.sync_api", reason="playwright가 없어 화면 테스트를 건너뜀")
from playwright.sync_api import expect  # noqa: E402

from tests.study_data import make_entry  # noqa: E402

LINKED, UNLINKED = "4-2. 가짜 제목", "4-2. 연결 안 된 영상"


@pytest.fixture
def page(browser):
    context = browser.new_context(timezone_id="Asia/Seoul", viewport={"width": 1200, "height": 900})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    yield page
    context.close()
    assert not errors, f"화면 오류: {errors}"


def entry_with(blocks=None, **notes):
    entry = make_entry()
    if blocks is not None:
        entry["notes"]["blocks"] = blocks
    entry["notes"].update(notes)
    return entry


FULL = [{"t": "big", "title": "가짜 큰 제목", "blocks": [
            {"t": "h", "title": "가짜 소제목", "sub": "가짜 소부제"},
            {"t": "tip", "text": "가짜 팁 글입니다"},
            {"t": "table", "head": ["가짜머리", "가짜머리둘"], "rows": [["가짜칸", "가짜칸둘"]]}]},
        {"t": "mystery", "text": "알 수 없는 종류의 글"}]


def open_notes(page, site, title=LINKED):
    page.goto(f"{site.url}/watch.html?id={site.ids[title]}")
    expect(page.locator("#title")).to_have_text(title)


def test_study_tabs_are_hidden_for_unlinked_videos(page, study_site):
    site = study_site([make_entry()])
    open_notes(page, site, UNLINKED)
    expect(page.locator("#tab-btn-study-notes")).to_be_hidden()
    open_notes(page, site)
    expect(page.locator("#tab-btn-study-notes")).to_be_visible()
    expect(page.locator("#tab-btn-study-notes")).to_have_text("요점노트")


def test_notes_tab_shows_blocks(page, study_site):
    site = study_site([entry_with(FULL, words=[["가짜낱말", "가짜 낱말 뜻"]])])
    open_notes(page, site)
    page.click("#tab-btn-study-notes")
    box = page.locator("#tab-study-notes")
    for text in ["가짜 큰 제목", "가짜 소제목", "가짜머리", "가짜칸둘", "가짜 팁 글입니다", "가짜낱말", "가짜 낱말 뜻"]:
        expect(box.get_by_text(text, exact=True)).to_be_visible()
    expect(box).not_to_contain_text("알 수 없는 종류의 글")


def test_markup_other_than_b_u_br_is_shown_as_text(page, study_site):
    evil = "<b>굵게</b><script>window.hacked=1</script><img src=x onerror=window.hacked=1>"
    site = study_site([entry_with([{"t": "tip", "text": evil}])])
    open_notes(page, site)
    page.click("#tab-btn-study-notes")
    box = page.locator("#tab-study-notes")
    expect(box).to_contain_text("<script>window.hacked=1</script>")
    expect(box).to_contain_text("<img src=x onerror=window.hacked=1>")
    assert page.evaluate("window.hacked") is None
    assert box.locator("script, img").count() == 0
    bold = box.locator("b")
    expect(bold).to_have_text("굵게")


def test_study_load_failure_shows_a_notice(page, study_site):
    site = study_site([make_entry()])
    page.route("**/api/study/**", lambda route: route.abort())
    open_notes(page, site)
    page.click("#tab-btn-study-notes")
    expect(page.locator("#tab-study-notes .notice")).to_be_visible()
