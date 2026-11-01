"""강의 목록·틀린 문제 복습·기기 옮기기 화면(브라우저 테스트)"""

import re
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote

import pytest

pytest.importorskip("playwright.sync_api", reason="playwright가 없어 화면 테스트를 건너뜀")
from playwright.sync_api import expect  # noqa: E402

from tests.e2e.conftest import remember, stored  # noqa: E402
from tests.e2e.phones import on_screen, phone  # noqa: E402,F401

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


def test_choosing_spoken_after_typing_a_word_searches_it(page, site):
    page.goto(site.url + "/")
    expect(page.locator(".video-list a").first).to_be_attached()
    page.fill("#search", "반어법")
    page.click("#scope-spoken")  # 낱말을 먼저 쓰고 '선생님 말'을 누름: 찾을 곳만 바뀌고 찾지 않던 것
    expect(page.locator("#found h2").first).to_contain_text("반어법")


def test_the_spoken_scope_shows_a_find_button_on_a_phone(phone, site):
    page = phone(390, 844)
    page.goto(site.url + "/")
    expect(page.locator("nav.sidebar a", has_text="2022개정")).to_be_visible()
    expect(page.locator("#find-btn")).to_be_hidden()  # 제목은 쓰는 대로 걸러 보여 줌
    page.locator("#scope-spoken").tap()
    expect(page.locator("#find-btn")).to_be_visible()
    assert on_screen(page, page.locator("#find-btn"))
    page.fill("#search", "반어법")
    page.locator("#find-btn").tap()
    expect(page.locator("#found h2").first).to_contain_text("반어법")
    expect(page.locator("#found h2").first).to_be_visible()


def test_a_title_search_with_no_hits_offers_to_search_what_the_teacher_said(page, site):
    page.goto(site.url + "/")
    expect(page.locator(".video-list a").first).to_be_attached()
    page.fill("#search", "반어법")  # 제목에는 없는 낱말
    expect(page.locator("#empty")).to_contain_text("제목에는 없습니다. ‘선생님 말’에서 찾아볼까요?")
    page.locator("#empty button").click()
    expect(page.locator("#scope-spoken")).to_have_attribute("aria-pressed", "true")
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


def test_review_counts_what_is_done_and_says_when_todays_review_is_over(page, site):
    page.clock.install(time=datetime(2026, 11, 3, 9, 0, tzinfo=KST))
    remember(page, site, {f"wrong:{site.ids[ZMG]}": [{"k": "제망매가의 갈래는?", "stage": 0, "due": 0},
                                                     {"k": "누이의 죽음을 극복한 방법은?", "stage": 0, "due": 0}]})
    page.goto(site.url + "/review.html")
    progress = page.locator("#review-progress")
    expect(progress).to_have_text("2문제 중 0문제 풀이")
    questions = page.locator(".review-lecture .question")

    questions.nth(0).locator("button.choice").first.click()  # 향가: 맞음
    expect(progress).to_have_text("2문제 중 1문제 풀이")
    expect(page.locator("#view-sub")).to_have_text("오늘 복습할 문제 1개 · 앞으로 1개")  # 푼 만큼 다시 셈
    questions.nth(1).locator("button.choice").first.click()  # 망각: 틀림

    expect(progress).to_have_text("오늘 복습 끝! 다음 복습: 내일 1개 · 3일 뒤 1개.")
    expect(page.locator("#review-end")).to_have_text("오늘 복습 끝! 다음 복습: 내일 1개 · 3일 뒤 1개.")  # 마지막 문제 아래에도
    expect(page.locator("#review-end")).to_be_visible()
    expect(page.locator("#view-sub")).to_have_text("오늘 복습할 문제 0개 · 앞으로 2개")


def test_the_end_of_todays_review_is_in_view_after_the_last_answer_on_a_phone(phone, site):
    page = phone(360, 740)
    remember(page, site, {f"wrong:{site.ids[ZMG]}": [{"k": "제망매가의 갈래는?", "stage": 0, "due": 0},
                                                     {"k": "누이의 죽음을 극복한 방법은?", "stage": 0, "due": 0}]})
    page.goto(site.url + "/review.html")
    questions = page.locator(".review-lecture .question")
    questions.nth(0).locator("button.choice").first.tap()
    questions.nth(1).locator("button.choice").nth(1).tap()  # 마지막 문제

    end = page.locator("#review-end")
    expect(end).to_contain_text("오늘 복습 끝!")
    assert on_screen(page, end)  # 해설만 보이고 끝났다는 말은 화면 바로 아래에 있던 것
    assert on_screen(page, questions.nth(1).locator(".feedback"))


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


def test_the_player_back_button_returns_to_the_list_view_it_came_from(page, site):
    remember(page, site, {f"pos:{site.ids[ZMG]}": {"t": 60, "d": 150, "at": 1}})
    page.goto(site.url + "/#v/recent")
    page.locator("#recent-list a").first.click()
    expect(page.locator("#title")).to_have_text("제망매가")
    expect(page.locator("#back")).to_have_text("강의")
    page.click("#back")
    expect(page.locator("#view-title")).to_have_text("이어 보기")  # 강의가 든 폴더(미래엔)가 아님
    assert page.url.endswith("#v/recent")

    remember(page, site, {"list": {"scope": "spoken"}})
    page.goto(site.url + "/")
    page.fill("#search", "반어법")
    page.press("#search", "Enter")
    page.locator("#found li > a").first.click()
    expect(page.locator("#title")).to_have_text("제망매가")
    page.click("#back")
    expect(page.locator("#found h2").first).to_contain_text("반어법")  # 찾은 결과 그대로


@pytest.mark.parametrize("width", [1200, 390], ids=["desktop", "phone"])
def test_the_player_back_button_returns_to_the_same_place_in_a_long_folder(phone, site, width):
    page = phone(width, 844)
    real = site.ids[ZMG]  # 150번째 줄만 실제로 열리는 강의
    lectures = [{"id": real if i == 150 else f"{i:012x}", "title": f"큰폴더/고1/작품 {i}강", "analyzed": False,
                 "guide": False, "toc": False, "added": 0} for i in range(300)]
    page.route("**/api/videos", lambda route: route.fulfill(json=lectures))
    page.goto(site.url + "/#f/큰폴더")
    row = page.locator(f'.content-body a[href="watch.html?id={real}"]')
    row.scroll_into_view_if_needed()
    row.click()
    expect(page.locator("#back")).to_have_text("강의")
    page.locator("#back").click()

    expect(page.locator("#view-title")).to_have_text("큰폴더")
    page.wait_for_timeout(300)
    assert on_screen(page, row)  # 맨 위(scrollY 0)가 아니라 보던 강의 자리
    page.reload()  # 사파리는 뒤로 가기로 되살린 화면을 다시 불러옵니다(common.js)
    expect(page.locator("#view-title")).to_have_text("큰폴더")
    page.wait_for_timeout(300)
    assert on_screen(page, row)


def test_spoken_results_come_back_after_passing_through_a_folder(page, site):
    remember(page, site, {"list": {"scope": "spoken"}})
    page.goto(site.url + "/")
    page.fill("#search", "반어법")
    page.press("#search", "Enter")
    expect(page.locator("#found h2").first).to_contain_text("반어법")
    page.goto(f"{site.url}/watch.html?id={site.ids[ZMG]}")
    page.goto(site.url + "/#f/2022개정/고1/미래엔")  # 플레이어의 '‹ 미래엔'
    expect(page.locator("#view-title")).to_have_text("미래엔")

    page.go_back()
    page.go_back()  # 결과를 보던 첫 화면으로
    expect(page.locator("#found h2").first).to_contain_text("반어법")


def test_opening_a_folder_from_the_sidebar_clears_the_search(page, site):
    page.goto(site.url + "/")
    page.fill("#search", "청산")
    expect(page.locator(".video-list a:visible")).to_have_count(1)
    page.locator("nav.sidebar a", has_text="시험").click()
    expect(page.locator("#view-title")).to_have_text("시험")  # '찾기 결과'가 아님
    expect(page.locator("#search")).to_have_value("")
    expect(page.locator(".video-list a:visible")).to_have_count(2)


@pytest.mark.parametrize("width, height", [(1200, 900), (844, 390)], ids=["desktop", "phone-on-its-side"])
def test_a_search_comes_back_after_peeking_at_a_folder_in_the_sidebar(phone, site, width, height):
    page = phone(width, height)  # 찾는 동안에도 사이드바가 보이는 넓은 화면
    page.goto(site.url + "/")
    folder = page.locator("nav.sidebar a", has_text="시험")
    page.fill("#search", "제망")
    expect(page.locator("#view-title")).to_have_text("찾기 결과")
    folder.click()
    expect(page.locator("#view-title")).to_have_text("시험")
    expect(page.locator("#search")).to_have_value("")
    page.go_back()
    expect(page.locator("#search")).to_have_value("제망")  # 빈 칸으로 돌아오던 것
    expect(page.locator("#view-title")).to_have_text("찾기 결과")

    page.click("#scope-spoken")
    page.fill("#search", "반어법")
    page.press("#search", "Enter")
    expect(page.locator("#found h2").first).to_contain_text("반어법")
    folder.click()
    expect(page.locator("#view-title")).to_have_text("시험")
    expect(page.locator("#found")).to_be_hidden()
    page.go_back()
    expect(page.locator("#search")).to_have_value("반어법")
    expect(page.locator("#found h2").first).to_contain_text("반어법")


def test_choosing_the_open_folder_again_in_the_sidebar_clears_the_search(page, site):
    page.goto(site.url + "/#f/시험")
    expect(page.locator("#view-title")).to_have_text("시험")
    page.fill("#search", "제망")
    expect(page.locator("#view-title")).to_have_text("찾기 결과")
    page.locator("nav.sidebar a", has_text="시험").click()  # 주소가 그대로라 새 화면이 열리지 않음
    expect(page.locator("#view-title")).to_have_text("시험")
    expect(page.locator("#search")).to_have_value("")
    expect(page.locator(".content-body .video-list a:visible")).to_have_count(2)


@pytest.mark.parametrize("width, height", [(1200, 900), (390, 844)], ids=["desktop", "phone"])
def test_a_title_search_left_in_the_box_does_not_take_over_the_players_folder_link(phone, site, width, height):
    page = phone(width, height)
    page.goto(site.url + "/")
    page.fill("#search", "제망")
    expect(page.locator("#view-title")).to_have_text("찾기 결과")
    page.locator(f'.content-body a[href="watch.html?id={site.ids[ZMG]}"]:visible').click()
    expect(page.locator("#title")).to_have_text("제망매가")
    page.locator("#next-lecture").click()
    expect(page.locator("#title")).to_have_text("제망매가 학습활동")
    expect(page.locator("#back")).to_have_text("미래엔")
    page.locator("#back").click()

    expect(page.locator("#view-title")).to_have_text("미래엔")  # '찾기 결과 · 강의 2개 · ‘제망’'이 아님
    expect(page.locator("#search")).to_have_value("")
    expect(page.locator(".content-body .video-list a:visible")).to_have_count(3)


@pytest.mark.parametrize("start", ["notes.html", "review.html"])
def test_a_folder_picked_in_another_screens_sidebar_is_not_hidden_by_a_title_search(page, site, start):
    page.goto(site.url + "/")
    page.fill("#search", "제망")
    expect(page.locator("#view-title")).to_have_text("찾기 결과")
    page.click(f'nav.sidebar a[href="{start}"]')
    page.locator("nav.sidebar a", has_text="시험").click()

    expect(page.locator("#view-title")).to_have_text("시험")
    expect(page.locator(".content-body .video-list a:visible")).to_have_count(2)
    page.go_back()
    page.go_back()  # 찾던 화면으로 돌아가면 찾던 것 그대로
    expect(page.locator("#search")).to_have_value("제망")
    expect(page.locator("#view-title")).to_have_text("찾기 결과")


def test_an_old_spoken_search_does_not_greet_the_student_when_the_app_opens(phone, site):
    page = phone(390, 844)
    page.goto(site.url + "/")
    page.locator("#scope-spoken").tap()
    page.fill("#search", "반어법")
    page.locator("#find-btn").tap()
    page.locator("#found li > a").first.tap()
    expect(page.locator("#title")).to_have_text("제망매가")
    page.locator("#next-lecture").tap()
    expect(page.locator("#title")).to_have_text("제망매가 학습활동")
    page.locator("#back").tap()  # '‹ 미래엔'
    expect(page.locator("#view-title")).to_have_text("미래엔")

    app = page.context.new_page()  # 다음 날 홈 화면의 앱을 엶(start_url ./)
    app.goto(site.url + "/")
    expect(app.locator("nav.sidebar a", has_text="2022개정")).to_be_visible()
    expect(app.locator("#view-title")).to_have_text("강의")  # 지난 선생님 말 결과가 아님
    expect(app.locator("#found")).to_be_hidden()
    expect(app.locator("#search")).to_have_value("")


def watched_four(page, site):
    """강의 넷을 보다 만 기록(제망매가를 가장 최근에)"""
    titles = [ZMG, ZMG + " 학습활동", "2022개정/고1/미래엔/청산별곡", "2022개정/고1/천재/성에꽃"]
    remember(page, site, {f"pos:{site.ids[t]}": {"t": 60, "d": 150, "at": 10 - i} for i, t in enumerate(titles)})


def test_the_phone_home_screen_starts_with_lectures_to_continue(phone, site):
    page = phone(390, 844)
    watched_four(page, site)
    page.goto(site.url + "/")
    card = page.locator("#resume")
    expect(card).to_be_visible()
    expect(card.locator("a")).to_have_count(3)  # 짧게 셋만
    expect(card.locator("a").first).to_contain_text("제망매가")
    expect(card.locator("a").first).to_contain_text("01:00까지")
    assert on_screen(page, card.locator("a").first)  # 내리지 않아도 보임
    assert card.bounding_box()["y"] < page.locator("nav.sidebar ul.tree").bounding_box()["y"]
    for control in ["#guide-only", "#view-grid", "#sort"]:  # 첫 화면에서는 아무 일도 하지 않는 단추
        expect(page.locator(control)).to_be_hidden()

    page.locator("nav.sidebar a", has_text="2022개정").tap()
    expect(page.locator("#view-title")).to_have_text("2022개정")
    expect(card).to_be_hidden()
    for control in ["#guide-only", "#view-grid", "#sort"]:  # 폴더에서는 다시
        expect(page.locator(control)).to_be_visible()


def test_controls_that_do_nothing_on_a_view_are_hidden(page, site):
    watched_four(page, site)
    page.goto(site.url + "/#v/recent")
    expect(page.locator("#recent-list a").first).to_be_visible()
    expect(page.locator("#resume")).to_be_hidden()  # 넓은 화면에는 이어 보기 목록이 따로 있음
    expect(page.locator("#guide-only")).to_be_hidden()  # 요점 정리만·정렬은 이어 보기 목록을 바꾸지 않음
    expect(page.locator("#sort")).to_be_hidden()
    expect(page.locator("#view-grid")).to_be_visible()  # 그림 보기는 이어 보기 목록에도 됨

    page.click("#scope-spoken")
    page.fill("#search", "반어법")
    page.press("#search", "Enter")
    expect(page.locator("#found h2").first).to_contain_text("반어법")
    for control in ["#guide-only", "#view-grid", "#sort"]:  # 선생님 말 결과에는 하나도 안 됨
        expect(page.locator(control)).to_be_hidden()


def picks(page, site, *titles):
    """선생님이 고른 '이번 주 강의'(첫 강의에 대상 학년 고1)"""
    page.route("**/api/picks", lambda route: route.fulfill(json={"note": "", "at": None, "lectures": [
        {"id": site.ids[t], "title": t, "grade": "고1" if i == 0 else ""} for i, t in enumerate(titles)]}))


@pytest.mark.parametrize("width", [1200, 390], ids=["desktop", "phone"])
def test_this_weeks_lectures_show_progress_and_where_they_are(phone, site, width):
    page = phone(width, 844)
    picks(page, site, ZMG, "2022개정/고1/천재/성에꽃")
    remember(page, site, {f"pos:{site.ids[ZMG]}": {"t": 148, "d": 150, "at": 1},
                          f"pos:{site.ids['2022개정/고1/천재/성에꽃']}": {"t": 60, "d": 150, "at": 2}})
    page.goto(site.url + "/")
    rows = page.locator(".picks li a")
    expect(rows).to_have_count(2)
    expect(rows.nth(0)).to_contain_text("고1 · 미래엔")  # '1강 …'처럼 이름이 같아도 어느 책인지 알게
    expect(rows.nth(0)).to_contain_text("다 봄")
    expect(rows.nth(1)).to_contain_text("고1 · 천재")
    expect(rows.nth(1)).to_contain_text("01:00까지")
    expect(rows.nth(1).locator(".progress")).to_be_visible()


def test_lists_use_the_two_student_words_for_what_to_read(page, site):
    page.goto(site.url + "/#v/new")  # 테스트 강의는 모두 방금 올라옴
    badge = lambda title: page.locator(f'#new-list a[href$="{site.ids[title]}"] .badge')  # noqa: E731
    expect(badge(ZMG)).to_have_text("요점 정리")
    expect(badge(ZMG + " 학습활동")).to_have_text("요점 정리")  # 학원 정리도 읽을 것이면 요점 정리
    expect(badge("시험/길이 없는 분석")).to_have_text("목차")
    expect(badge("2022개정/고1/천재/성에꽃")).to_have_text("영상만")  # '페이지'가 아님
    expect(badge("100%완성/작품")).to_have_text("준비 중")  # '분석 전'이 아님

    page.click("#scope-spoken")
    page.fill("#search", "도입")  # 말하지는 않고 챕터 제목에만 있는 낱말
    page.press("#search", "Enter")
    expect(page.locator("#found")).to_contain_text("요점 정리·목차에 나오는 강의")
    expect(page.locator("#found")).to_contain_text("시간을 누르면 그 장면부터 봅니다")
    expect(page.locator("#found")).not_to_contain_text("학원")


def test_a_keyboard_can_skip_straight_to_the_lecture_list(page, site):
    page.goto(site.url + "/#f/2022개정/고1/미래엔")
    expect(page.locator(".video-list a:visible").first).to_be_visible()
    skip = page.locator("a.skip")
    assert not on_screen(page, skip)  # 마우스로 쓸 때는 보이지 않음

    page.keyboard.press("Tab")
    expect(skip).to_be_focused()
    expect(skip).to_have_text("목록으로 건너뛰기")
    assert on_screen(page, skip)
    page.keyboard.press("Enter")

    expect(page.locator(".video-list a:focus")).to_contain_text("제망매가")  # 사이드바의 폴더들을 지나지 않고 첫 강의로
    assert unquote(page.url).endswith("#f/2022개정/고1/미래엔")  # 고른 폴더는 그대로


def test_list_controls_are_big_enough_to_tap_on_a_phone(phone, site):
    page = phone(390, 844)
    picks(page, site, ZMG)  # '내 학년' 고르기가 나오게
    sizes = lambda selector: page.evaluate(  # noqa: E731
        f"[...document.querySelectorAll('{selector}')].filter((e) => e.offsetParent)"
        ".map((e) => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)])")
    page.goto(site.url + "/")
    expect(page.locator(".my-grade")).to_be_visible()
    for selector in [".my-grade", "nav.sidebar button.disclosure", ".scope button"]:
        found = sizes(selector)
        assert found and min(min(w, h) for w, h in found) >= 40, (selector, found)
    page.locator("nav.sidebar a", has_text="2022개정").tap()
    expect(page.locator("#view-grid")).to_be_visible()
    for selector in [".layout button", "#sort"]:
        found = sizes(selector)
        assert found and min(h for _, h in found) >= 40 and min(w for w, _ in found) >= 40, (selector, found)


def test_the_streak_line_does_not_contradict_the_hours_studied(page, site):
    page.clock.install(time=datetime(2026, 11, 4, 10, 0, tzinfo=KST))  # 수요일
    remember(page, site, {"study": {"2026-11-02": 3600}})  # 월요일에 1시간, 어제·오늘은 아직
    page.goto(site.url + "/")
    expect(page.locator(".week-head strong")).to_have_text("1시간 0분")
    expect(page.locator(".week .streak")).to_have_text("오늘 강의를 보면 1일째가 됩니다")  # '기록이 시작됩니다'가 아님


def test_search_messages_say_what_went_wrong_and_what_to_do_next(page, site):
    page.goto(site.url + "/")
    expect(page.locator(".video-list a").first).to_be_attached()
    page.fill("#search", "ㅂㅇㅂ")  # 자음만
    expect(page.locator("#empty")).to_contain_text("자음·모음만으로는 찾을 수 없습니다")
    expect(page.locator("#empty button")).to_have_count(0)
    page.click("#scope-spoken")
    expect(page.locator("#found")).to_contain_text("자음·모음만으로는 찾을 수 없습니다")  # '두 글자 이상'이 아님

    page.fill("#search", "아무도안한말")
    page.press("#search", "Enter")
    expect(page.locator("#found")).to_contain_text("선생님이 이 낱말을 말한 강의가 없습니다")
    page.locator("#found button", has_text="제목에서 찾기").click()
    expect(page.locator("#scope-title")).to_have_attribute("aria-pressed", "true")

    page.click("#scope-spoken")
    page.fill("#search", "반어법")
    page.press("#search", "Enter")
    expect(page.locator("#found .found-list .meta").first).to_have_text("5번 말함")  # '5번'만으로는 무엇인지 몰랐음


def test_an_empty_search_does_not_send_the_student_back_and_forth(page, site):
    page.goto(site.url + "/")
    expect(page.locator(".video-list a").first).to_be_attached()
    page.fill("#search", "없는낱말")
    expect(page.locator("#empty")).to_contain_text("제목에는 없습니다. ‘선생님 말’에서 찾아볼까요?")
    page.locator("#empty button").click()  # 선생님 말에서 찾기

    expect(page.locator("#found")).to_contain_text("선생님이 이 낱말을 말한 강의가 없고, 강의 제목에도 없습니다")
    expect(page.locator("#found button")).to_have_count(0)  # 이미 찾지 못한 제목으로 다시 보내지 않음
    page.click("#scope-title")  # 직접 제목으로 돌아가도
    expect(page.locator("#empty")).to_contain_text("제목에도 선생님 말에도 없습니다")
    expect(page.locator("#empty button")).to_have_count(0)


def test_lectures_are_named_with_their_place_instead_of_a_slash_path(page, site):
    vid = site.ids[ZMG]
    remember(page, site, {f"notes:{vid}": [{"t": 10, "text": "메모"}],
                          f"wrong:{vid}": [{"k": "제망매가의 갈래는?", "stage": 0, "due": 0}], "list": {"scope": "spoken"}})
    for path, heading in [("/notes.html", "#notes-page h2"), ("/review.html", ".review-lecture h2")]:
        page.goto(site.url + path)
        expect(page.locator(heading).first.locator("a")).to_have_text("제망매가")  # 강의 목록 줄처럼 이름
        expect(page.locator(heading).first).to_contain_text("2022개정 · 고1 · 미래엔")  # 그 아래 위치
        expect(page.locator(heading).first).not_to_contain_text("/")

    page.goto(site.url + "/")
    page.fill("#search", "반어법")
    page.press("#search", "Enter")
    row = page.locator("#found .found-list li").first
    expect(row.locator("a").first).to_have_text("제망매가")
    expect(row).to_contain_text("2022개정 · 고1 · 미래엔")
    expect(row).not_to_contain_text("/")  # '같은 녹화'도 이름으로


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


def test_a_phone_shows_loading_and_the_retry_button_while_the_server_restarts(phone, site):
    page = phone(390, 844)
    held = []
    page.route("**/api/videos", lambda route: held.append(route))
    page.goto(site.url + "/")
    expect(page.locator("#empty")).to_have_text("불러오는 중…")
    expect(page.locator("#empty")).to_be_visible()  # 휴대폰 첫 화면이 하얗게 비어 있지 않게

    held[0].fulfill(**PROXY_502)
    expect(page.locator("#empty")).to_contain_text("서버에 연결하지 못했습니다")
    expect(page.locator("#empty")).to_be_visible()
    expect(page.locator("#empty button")).to_be_visible()

    page.unroute("**/api/videos")
    page.locator("#empty button").tap()
    expect(page.locator("nav.sidebar a", has_text="2022개정")).to_be_visible()
    expect(page.locator("#empty")).to_be_hidden()


@pytest.mark.parametrize("width, height", [(390, 844), (932, 430)], ids=["upright", "pro-max-on-its-side"])
def test_typing_boxes_are_big_enough_that_an_iphone_does_not_zoom_in(phone, site, width, height):
    page = phone(width, height)  # 아이폰은 16px보다 작은 칸을 누르면 화면을 확대해 버립니다(옆으로 눕힌 큰 아이폰은 900px보다 넓음)
    page.route("**/api/picks", lambda route: route.fulfill(json={  # '내 학년' 고르기가 나오게
        "note": "", "at": None, "lectures": [{"id": site.ids[ZMG], "title": ZMG, "grade": "고1"}]}))
    small = {}
    for path in ["/", "/notes.html", "/move.html", f"/watch.html?id={site.ids[ZMG]}"]:
        page.goto(site.url + path)
        page.wait_for_load_state("networkidle")
        found = page.evaluate("""() => [...document.querySelectorAll('input:not([type=checkbox]), textarea, select')]
            .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.id || e.className)""")
        if found:
            small[path] = found
    assert small == {}


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


def test_notes_can_be_found_by_their_text_or_lecture_name(page, site):
    remember(page, site, {f"notes:{site.ids[ZMG]}": [{"t": 10, "text": "반어법 정리"}, {"t": 20, "text": "주제"}],
                          f"notes:{site.ids['2022개정/고1/천재/성에꽃']}": [{"t": 30, "text": "반어법 예시"}],
                          f"notes:{site.ids['2022개정/고1/미래엔/청산별곡']}": [{"t": 5, "text": ""}]})
    page.goto(site.url + "/notes.html")
    notes = page.locator("#notes-page .notes li")
    expect(notes).to_have_count(4)

    page.fill("#note-filter", "반어법")
    expect(notes).to_have_count(2)
    page.fill("#note-filter", "성에꽃")  # 강의 이름으로
    expect(notes).to_have_count(1)
    expect(notes.first).to_contain_text("반어법 예시")
    page.fill("#note-filter", "북마크")
    expect(notes).to_have_count(1)
    page.fill("#note-filter", "없는말")
    expect(page.locator("#notes-page")).to_contain_text("‘없는말’에 맞는 메모가 없습니다.")
    page.fill("#note-filter", "")
    expect(notes).to_have_count(4)


def test_a_deleted_note_can_be_brought_back(page, site):
    vid = site.ids[ZMG]
    remember(page, site, {f"notes:{vid}": [{"t": 10, "text": "메모 하나"}, {"t": 20, "text": "메모 둘"}]})
    page.goto(site.url + "/notes.html")
    page.get_by_role("button", name="00:10 메모 삭제").click()
    expect(page.locator("#notes-page")).not_to_contain_text("메모 하나")

    undo = page.get_by_role("button", name="되돌리기")
    expect(undo).to_be_visible()
    undo.click()

    expect(page.locator("#notes-page")).to_contain_text("메모 하나")
    assert stored(page, f"notes:{vid}") == [{"t": 10, "text": "메모 하나"}, {"t": 20, "text": "메모 둘"}]
    expect(undo).to_be_hidden()


THREE_NOTES = [{"t": 10, "text": "첫 메모"}, {"t": 20, "text": "둘째 메모"}, {"t": 30, "text": "셋째 메모"}]


def double_tap(page, locator):
    box = locator.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.touchscreen.tap(x, y)
    page.wait_for_timeout(120)
    page.touchscreen.tap(x, y)  # 지운 자리로 올라온 다음 메모의 삭제 단추
    page.wait_for_timeout(300)


def test_a_double_tap_on_delete_removes_one_note_and_undo_brings_back_every_deleted_one(phone, site):
    page = phone(390, 844)
    vid = site.ids[ZMG]
    remember(page, site, {f"notes:{vid}": THREE_NOTES})
    page.goto(site.url + "/notes.html")
    double_tap(page, page.locator("button.delete").first)
    assert [n["text"] for n in stored(page, f"notes:{vid}")] == ["둘째 메모", "셋째 메모"]

    page.wait_for_timeout(500)
    page.locator("button.delete").first.tap()  # 일부러 하나 더
    expect(page.locator("#undo")).to_contain_text("메모 2개를 지웠습니다")
    undo = page.get_by_role("button", name="되돌리기")
    assert undo.bounding_box()["height"] >= 40  # 휴대폰에서 누르기 쉽게(다른 단추처럼)
    undo.tap()

    assert stored(page, f"notes:{vid}") == THREE_NOTES  # 마지막 하나만이 아니라 지운 메모 모두
    expect(page.locator("#notes-page .notes li")).to_have_count(3)


def test_the_keyboard_focus_stays_on_the_notes_after_deleting_and_undoing(page, site):
    vid, other = site.ids[ZMG], site.ids["2022개정/고1/천재/성에꽃"]
    remember(page, site, {f"notes:{vid}": [{"t": 10, "text": "하나"}], f"notes:{other}": [{"t": 5, "text": "둘"}]})
    page.goto(site.url + "/notes.html")
    page.get_by_role("button", name="00:10 메모 삭제").focus()
    page.keyboard.press("Enter")  # 그 강의의 마지막 메모
    expect(page.get_by_role("button", name="00:05 메모 삭제")).to_be_focused()  # 화면 맨 처음(body)이 아님

    page.get_by_role("button", name="되돌리기").focus()
    page.keyboard.press("Enter")
    expect(page.get_by_role("button", name="00:10 메모 삭제")).to_be_focused()  # 되살린 메모

    for name in ["00:10 메모 삭제", "00:05 메모 삭제"]:  # 메모가 하나도 남지 않으면 되돌리기로
        page.wait_for_timeout(500)  # 0.4초 안에 다시 누른 삭제는 받지 않음(두 번 누름)
        page.get_by_role("button", name=name).press("Enter")
    expect(page.get_by_role("button", name="되돌리기")).to_be_focused()


def test_the_undo_bar_stays_while_it_has_the_keyboard_focus(page, site):
    remember(page, site, {f"notes:{site.ids[ZMG]}": THREE_NOTES})
    page.clock.install()
    page.goto(site.url + "/notes.html")
    page.get_by_role("button", name="00:10 메모 삭제").click()
    undo = page.get_by_role("button", name="되돌리기")
    undo.focus()
    page.clock.run_for(15000)
    expect(undo).to_be_visible()  # 키보드로 찾아가는 동안 사라지지 않음

    page.focus("#note-filter")
    page.clock.run_for(5000)
    expect(undo).to_be_hidden()


@pytest.mark.parametrize("width", [1200, 390], ids=["mouse", "finger"])
def test_the_undo_bar_goes_away_after_the_last_note_is_deleted_by_mouse_or_finger(phone, site, width):
    page = phone(width, 844)
    remember(page, site, {f"notes:{site.ids[ZMG]}": [{"t": 10, "text": "하나"}]})
    page.clock.install()
    page.goto(site.url + "/notes.html")
    delete = page.get_by_role("button", name="00:10 메모 삭제")
    delete.click() if width > 900 else delete.tap()  # 남은 메모가 없어 키보드였다면 초점이 되돌리기로 가는 때
    undo = page.get_by_role("button", name="되돌리기")
    expect(undo).to_be_visible()

    page.clock.run_for(12000)
    expect(undo).to_be_hidden()  # 초점이 되돌리기에 있다고 여겨 계속 떠 있던 것


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
