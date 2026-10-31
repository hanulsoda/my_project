"""강의 목록·틀린 문제 복습·기기 옮기기 화면(브라우저 테스트)"""

import re
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


def test_review_shows_each_lectures_questions_as_soon_as_they_arrive(page, site):
    zmg, act = site.ids[ZMG], site.ids[ZMG + " 학습활동"]
    q = page.request.get(f"{site.url}/api/videos/{act}").json()["references"][0]["quiz"][0]
    remember(page, site, {f"wrong:{zmg}": [{"k": "제망매가의 갈래는?", "stage": 0, "due": 0}],
                          f"wrong:{act}": [{"k": q.get("question") or " ".join([q["context"], *q["parts"]]), "stage": 0, "due": 0}]})
    held = {}
    page.route(re.compile(r"/api/videos/[0-9a-f]{12}$"), lambda route: held.update({route.request.url[-12:]: route}))
    page.goto(site.url + "/review.html")
    while len(held) < 2:
        page.wait_for_timeout(50)
    first, second = page.evaluate("wrongLists([]).map((l) => l.id)")  # 화면에 그리는 순서

    held[first].continue_()
    expect(page.locator(".review-lecture")).to_have_count(1)  # 나머지를 기다리지 않고 바로 풀 수 있음
    expect(page.locator("#review")).to_contain_text("불러오는 중")
    held[second].abort()
    expect(page.locator("#review")).to_contain_text("일부 강의를 불러오지 못했습니다")
    expect(page.locator("#review")).not_to_contain_text("불러오는 중")
    expect(page.locator(".review-lecture")).to_have_count(1)


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


def test_records_of_a_moved_lecture_follow_it_to_its_new_place(page, site):
    vid, old = site.ids[ZMG], "0123456789ab"
    page.route("**/api/moves", lambda route: route.fulfill(json={old: vid}))
    remember(page, site, {f"pos:{old}": {"t": 60, "d": 150, "at": 5}, f"notes:{old}": [{"t": 10, "text": "옮기기 전 메모"}],
                          f"notes:{vid}": [{"t": 20, "text": "새 자리 메모"}],
                          f"wrong:{old}": [{"k": "제망매가의 갈래는?", "stage": 1, "due": 0}]})
    page.goto(site.url + "/")
    page.wait_for_function(f"!localStorage.getItem('pos:{old}')")

    assert stored(page, f"pos:{vid}")["t"] == 60
    assert stored(page, f"notes:{vid}") == [{"t": 10, "text": "옮기기 전 메모"}, {"t": 20, "text": "새 자리 메모"}]  # 합침
    assert stored(page, f"wrong:{vid}")[0]["stage"] == 1
    assert stored(page, f"notes:{old}") is None and stored(page, f"wrong:{old}") is None


def test_arrow_down_right_after_typing_goes_to_a_lecture_that_matches(page, site):
    page.goto(site.url + "/#f/2022개정/고1/미래엔")
    expect(page.locator(".video-list a:visible")).to_have_count(3)

    page.fill("#search", "청산")
    page.keyboard.press("ArrowDown")  # 거르기를 기다리지 않고 바로

    expect(page.locator(".video-list a:focus")).to_contain_text("청산별곡")
    page.wait_for_timeout(300)  # 늦게 거르더라도 자리를 잃지 않음
    expect(page.locator(".video-list a:focus")).to_contain_text("청산별곡")


def test_records_are_not_dropped_when_the_new_place_cannot_be_written(page, site):
    vid, old = site.ids[ZMG], "0123456789ab"
    page.route("**/api/moves", lambda route: route.fulfill(json={old: vid}))
    remember(page, site, {f"notes:{old}": [{"t": 10, "text": "옮기기 전 메모"}]})
    page.add_init_script(f"""{{ const set = Storage.prototype.setItem;  // 저장 공간이 꽉 참
        Storage.prototype.setItem = function (k, v) {{ if (k.includes('{vid}')) throw new DOMException('full', 'QuotaExceededError');
                                                       return set.call(this, k, v); }}; }}""")
    with page.expect_response("**/api/moves"):
        page.goto(site.url + "/")
    page.wait_for_timeout(300)

    assert stored(page, f"notes:{old}") == [{"t": 10, "text": "옮기기 전 메모"}]  # 새 자리에 쓰지 못했으면 그대로 둠


def test_received_records_that_cannot_be_saved_are_not_reported_as_received(page, site):
    page.route("**/api/transfer/123456", lambda route: route.fulfill(
        json={"data": {f"notes:{site.ids[ZMG]}": [{"t": 1, "text": "다른 기기 메모"}]}}))
    page.add_init_script("""Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); };""")
    page.goto(site.url + "/move.html")

    page.fill("#code-input", "123456")
    page.press("#code-input", "Enter")

    expect(page.locator("#receive-status")).to_contain_text("저장하지 못했습니다")
    expect(page.locator("#receive-status")).not_to_contain_text("받았습니다")


PROXY_502 = {"status": 502, "content_type": "text/html", "body": "<html><body>502 Bad Gateway</body></html>"}


def test_the_list_says_when_the_server_cannot_be_reached_and_can_retry(page, site):
    page.route("**/api/videos", lambda route: route.fulfill(**PROXY_502))  # 서버를 다시 켜는 동안(시놀로지가 502)
    page.goto(site.url + "/")
    expect(page.locator("#empty")).to_contain_text("서버에 연결하지 못했습니다")

    page.unroute("**/api/videos")
    page.click("#empty button")

    expect(page.locator(".video-list a").first).to_be_attached()


def test_searching_offline_does_not_spin_forever(page, site):
    remember(page, site, {"list": {"scope": "spoken"}})
    page.goto(site.url + "/")
    expect(page.locator(".video-list a").first).to_be_attached()
    page.route("**/api/search**", lambda route: route.abort("internetdisconnected"))

    page.fill("#search", "반어법")
    page.press("#search", "Enter")

    expect(page.locator("#found")).to_contain_text("서버에 연결하지 못했습니다")


def test_moving_records_offline_or_during_a_restart_says_what_happened(page, site):
    page.goto(site.url + "/move.html")
    page.route("**/api/transfer", lambda route: route.abort("internetdisconnected"))
    page.click("#send")
    expect(page.locator("#send-status")).to_contain_text("서버에 연결하지 못했습니다")

    page.route("**/api/transfer/*", lambda route: route.fulfill(**PROXY_502))
    page.fill("#code-input", "123456")
    page.press("#code-input", "Enter")
    expect(page.locator("#receive-status")).to_contain_text("서버에 연결하지 못했습니다")  # '코드가 없거나'가 아님


def test_notes_keep_their_lecture_links_when_the_list_cannot_be_loaded(page, site):
    vid = site.ids[ZMG]
    remember(page, site, {f"notes:{vid}": [{"t": 10, "text": "메모"}]})
    page.route("**/api/videos", lambda route: route.fulfill(**PROXY_502))
    page.goto(site.url + "/notes.html")

    expect(page.locator("#notes-page")).to_contain_text("서버에 연결하지 못했습니다")
    expect(page.locator("#notes-page")).not_to_contain_text("목록에 없는 강의")
    expect(page.locator(f'#notes-page h2 a[href="watch.html?id={vid}"]')).to_be_visible()


def test_coming_back_with_the_back_button_redraws_progress(page, site):
    page.goto(site.url + "/")
    expect(page.locator(".video-list a").first).to_be_attached()

    with page.expect_navigation():  # 뒤로 가기로 예전 화면을 그대로 되살리면(bfcache) 본 데까지가 예전 것
        page.evaluate("dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))")


def test_a_review_set_while_the_phone_clock_was_ahead_comes_back_within_a_week(page, site):
    page.clock.install(time=datetime(2026, 11, 3, 9, 0, tzinfo=KST))
    far = datetime(2026, 12, 4, tzinfo=KST).timestamp() * 1000  # 휴대폰 날짜를 한 달 앞으로 해 둔 동안 틀린 문제
    remember(page, site, {f"wrong:{site.ids[ZMG]}": [{"k": "제망매가의 갈래는?", "stage": 0, "due": far}]})

    page.goto(site.url + "/review.html")

    expect(page.locator("#review")).to_contain_text("다음 복습: 7일 뒤 1개")  # 가장 긴 간격(7일)보다 멀지 않게
