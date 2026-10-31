"""학습 플레이어 화면(브라우저 테스트): 이어 보기, 구간 반복, 북마크, 학원 정리 강조"""

import pytest

pytest.importorskip("playwright.sync_api", reason="playwright가 없어 화면 테스트를 건너뜀")
from playwright.sync_api import expect  # noqa: E402

from tests.e2e.conftest import remember, stored  # noqa: E402

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
