"""학습 플레이어 화면(브라우저 테스트): 이어 보기, 구간 반복, 북마크, 학원 정리 강조"""

import re

import pytest

pytest.importorskip("playwright.sync_api", reason="playwright가 없어 화면 테스트를 건너뜀")
from playwright.sync_api import expect  # noqa: E402

from tests.e2e.conftest import remember, stored  # noqa: E402
from tests.e2e.phones import on_screen, phone  # noqa: E402,F401

ZMG = "2022개정/고1/미래엔/제망매가"
VIDEO = "document.querySelector('video')"


def open_player(page, site, title=ZMG, query=""):
    page.goto(f"{site.url}/watch.html?id={site.ids[title]}{query}")
    expect(page.locator("#title")).to_have_text(title.rsplit("/", 1)[-1])
    page.wait_for_function(f"{VIDEO}.readyState >= 1")


def open_slowly(page, site, title=ZMG):
    """영상 요청을 붙잡아 둔 채(느린 인터넷) 플레이어를 엽니다. 돌려준 함수를 부르면 영상이 옵니다."""
    held, released = [], []
    page.route("**/media/**", lambda route: route.continue_() if released else held.append(route))
    page.goto(f"{site.url}/watch.html?id={site.ids[title]}")
    expect(page.locator(".chapter button.time").first).to_be_visible()

    def release():
        released.append(True)
        for route in held:
            route.continue_()
        page.wait_for_function(f"{VIDEO}.readyState >= 1")
    return release


def go(page, t):
    """영상의 t초로 옮기고 다 옮길 때까지 기다립니다."""
    page.evaluate(f"t => {{ const v = {VIDEO}; const done = new Promise((r) => v.addEventListener('seeked', r, {{ once: true }}));"
                  " v.currentTime = t; return done; }", t)


def now(page):
    return page.evaluate(f"{VIDEO}.currentTime")


def test_pausing_before_the_video_loads_keeps_the_resume_position(page, site):
    remember(page, site, {f"pos:{site.ids[ZMG]}": {"t": 60, "d": 150, "at": 1}})
    release = open_slowly(page, site)
    page.evaluate(f"async () => {{ const v = {VIDEO}; v.play().catch(() => {{}}); await new Promise((r) => setTimeout(r, 150)); v.pause(); }}")
    assert stored(page, f"pos:{site.ids[ZMG]}")["t"] == 60
    release()
    expect(page.locator("#status")).to_contain_text("지난번에 보던 01:00부터")
    assert round(now(page)) == 60


def test_a_chapter_picked_before_the_video_loads_wins_over_resume(page, site):
    remember(page, site, {f"pos:{site.ids[ZMG]}": {"t": 60, "d": 150, "at": 1}})
    release = open_slowly(page, site)
    page.locator(".chapter button.time").nth(1).click()  # 00:50 본문 풀이
    release()
    page.wait_for_timeout(500)  # 이어 보기가 덮어쓰는지 볼 시간
    assert 50 <= now(page) < 55
    expect(page.locator("#status")).not_to_contain_text("이어서")


def test_resume_and_time_links(page, site):
    remember(page, site, {f"pos:{site.ids[ZMG]}": {"t": 60, "d": 150, "at": 1}})
    open_player(page, site)
    expect(page.locator("#status")).to_contain_text("지난번에 보던 01:00부터")
    open_player(page, site, query="&t=50")
    expect(page.locator("#status")).to_contain_text("00:50부터")
    assert round(now(page)) == 50
    open_player(page, site, query="&t=0")  # 처음 1초 안의 북마크·설명 다시 보기
    expect(page.locator("#status")).to_contain_text("00:00부터")
    assert now(page) < 1


def test_holding_b_or_r_acts_once_and_a_double_bookmark_is_one(page, site):
    open_player(page, site)
    go(page, 33)
    page.evaluate("""() => { for (let i = 0; i < 10; i++) document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', repeat: i > 0, bubbles: true, cancelable: true })); }""")
    assert len(stored(page, f"notes:{site.ids[ZMG]}")) == 1
    page.keyboard.press("b")
    assert len(stored(page, f"notes:{site.ids[ZMG]}")) == 1
    go(page, 40)
    page.evaluate("""() => { for (let i = 0; i < 5; i++) document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', repeat: i > 0, bubbles: true, cancelable: true })); }""")
    expect(page.locator("#loop-label")).to_have_text("끝점 찍기 (시작 00:40)")


def test_notes_at_different_scenes_are_all_kept(page, site):
    open_player(page, site)
    go(page, 10)
    page.keyboard.press("b")
    go(page, 40)
    page.keyboard.press("b")
    page.click("[data-tab=notes]")
    page.fill("#note-text", "메모 하나")
    page.press("#note-text", "Enter")
    assert stored(page, f"notes:{site.ids[ZMG]}") == [{"t": 10, "text": ""}, {"t": 40, "text": ""}, {"t": 40, "text": "메모 하나"}]


def test_a_note_keeps_the_scene_where_the_student_started_typing(page, site):
    open_player(page, site)
    go(page, 20)
    page.click("#bookmark-btn")
    expect(page.locator("#status")).to_contain_text("북마크했습니다")
    go(page, 30)
    page.click("[data-tab=notes]")
    page.locator("#note-text").press_sequentially("중요")
    expect(page.locator("#note-form button")).to_have_text("00:30에 추가")  # 어느 장면에 붙는지 보임
    go(page, 45)  # 쓰는 동안 영상은 지나감
    page.locator("#note-text").press_sequentially("한 장면")
    page.press("#note-text", "Enter")

    assert stored(page, f"notes:{site.ids[ZMG]}")[-1] == {"t": 30, "text": "중요한 장면"}
    expect(page.locator("#note-form button")).to_have_text("추가")
    expect(page.locator("#status")).to_have_text("")  # 지난 북마크 안내는 지움
    go(page, 60)
    page.fill("#note-text", "둘째 메모")  # 다음 메모는 다시 그때의 장면
    page.press("#note-text", "Enter")
    assert stored(page, f"notes:{site.ids[ZMG]}")[-1] == {"t": 60, "text": "둘째 메모"}


def test_a_quiz_answer_shows_its_explanation_on_a_phone_and_says_which_is_which(phone, site):
    page = phone(360, 740)
    page.goto(f"{site.url}/watch.html?id={site.ids[ZMG]}")
    page.locator("[data-tab=quiz]").tap()
    second = page.locator("#tab-quiz .question").nth(1)
    second.locator("button.choice").first.tap()  # 망각: 틀림(정답은 2번 종교)

    feedback = second.locator(".feedback")
    expect(feedback).to_contain_text("종교적으로 극복합니다.")
    assert on_screen(page, feedback)  # 해설이 화면 아래에 숨지 않음
    expect(feedback).to_contain_text("‘틀린 문제 복습’에 넣었어요")
    expect(second.locator("button.choice.right")).to_contain_text("✓ 정답")  # 색만으로 알리지 않음
    expect(second.locator("button.choice.wrong")).to_contain_text("✗ 내가 고른 답")


def test_the_player_uses_the_same_words_for_what_to_read_and_for_times(page, site):
    guide = page.locator("#tab-guide")
    open_player(page, site, ZMG + " 학습활동")  # 학원 정리를 보여 주는 강의
    expect(guide).to_contain_text("학원 정리 바탕")
    expect(guide).to_contain_text("시간을 누르면 그 장면부터 봅니다")
    expect(guide).not_to_contain_text("학원 요점 정리")
    open_player(page, site, "시험/길이 없는 분석")  # 목차만
    expect(guide).to_contain_text("시간을 누르면 그 장면부터 봅니다")
    open_player(page, site, query="&t=50")  # 내 메모·복습의 시간에서 와도 맞는 말('찾은 낱말을 말한'이 아님)
    expect(page.locator("#status")).to_have_text("00:50부터 봅니다.")
    expect(page.locator("#find-status")).to_contain_text("시간을 누르면 그 장면부터 봅니다")
    open_player(page, site, "100%완성/작품")
    expect(guide).to_contain_text("준비 중")  # 목록의 '준비 중'과 같은 말


def test_the_study_tabs_move_with_the_arrow_keys(page, site):
    open_player(page, site)
    page.focus("#tab-btn-guide")

    page.keyboard.press("ArrowRight")
    expect(page.locator("#tab-btn-pages")).to_be_focused()
    expect(page.locator("#tab-btn-pages")).to_have_attribute("aria-selected", "true")
    expect(page.locator("#tab-pages")).to_be_visible()
    assert now(page) == 0  # 영상 10초 앞으로가 아님
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("ArrowLeft")  # 맨 앞에서 ←는 맨 끝 탭(숨긴 질문하기는 건너뜀)
    expect(page.locator("#tab-btn-find")).to_be_focused()
    expect(page.locator("#tab-find")).to_be_visible()
    page.keyboard.press("Home")
    expect(page.locator("#tab-btn-guide")).to_be_focused()
    assert page.evaluate("[...document.querySelectorAll('[role=tab]')].filter((t) => t.tabIndex === 0).map((t) => t.id)") == ["tab-btn-guide"]


def test_speed_buttons_are_read_as_speeds(page, site):
    open_player(page, site)  # 화면 읽기 프로그램이 '1.25×'를 '1.25 곱하기'로 읽던 것
    names = page.evaluate("[...document.querySelectorAll('#speed button')].map((b) => b.getAttribute('aria-label'))")
    assert names == ["0.8배속", "1배속", "1.25배속", "1.5배속", "2배속"]
    page.get_by_role("button", name="1.5배속").click()
    assert page.evaluate(f"{VIDEO}.playbackRate") == 1.5


def heights(page, selector):
    return page.evaluate(f"[...document.querySelectorAll('{selector}')].filter((e) => e.offsetParent)"
                         ".map((e) => Math.round(e.getBoundingClientRect().height))")


def test_player_controls_are_big_enough_to_tap_on_a_phone(phone, site):
    page = phone(390, 844)
    page.goto(f"{site.url}/watch.html?id={site.ids[ZMG]}")
    expect(page.locator(".chapter button.time").first).to_be_visible()
    for selector in ["#speed button", ".chapter button.time", "#chapter-nav button", "#loop-btn", ".tabs button", ".top .tool", "#back"]:
        found = heights(page, selector)
        assert found and min(found) >= 40, (selector, found)


def test_the_chapter_buttons_say_chapter_so_they_are_not_taken_for_next_lecture(phone, site):
    page = phone(390, 844)  # 휴대폰은 title(마우스를 올리면 뜨는 글)을 보여 주지 않습니다
    page.goto(f"{site.url}/watch.html?id={site.ids[ZMG]}")
    expect(page.locator("#chapter-nav")).to_be_visible()
    expect(page.locator("#chapter-nav")).to_contain_text("챕터")
    assert on_screen(page, page.locator("#chapter-nav .chapter-label"))


def test_the_memo_hint_fits_in_its_box_on_small_phones(phone, site):
    page = phone(360, 740)
    page.goto(f"{site.url}/watch.html?id={site.ids[ZMG]}")
    page.locator("[data-tab=notes]").tap()
    page.locator("#note-text").focus()  # 추가 단추에 시각이 붙어 칸이 좁아진 때
    fits = page.locator("#note-text").evaluate("""(i) => { const s = getComputedStyle(i), c = document.createElement('canvas').getContext('2d');
        c.font = `${s.fontSize} ${s.fontFamily}`;
        return c.measureText(i.placeholder).width <= i.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight); }""")
    assert fits


def test_the_pages_tab_shows_two_columns_on_a_phone(phone, site):
    page = phone(360, 740)

    def with_pages(route):
        body = route.fetch().json()
        body["analysis"]["pages"] = [{"start": float(t), "label": f"교과서 {t // 30 + 12}쪽"} for t in range(0, 150, 30)]
        route.fulfill(json=body)

    page.route(re.compile(rf"/api/videos/{site.ids[ZMG]}\?view=1$"), with_pages)
    page.goto(f"{site.url}/watch.html?id={site.ids[ZMG]}")
    page.locator("[data-tab=pages]").tap()
    expect(page.locator(".pages li")).to_have_count(5)
    lefts = page.evaluate("new Set([...document.querySelectorAll('.pages li')].map((li) => Math.round(li.getBoundingClientRect().left))).size")
    assert lefts == 2


def test_finding_in_a_lecture_says_what_went_wrong_and_what_to_do_next(page, site):
    open_player(page, site)
    page.click("[data-tab=find]")
    page.fill("#find-text", "ㅂㅇㅂ")
    page.press("#find-text", "Enter")
    expect(page.locator("#find-status")).to_contain_text("자음·모음만으로는 찾을 수 없습니다")
    page.fill("#find-text", "아무도안한말")
    page.press("#find-text", "Enter")
    expect(page.locator("#find-status")).to_contain_text("선생님 말에서는 찾지 못했습니다")
    expect(page.locator("#find-status")).to_contain_text("다른 낱말로 찾아보세요")


def test_a_section_repeat_keeps_looping(page, site):
    open_player(page, site)
    go(page, 20)
    page.click("#loop-btn")
    go(page, 23)
    page.click("#loop-btn")
    expect(page.locator("#loop-label")).to_have_text("반복 00:20–00:23")
    page.evaluate(f"""() => {{ const v = {VIDEO}; let last = v.currentTime;
      v.addEventListener('timeupdate', () => {{ if (v.currentTime < last - 1) window.wrapped = true; last = v.currentTime; }});
      return v.play(); }}""")
    page.wait_for_function("window.wrapped === true", timeout=10000)
    assert 20 <= now(page) <= 23.5
    page.click("#loop-btn")
    expect(page.locator("#loop-label")).to_have_text("구간 반복")


def test_a_repeat_ending_at_the_video_end_keeps_looping_without_the_next_card(page, site):
    open_player(page, site)
    go(page, 146)
    page.click("#loop-btn")
    go(page, 999)  # 영상 끝
    page.click("#loop-btn")
    page.evaluate(f"() => {{ const v = {VIDEO}; v.addEventListener('ended', () => {{ window.endedOnce = true; }}); return v.play(); }}")
    page.wait_for_function(f"window.endedOnce && !{VIDEO}.paused && {VIDEO}.currentTime < 149", timeout=15000)
    assert now(page) >= 146
    expect(page.locator("#next-card")).to_be_hidden()


def test_the_next_lecture_card_shows_at_the_end(page, site):
    open_player(page, site)
    go(page, 148)
    page.evaluate(f"{VIDEO}.play()")
    page.wait_for_function(f"{VIDEO}.ended", timeout=10000)
    expect(page.locator("#next-card")).to_be_visible()
    expect(page.locator("#next-title")).to_have_text("제망매가 학습활동")  # 같은 폴더에서 이름순으로 다음


def test_r_again_at_or_before_the_start_clears_the_start_point(page, site):
    open_player(page, site)
    go(page, 100)
    page.click("#loop-btn")
    go(page, 90)
    page.click("#loop-btn")
    expect(page.locator("#loop-label")).to_have_text("구간 반복")
    page.click("#loop-btn")
    expect(page.locator("#loop-label")).to_have_text("끝점 찍기 (시작 01:30)")


def test_a_hand_edited_guide_without_a_quiz_still_shows(page, site):
    open_player(page, site, "시험/퀴즈 없는 요점 정리")  # 제목이 '영상을 찾을 수 없습니다'로 바뀌지 않음
    expect(page.locator("#tab-quiz")).to_contain_text("이 강의에는 퀴즈가 없습니다.")


def test_an_analysis_without_a_length_shows_every_chapter_bar(page, site):
    open_player(page, site, "시험/길이 없는 분석")
    widths = page.evaluate("[...document.querySelectorAll('.segment')].map((s) => s.getBoundingClientRect().width)")
    assert len(widths) == 3 and min(widths) > 20


def test_a_summary_with_only_fill_ins_shows_no_empty_card_but_keeps_the_quiz(page, site):
    open_player(page, site, "2022개정/고1/미래엔/청산별곡")
    expect(page.locator("#tab-guide")).to_contain_text("아직 요점 정리가 없습니다")
    expect(page.locator("#tab-guide .reference")).to_have_count(0)
    page.click("[data-tab=quiz]")
    expect(page.locator("#tab-quiz .blank-line")).to_contain_text("청산에")  # 줄 끝의 빈칸도 앞 글은 보임


def test_every_academy_item_at_the_same_time_is_highlighted(page, site):
    open_player(page, site, "2022개정/고1/미래엔/제망매가 학습활동")
    items = page.locator(".reference li")
    at_30 = items.filter(has_text="00:30")
    assert at_30.count() >= 2
    go(page, 31)
    expect(page.locator(".reference li.active")).to_have_count(at_30.count())
    go(page, 0)
    expect(page.locator(".reference li.active")).to_have_count(0)


def test_a_lecture_without_sound_says_so_instead_of_promising_a_guide(page, site):
    import re
    title = "2022개정/고1/천재/성에꽃"

    def silent(route):  # 소리 트랙이 없어 받아쓸 말이 없던 강의
        body = route.fetch().json()
        body["analysis"]["silent"] = True
        route.fulfill(json=body)

    page.route(re.compile(rf"/api/videos/{site.ids[title]}(\?|$)"), silent)
    open_player(page, site, title)

    expect(page.locator("#tab-guide")).to_contain_text("음성이 없는 영상입니다")
    expect(page.locator("#tab-guide")).not_to_contain_text("아직")


def test_the_ask_tab_shows_only_when_the_server_answers_questions(page, site):
    import re
    open_player(page, site)
    expect(page.locator("#tab-btn-ask")).to_be_hidden()  # 테스트 서버는 질문하기를 꺼 둠(ASK_ENABLED 없음)

    def asking(route):
        res = route.fetch()
        route.fulfill(response=res, json={**res.json(), "ask": True})
    page.route(re.compile(r"/api/videos/\w+\?view=1$"), asking)
    open_player(page, site)
    expect(page.locator("#tab-btn-ask")).to_be_visible()


def test_questions_keep_working_after_several_long_answers(page, site):
    import json
    sent = []

    def reply(route):
        sent.append(json.loads(route.request.post_data))
        if len(sent) <= 4:
            route.fulfill(json={"answer": "가" * 6000})  # 긴 답 네 번이면 대화 기록이 서버 한도(20,000자)를 넘음
        else:
            route.continue_()  # 실제 서버가 대화 기록을 받는지: 질문하기를 끈 테스트 서버는 기록을 받은 뒤에야 403

    page.route("**/ask", reply)
    open_player(page, site)
    page.evaluate("document.getElementById('tab-btn-ask').hidden = false")  # 지금은 숨겨 둔 탭
    page.click("[data-tab=ask]")
    for n in range(5):
        page.fill("#question", f"{n + 1}번째 질문")
        page.press("#question", "Enter")
        expect(page.locator(".bubble.assistant").nth(n)).not_to_have_text("답변을 만드는 중…")

    expect(page.locator(".bubble.assistant").last).to_contain_text("질문하기는 지금 쓰지 않습니다")  # 422(기록이 너무 김)가 아님
    assert sent[-1]["history"][0]["role"] == "user"


def test_the_video_picks_up_where_it_stopped_after_the_internet_comes_back(page, site):
    open_player(page, site)
    assert page.locator("video").get_attribute("playsinline") is not None  # 아이폰에서 전체 화면으로만 열리지 않게
    go(page, 40)
    page.evaluate(f"{VIDEO}.play()")
    page.wait_for_function(f"!{VIDEO}.paused")
    # 인터넷이 30초쯤 끊기면 브라우저가 영상 받기를 그만둡니다(MEDIA_ERR_NETWORK). 다시 연결돼도 그대로 멈춰 있던 것
    page.evaluate("""() => { const v = document.querySelector('video');
        Object.defineProperty(v, 'error', { get: () => ({ code: 2 }), configurable: true });
        v.dispatchEvent(new Event('waiting')); v.pause(); v.dispatchEvent(new Event('error')); }""")
    expect(page.locator("#status")).to_contain_text("인터넷 연결이 끊겼습니다")

    page.evaluate("() => { delete document.querySelector('video').error; window.dispatchEvent(new Event('online')); }")

    expect(page.locator("#status")).to_contain_text("40")
    page.wait_for_function(f"!{VIDEO}.paused && Math.abs({VIDEO}.currentTime - 40) < 3")


def cut_off(page):
    """재생 중에 인터넷이 끊긴 것처럼: 브라우저가 영상 받기를 그만둠(MEDIA_ERR_NETWORK)"""
    page.evaluate(f"{VIDEO}.play()")
    page.wait_for_function(f"!{VIDEO}.paused")
    page.evaluate("""() => { const v = document.querySelector('video');
        Object.defineProperty(v, 'error', { get: () => ({ code: 2 }), configurable: true });
        v.dispatchEvent(new Event('waiting')); v.pause(); v.dispatchEvent(new Event('error')); }""")
    expect(page.locator("#status")).to_contain_text("인터넷 연결이 끊겼습니다")


def test_a_scene_picked_while_the_connection_is_lost_is_where_it_comes_back(page, site):
    open_player(page, site)
    go(page, 40)
    cut_off(page)

    page.locator(".chapter button.time").nth(2).click()  # 끊긴 동안 01:40 정리를 누름
    page.evaluate("() => { delete document.querySelector('video').error; window.dispatchEvent(new Event('online')); }")

    expect(page.locator("#status")).to_contain_text("다시 연결되어 01:40부터")  # 끊긴 자리(00:40)로 돌아가지 않음
    page.wait_for_function(f"!{VIDEO}.paused && Math.abs({VIDEO}.currentTime - 100) < 3")


def test_coming_back_is_not_announced_until_the_video_itself_arrives(page, site):
    open_player(page, site)
    go(page, 40)
    cut_off(page)
    page.route("**/media/**", lambda route: route.abort("internetdisconnected"))  # 서버는 아직 꺼져 있음
    page.evaluate("""() => { const v = document.querySelector('video'); window.said = [];
        const status = document.getElementById('status');
        new MutationObserver(() => said.push(status.textContent)).observe(status, { childList: true, characterData: true, subtree: true });
        delete v.error; window.dispatchEvent(new Event('online'));
        // 브라우저에 남아 있던 앞부분(길이 등)만 오고 그 자리의 영상은 오지 않음
        v.dispatchEvent(new Event('loadedmetadata')); v.dispatchEvent(new Event('canplay')); }""")
    page.wait_for_timeout(500)

    assert not [s for s in page.evaluate("said") if "다시 연결되어" in s]
    expect(page.locator("#status")).to_contain_text("끊겼습니다")

    page.unroute("**/media/**")  # 서버가 다시 켜짐
    page.evaluate("window.dispatchEvent(new Event('online'))")
    expect(page.locator("#status")).to_contain_text("다시 연결되어 00:40부터")
    page.wait_for_function(f"!{VIDEO}.paused && Math.abs({VIDEO}.currentTime - 40) < 3")


def test_reconnecting_keeps_trying_while_the_server_is_still_restarting(page, site):
    open_player(page, site)
    go(page, 40)
    cut_off(page)
    tries = []

    def restarting(route):  # 다시 받으려 해도 처음 두 번은 서버가 답하지 않음(시놀로지가 502)
        tries.append(route.request.url)
        if len(tries) <= 2:
            route.fulfill(status=502, content_type="text/html", body="<html>502 Bad Gateway</html>")
        else:
            route.continue_()

    page.route("**/media/**", restarting)
    page.clock.install()
    page.evaluate("() => { delete document.querySelector('video').error; window.dispatchEvent(new Event('online')); }")
    for _ in range(4):  # 5초마다 다시
        page.wait_for_timeout(300)
        page.clock.run_for(5000)

    expect(page.locator("#status")).to_contain_text("다시 연결되어 00:40부터")
    page.wait_for_function(f"!{VIDEO}.paused && Math.abs({VIDEO}.currentTime - 40) < 3")


def test_a_video_the_browser_cannot_play_says_so(page, site):
    # 브라우저가 열 수 없는 코덱이거나 아직 올리는 중인 파일: 회색 화면만 보이던 것
    page.route("**/media/**", lambda route: route.fulfill(status=200, content_type="video/mp4", body="아직 올리는 중"))
    page.goto(f"{site.url}/watch.html?id={site.ids[ZMG]}")

    expect(page.locator("#status")).to_have_text("이 영상을 재생할 수 없습니다. 선생님께 알려 주세요.")
    expect(page.locator("#status")).to_be_visible()


def test_opening_a_lecture_while_the_server_restarts_waits_instead_of_blaming_the_file(page, site):
    remember(page, site, {f"pos:{site.ids[ZMG]}": {"t": 60, "d": 150, "at": 1}})
    page.route("**/media/**", lambda route: route.fulfill(status=502, content_type="text/html", body="<html>502</html>"))
    page.clock.install()
    page.goto(f"{site.url}/watch.html?id={site.ids[ZMG]}")

    expect(page.locator("#status")).to_contain_text("서버에 연결하지 못했습니다")
    expect(page.locator("#status")).not_to_contain_text("재생할 수 없습니다")

    page.unroute("**/media/**")  # 서버가 다시 켜짐
    page.clock.run_for(5000)
    page.wait_for_function(f"{VIDEO}.readyState >= 1")
    expect(page.locator("#status")).to_contain_text("01:00부터")  # 지난번에 보던 곳
    assert round(now(page)) == 60


def long_guide(page, site, title=ZMG):
    """요점 정리를 길게(챕터 12개) 바꿔 보냅니다: 휴대폰에서 탭 안을 끝까지 내려 볼 수 있게"""
    def longer(route):
        body = route.fetch().json()
        body["analysis"]["guide"]["chapters"] = [{"start": i * 12.0, "title": f"챕터 {i + 1}", "points": ["내용 하나", "내용 둘"]}
                                                 for i in range(12)]
        route.fulfill(json=body)
    page.route(re.compile(rf"/api/videos/{site.ids[title]}\?view=1$"), longer)


def test_scrolling_past_the_end_of_the_guide_keeps_the_tabs_in_view_on_a_phone(phone, site):
    page = phone(360, 740)
    long_guide(page, site)
    page.goto(f"{site.url}/watch.html?id={site.ids[ZMG]}")
    expect(page.locator(".chapter")).to_have_count(12)
    box = page.locator("#tab-guide").bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)

    for _ in range(4):  # 요점 정리 끝까지, 그리고 한 번 더
        page.mouse.wheel(0, 1500)
        page.wait_for_timeout(200)

    assert page.locator("#tab-guide").evaluate("e => e.scrollTop + e.clientHeight >= e.scrollHeight - 1")  # 끝까지 내려감
    assert on_screen(page, page.locator("#tab-btn-guide"))  # 탭 줄이 위에 붙은 영상 밑으로 들어가지 않음
    assert on_screen(page, page.locator("video"))
    panel = page.locator(".panel").bounding_box()
    assert panel["y"] + panel["height"] >= 740 - 24  # 탭 상자가 남은 높이를 채움


@pytest.mark.parametrize("width, height", [(740, 360), (844, 390)])
def test_a_phone_on_its_side_shows_the_video_and_the_study_tabs_together(phone, site, width, height):
    page = phone(width, height)
    page.goto(f"{site.url}/watch.html?id={site.ids[ZMG]}")
    expect(page.locator(".chapter").first).to_be_visible()

    video = page.locator("video").bounding_box()
    assert video["y"] >= 0 and video["y"] + video["height"] <= height  # 영상 아래쪽 재생 막대까지 화면 안
    assert on_screen(page, page.locator("video"))
    assert on_screen(page, page.locator("#tab-btn-guide"))
    assert on_screen(page, page.locator(".chapter button.time").first)  # 요점 정리도 영상 옆에 보임


BLOCKED_STORAGE = """Object.defineProperty(window, 'localStorage', {  // 아이폰 '모든 쿠키 차단', 크롬 '사이트 데이터 차단'
    get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });"""


def test_a_browser_that_cannot_save_says_so_and_keeps_the_typed_note(page, site):
    page.add_init_script(BLOCKED_STORAGE)
    open_player(page, site)

    expect(page.locator("#storage-warning")).to_contain_text("저장할 수 없습니다")
    page.click("[data-tab=notes]")
    page.fill("#note-text", "중요한 장면")
    page.click("#note-form button[type=submit]")
    expect(page.locator("#note-text")).to_have_value("중요한 장면")  # 저장하지 못한 글을 지우지 않음
    page.click("#bookmark-btn")
    expect(page.locator("#status")).not_to_contain_text("북마크했습니다")


def test_a_server_restart_is_not_shown_as_a_missing_lecture(page, site):
    page.route("**/api/videos/*?view=1", lambda route: route.fulfill(
        status=502, content_type="text/html", body="<html>502 Bad Gateway</html>"))
    page.goto(f"{site.url}/watch.html?id={site.ids[ZMG]}")

    expect(page.locator("#tab-guide")).to_contain_text("서버에 연결하지 못했습니다")
    expect(page.locator("#title")).not_to_have_text("영상을 찾을 수 없습니다")

    page.unroute("**/api/videos/*?view=1")
    page.goto(f"{site.url}/watch.html?id=000000000000")  # 정말 없는 강의는 그대로
    expect(page.locator("#title")).to_have_text("영상을 찾을 수 없습니다")
    page.wait_for_load_state("networkidle")
    expect(page.locator("#status")).to_have_text("")  # 영상도 없지만 '재생할 수 없습니다'를 더 말하지 않음


def test_searching_this_lecture_offline_does_not_spin_forever(page, site):
    open_player(page, site)
    page.route("**/search?**", lambda route: route.abort("internetdisconnected"))
    page.click("[data-tab=find]")

    page.fill("#find-text", "반어법")
    page.press("#find-text", "Enter")

    expect(page.locator("#find-status")).to_contain_text("서버에 연결하지 못했습니다")


def test_a_moved_lectures_notes_show_the_first_time_it_is_opened(page, site):
    vid, old = site.ids[ZMG], "0123456789ab"
    remember(page, site, {f"notes:{old}": [{"t": 10, "text": "옮기기 전 메모"}]})
    page.route("**/api/moves", lambda route: route.fulfill(json={old: vid}))
    open_player(page, site)

    page.click("[data-tab=notes]")

    expect(page.locator("#notes")).to_contain_text("옮기기 전 메모")


def test_the_question_box_sends_once_keeps_new_typing_and_links_only_real_times(page, site):
    import json
    sent, held = [], []
    page.route("**/ask", lambda route: (sent.append(json.loads(route.request.post_data)), held.append(route)))
    open_player(page, site)
    page.evaluate("document.getElementById('tab-btn-ask').hidden = false")  # 지금은 숨겨 둔 탭
    page.click("[data-tab=ask]")

    page.fill("#question", "첫 질문")
    page.press("#question", "Enter")
    page.press("#question", "Enter")  # 답을 기다리는 동안 한 번 더(질문 횟수·비용이 두 배)
    page.wait_for_timeout(300)
    assert len(sent) == 1
    page.fill("#question", "다음 질문")  # 기다리는 동안 다음 질문을 써 둠
    held[0].fulfill(json={"answer": "[00:30]에서 설명하고 [59:59]에도 나옵니다"})

    expect(page.locator(".bubble.assistant").last).to_contain_text("설명하고")
    expect(page.locator("#question")).to_have_value("다음 질문")
    expect(page.locator(".bubble.assistant button.time")).to_have_text(["00:30"])  # 영상(2:30)보다 뒤 시각은 누를 수 없게
    page.unroute("**/ask")
    page.route("**/ask", lambda route: route.abort("internetdisconnected"))
    page.press("#question", "Enter")
    expect(page.locator(".bubble.assistant").last).to_contain_text("서버에 연결하지 못했습니다")  # 'Failed to fetch'가 아님
