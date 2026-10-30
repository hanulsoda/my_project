"""강의 목록·틀린 문제 복습·기기 옮기기 화면(브라우저 테스트)"""

from datetime import datetime, timedelta, timezone
from urllib.parse import unquote

import pytest

pytest.importorskip("playwright.sync_api", reason="playwright가 없어 화면 테스트를 건너뜀")
from playwright.sync_api import expect  # noqa: E402

from tests.e2e.conftest import remember, stored  # noqa: E402

KST = timezone(timedelta(hours=9))
ZMG = "2022개정/고1/미래엔/제망매가"


def test_a_slow_earlier_search_does_not_replace_a_newer_one(page, site):
    remember(page, site, {"list": {"scope": "spoken"}})
    held = []
    page.route(lambda url: "/api/search" in url,  # 첫 검색(제망매가)의 답만 붙잡아 늦게 보냅니다
               lambda route: held.append(route) if "제망매가" in unquote(route.request.url) else route.continue_())
    page.goto(site.url + "/")
    page.fill("#search", "제망매가")
    page.press("#search", "Enter")
    while not held:
        page.wait_for_timeout(50)
    page.fill("#search", "반어법")
    page.press("#search", "Enter")
    expect(page.locator("#found h2").first).to_contain_text("반어법")

    with page.expect_response(lambda r: "/api/search" in r.url and "제망매가" in unquote(r.url)):
        held[0].continue_()
    page.wait_for_timeout(300)  # 늦게 온 답을 화면이 처리할 시간
    expect(page.locator("#found h2").first).to_contain_text("반어법")


def test_spoken_search_results_come_back_after_watching_a_lecture(page, site):
    remember(page, site, {"list": {"scope": "spoken"}})
    page.goto(site.url + "/")
    page.fill("#search", "반어법")
    page.press("#search", "Enter")
    expect(page.locator("#found h2").first).to_contain_text("반어법")
    page.goto(f"{site.url}/watch.html?id={site.ids[ZMG]}")
    page.go_back()
    expect(page.locator("#found h2").first).to_contain_text("반어법")


def test_typing_a_title_does_not_start_a_spoken_search_on_return(page, site):
    page.goto(site.url + "/")
    page.fill("#search", "제망매가")
    expect(page.locator(".video-list a:visible").first).to_be_visible()
    searched = []
    page.on("request", lambda r: searched.append(r.url) if "/api/search" in r.url else None)
    page.reload()
    expect(page.locator(".video-list a:visible").first).to_be_visible()
    assert searched == []


def test_a_question_missed_at_night_comes_back_the_next_morning(page, site):
    page.clock.install(time=datetime(2026, 11, 2, 23, 0, tzinfo=KST))
    page.goto(site.url + "/review.html")
    page.evaluate("id => markWrong(id, '제망매가의 갈래는?', true)", site.ids[ZMG])
    page.reload()
    expect(page.locator("#view-sub")).to_have_text("오늘 복습할 문제 0개 · 앞으로 1개")
    expect(page.locator("#review")).to_contain_text("다음 복습: 내일 1개")

    page.clock.set_system_time(datetime(2026, 11, 3, 9, 0, tzinfo=KST))
    page.reload()
    expect(page.locator("#view-sub")).to_have_text("오늘 복습할 문제 1개")
    page.locator(".review-lecture .question button.choice").first.click()  # 1번 향가가 정답
    item = stored(page, f"wrong:{site.ids[ZMG]}")[0]
    assert item["stage"] == 1
    assert item["due"] == datetime(2026, 11, 6, tzinfo=KST).timestamp() * 1000  # 맞히면 달력으로 3일 뒤 0시


def test_an_old_record_with_an_evening_time_is_due_that_morning(page, site):
    page.clock.install(time=datetime(2026, 11, 3, 9, 0, tzinfo=KST))
    evening = datetime(2026, 11, 3, 22, 59, tzinfo=KST).timestamp() * 1000
    remember(page, site, {f"wrong:{site.ids[ZMG]}": [{"k": "제망매가의 갈래는?", "stage": 0, "due": evening}]})
    page.goto(site.url + "/review.html")
    expect(page.locator("#view-sub")).to_have_text("오늘 복습할 문제 1개")


def test_review_skips_lectures_not_in_the_list_and_drops_removed_questions(page, site):
    remember(page, site, {"wrong:aaaaaaaaaaaa": [{"k": "옮긴 강의의 문제", "stage": 0, "due": 0}],
                          f"wrong:{site.ids[ZMG]}": [{"k": "다시 분석해 없어진 문제", "stage": 0, "due": 0}]})
    asked = []
    page.on("request", lambda r: asked.append(r.url) if "aaaaaaaaaaaa" in r.url else None)
    page.goto(site.url + "/review.html")
    expect(page.locator("#review")).to_have_text("복습할 틀린 문제가 없습니다.")
    expect(page.locator("#view-sub")).to_have_text("오늘 복습할 문제 0개")
    expect(page.locator('nav.sidebar a[href="review.html"] .n')).to_have_text("")
    assert asked == []  # 목록에 없는 강의는 서버에 묻지 않음(물을 때마다 서버가 NAS를 다시 훑음)
    assert stored(page, "wrong:aaaaaaaaaaaa")  # 강의가 돌아오면 다시 나오게 기록은 둠
    assert stored(page, f"wrong:{site.ids[ZMG]}") == []


def test_a_position_saved_without_a_length_is_not_shown_as_watched(page, site):
    remember(page, site, {f"pos:{site.ids[ZMG]}": {"t": 0, "d": None, "at": 1}})
    page.goto(site.url + "/#f/2022개정/고1/미래엔")
    row = page.locator(f'.video-list a[href$="{site.ids[ZMG]}"]:visible')
    expect(row).to_contain_text("요점 정리")
    expect(row).not_to_contain_text("다 봄")


def test_progress_and_watched_marks(page, site):
    remember(page, site, {f"pos:{site.ids[ZMG]}": {"t": 60, "d": 150, "at": 1}})
    page.goto(site.url + "/#v/recent")
    expect(page.locator(f'#recent-list a[href$="{site.ids[ZMG]}"]')).to_contain_text("01:00까지")
    remember(page, site, {f"pos:{site.ids[ZMG]}": {"t": 148, "d": 150, "at": 1}})
    page.goto(site.url + "/#f/2022개정/고1/미래엔")
    expect(page.locator(f'.video-list a[href$="{site.ids[ZMG]}"]:visible')).to_contain_text("다 봄")


def test_a_folder_with_percent_in_its_name_opens(page, site):
    page.goto(site.url + "/")
    page.locator("nav.sidebar a", has_text="100%완성").click()
    expect(page.locator("#view-title")).to_have_text("100%완성")


def test_sidebar_keyboard_and_current_folder(page, site):
    page.goto(site.url + "/")
    row = page.locator("nav.sidebar ul.tree > li > .row", has_text="2022개정")
    row.locator("a").focus()
    page.keyboard.press("ArrowRight")
    expect(row.locator("button")).to_have_attribute("aria-expanded", "true")
    page.keyboard.press("ArrowRight")
    expect(page.locator(":focus .name")).to_have_text("고1")
    page.keyboard.press("ArrowLeft")
    expect(page.locator(":focus .name")).to_have_text("2022개정")
    page.goto(site.url + "/#f/2022개정/고1/미래엔")
    page.reload()
    expect(page.locator("#view-title")).to_have_text("미래엔")
    expect(page.locator('nav.sidebar a[aria-current="page"] .name')).to_have_text("미래엔")


def test_the_player_back_link_opens_the_lecture_folder(page, site):
    page.goto(f"{site.url}/watch.html?id={site.ids[ZMG]}")
    expect(page.locator("#back")).to_have_text("미래엔")
    page.click("#back")
    expect(page.locator("#view-title")).to_have_text("미래엔")


def test_guide_only_header_counts_the_lectures_shown(page, site):
    page.goto(site.url + "/#f/2022개정")
    expect(page.locator(".video-list a:visible").first).to_be_visible()
    page.check("#guide-only")
    rows = page.locator(".video-list a:visible")
    expect(rows).to_have_count(2)  # 제망매가(요점 정리), 제망매가 학습활동(학원 정리)
    expect(page.locator("#view-sub")).to_contain_text("강의 2개")


def test_transfer_code_countdown_ignores_a_fast_device_clock(page, site):
    page.clock.install(time=datetime.now(KST) + timedelta(minutes=11))
    page.goto(site.url + "/move.html")
    page.click("#send")
    expect(page.locator("#send-status")).to_contain_text("남은 시간")


def test_receiving_notes_counts_only_new_ones(page, site):
    vid = site.ids[ZMG]
    remember(page, site, {f"notes:{vid}": [{"t": 10, "text": "같은 메모"}, {"t": 10, "text": "같은 메모"}]})
    page.goto(site.url + "/move.html")
    counts = page.evaluate("key => mergeRecords({[key]: [{t: 20, text: '새 메모'}, {t: 10, text: '같은 메모'}]})",
                           f"notes:{vid}")
    assert counts["notes"] == 1
    assert stored(page, f"notes:{vid}") == [{"t": 10, "text": "같은 메모"}, {"t": 20, "text": "새 메모"}]


def test_a_folder_link_opens_the_folder_even_after_a_spoken_search(page, site):
    remember(page, site, {"list": {"scope": "spoken"}})
    page.goto(site.url + "/")
    page.fill("#search", "반어법")
    page.press("#search", "Enter")
    expect(page.locator("#found h2").first).to_contain_text("반어법")
    page.locator("nav.sidebar a", has_text="100%완성").click()  # 찾은 결과를 보다가 사이드바 폴더
    expect(page.locator("#view-title")).to_have_text("100%완성")

    page.goto(site.url + "/")
    page.fill("#search", "반어법")
    page.press("#search", "Enter")
    expect(page.locator("#found h2").first).to_contain_text("반어법")
    searched = []
    page.on("request", lambda r: searched.append(r.url) if "/api/search" in r.url else None)
    page.goto(site.url + "/review.html")
    page.goto(site.url + "/#f/2022개정/고1/미래엔")  # 다른 화면(플레이어의 '‹ 폴더' 등)에서 폴더로
    expect(page.locator("#view-title")).to_have_text("미래엔")
    assert searched == []
