"""선생님 화면(현황·학원 정리 고치기)과 내 메모 화면(브라우저 테스트)"""

import pytest

pytest.importorskip("playwright.sync_api", reason="playwright가 없어 화면 테스트를 건너뜀")
from playwright.sync_api import expect  # noqa: E402

from tests.e2e.conftest import TEACHER_KEY, remember, stored  # noqa: E402

ZMG = "2022개정/고1/미래엔/제망매가"


def open_status(page, site, key=TEACHER_KEY):
    remember(page, site, {"teacher-key": key} if key else {})
    page.goto(site.url + "/status.html")
    expect(page.locator("#counts")).to_contain_text("전체 강의")


# ---- 현황: 선생님 열쇠 ----

def test_a_key_typed_in_korean_mode_is_refused_with_a_hint(page, site):
    open_status(page, site, key=None)
    page.fill("#teacher-key", "ㄱㄴㄷ열쇠")
    page.click("#key-form button")
    expect(page.locator("#pick-status")).to_contain_text("한/영 키")
    expect(page.locator("#key-form")).to_be_visible()
    assert stored(page, "teacher-key") is None


def test_a_korean_key_saved_earlier_does_not_freeze_the_teacher_pages(page, site):
    open_status(page, site, key="선생님열쇠")  # 예전에 받아 둔 열쇠: 보내지 못하는 글자
    expect(page.locator("#key-form")).to_be_visible()
    page.goto(site.url + "/fixes.html")
    page.uncheck("#suspect-only")
    page.get_by_role("button", name="고2 · 성난 풀잎").click()
    page.locator(".fix-item").nth(1).get_by_role("button", name="저장").click()
    expect(page.locator(".fix-item").nth(1).locator(".fix-msg")).to_contain_text("열쇠가 필요합니다")


def test_a_wrong_key_says_so_instead_of_asking_for_one(page, site):
    page.route("**/api/status", lambda route: route.fulfill(status=403, json={"detail": "선생님 열쇠가 맞지 않습니다"}))
    remember(page, site, {"teacher-key": "틀린-열쇠".encode().hex()})
    page.goto(site.url + "/status.html")
    expect(page.locator("#counts")).to_contain_text("선생님 열쇠가 맞지 않습니다")
    page.reload()  # 틀린 열쇠는 지웠으니 이제는 넣어 달라는 안내
    expect(page.locator("#counts")).to_contain_text("열쇠를 넣어야")


# ---- 현황: 이번 주 강의 ----

def test_saving_picks_from_an_older_tab_warns_instead_of_undoing(page, site):
    open_status(page, site)
    old = page.context.new_page()
    old.goto(site.url + "/status.html")
    expect(old.locator("#picker")).to_be_visible()

    page.fill("#pick-search", "청산별곡")
    page.get_by_role("button", name=f"2022개정/고1/미래엔/청산별곡 더하기").click()
    page.click("#pick-save")
    expect(page.locator("#pick-status")).to_have_text("저장했습니다. 학생 화면에 바로 나옵니다.")

    old.fill("#pick-note", "한마디만 바꿈")
    old.click("#pick-save")
    expect(old.locator("#pick-status")).to_contain_text("다른 화면에서 먼저 바꿨습니다")
    page.click("#pick-save")  # 저장한 탭은 이어서 또 저장할 수 있음
    expect(page.locator("#pick-status")).to_have_text("저장했습니다. 학생 화면에 바로 나옵니다.")


def test_at_most_twenty_lectures_can_be_picked(page, site):
    fake = [{"id": f"{n:012x}", "title": f"시험/연습 강의 {n}", "added": 0, "analyzed": False, "guide": False, "toc": False}
            for n in range(30)]
    page.route("**/api/videos", lambda route: route.fulfill(json=fake))
    page.route("**/api/picks", lambda route: route.fulfill(json={"note": "", "at": None, "lectures": []})
               if route.request.method == "GET" else route.continue_())
    open_status(page, site)
    page.fill("#pick-search", "연습강의")  # 띄어쓰기 없이 찾아도 됨
    for _ in range(20):
        page.locator("#pick-found button").first.click()
    expect(page.locator("#pick-list li")).to_have_count(20)
    expect(page.locator("#pick-found")).to_contain_text("20개까지 고를 수 있습니다")


@pytest.mark.parametrize("progress, says, never", [
    ({"target": 5, "done": 5, "last_3_days": 0}, "모두 처리했습니다", "멈춰"),
    ({"target": 10, "done": 5, "last_3_days": 1}, "약 15일 더", "하루 약 0개"),
])
def test_toc_progress_wording(page, site, progress, says, never):
    def with_progress(route):
        res = route.fetch()
        route.fulfill(response=res, json={**res.json(), "toc_progress": progress})
    page.route("**/api/status", with_progress)
    open_status(page, site)
    expect(page.locator("#toc")).to_contain_text(says)
    expect(page.locator("#toc")).not_to_contain_text(never)


# ---- 학원 정리 고치기 ----

def open_fixes(page, site, key=TEACHER_KEY):
    remember(page, site, {"teacher-key": key} if key else {})
    page.goto(site.url + "/fixes.html")
    page.uncheck("#suspect-only")
    page.get_by_role("button", name="고2 · 성난 풀잎").click()
    return page.locator(".fix-item")


def test_saving_one_item_keeps_what_was_typed_in_the_others(page, site):
    cards = open_fixes(page, site)
    cards.nth(1).locator("textarea").fill("둘째 특징(고침)")
    cards.nth(2).locator("textarea").fill("아직 저장 안 한 글")
    cards.nth(1).get_by_role("button", name="저장").click()
    expect(cards.nth(1).locator(".fix-msg")).to_have_text("저장했습니다. 학생 화면에 바로 나옵니다.")
    expect(cards.nth(2).locator("textarea")).to_have_value("아직 저장 안 한 글")
    cards.nth(1).get_by_role("button", name="원래대로").click()  # 다음 테스트를 위해 되돌림
    expect(cards.nth(1).locator("textarea")).to_have_value("둘째 특징")


def test_the_key_box_opens_next_to_the_item_on_a_phone(page, site):
    page.set_viewport_size({"width": 390, "height": 800})
    cards = open_fixes(page, site, key=None)
    cards.nth(2).get_by_role("button", name="저장").click()
    expect(cards.nth(2).locator("#key-form")).to_be_visible()
    expect(cards.nth(2).locator(".fix-msg")).to_contain_text("열쇠가 필요합니다")
    page.fill("#teacher-key", TEACHER_KEY)
    page.press("#teacher-key", "Enter")
    expect(cards.nth(2).locator(".fix-msg")).to_contain_text("다시 저장해 주세요")
    cards.nth(2).get_by_role("button", name="저장").click()
    expect(cards.nth(2).locator(".fix-msg")).to_have_text("저장했습니다. 학생 화면에 바로 나옵니다.")
    expect(page.locator("#key-form")).to_be_hidden()


def test_a_hidden_suspect_item_leaves_the_suspect_list(page, site):
    remember(page, site, {"teacher-key": TEACHER_KEY})
    page.goto(site.url + "/fixes.html")  # 처음에는 '의심 항목 있는 것만'
    page.get_by_role("button", name="고2 · 성난 풀잎").click()
    page.locator(".fix-item").first.get_by_role("button", name="숨기기").click()
    expect(page.locator(".fix-item").first).to_contain_text("숨김")
    page.get_by_role("button", name="‹ 정리 목록").click()
    expect(page.get_by_role("button", name="고2 · 성난 풀잎")).to_have_count(0)

    page.uncheck("#suspect-only")  # 되돌림
    page.get_by_role("button", name="고2 · 성난 풀잎").click()
    page.locator(".fix-item").first.get_by_role("button", name="다시 보이기").click()
    expect(page.locator(".fix-item").first).not_to_contain_text("숨김")


def test_a_fill_in_question_can_be_hidden_but_not_edited(page, site):
    cards = open_fixes(page, site)
    fill = cards.filter(has_text="풀잎은 무엇을 상징하나?")
    expect(fill).to_have_count(1)
    expect(fill.locator("textarea")).to_have_count(0)  # 빈칸 표시(두 칸 띄어쓰기)가 깨지지 않게 글은 고치지 않음
    expect(fill.get_by_role("button", name="저장")).to_have_count(0)
    fill.get_by_role("button", name="숨기기").click()
    expect(fill).to_contain_text("숨김")
    expect(fill.locator(".fix-msg")).to_have_text("저장했습니다. 학생 화면에 바로 나옵니다.")
    fill.get_by_role("button", name="다시 보이기").click()  # 되돌림
    expect(fill).not_to_contain_text("숨김")


def test_the_list_says_when_only_fifty_are_shown_and_search_ignores_spacing(page, site):
    fake = [{"key": f"k{n}", "title": f"연습 작품 {n}", "grade": "고1", "suspects": 1} for n in range(60)]
    page.route("**/api/references", lambda route: route.fulfill(json=fake))
    page.goto(site.url + "/fixes.html")
    expect(page.locator("#ref-list")).to_contain_text("60개 중 50개만 보입니다")
    page.fill("#ref-search", "연습작품 59")
    expect(page.locator("#ref-list button")).to_have_text(["고1 · 연습 작품 59"])


# ---- 내 메모 ----

def test_deleting_in_an_old_notes_tab_keeps_a_note_added_elsewhere(page, site):
    vid = site.ids[ZMG]
    remember(page, site, {f"notes:{vid}": [{"t": 10, "text": "하나"}, {"t": 15, "text": "다섯"}]})
    page.goto(site.url + "/notes.html")
    expect(page.locator("#notes-page")).to_contain_text("하나")
    other = page.context.new_page()  # 플레이어 등 다른 탭에서 메모를 더함
    other.goto(f"{site.url}/manifest.json")
    other.evaluate("key => localStorage.setItem(key, JSON.stringify([...JSON.parse(localStorage.getItem(key)), {t: 20, text: '둘'}]))",
                   f"notes:{vid}")
    expect(page.locator("#notes-page")).to_contain_text("둘")  # 이 화면도 바로 다시 그림

    page.get_by_role("button", name="00:10 메모 삭제").focus()
    page.keyboard.press("Enter")
    assert stored(page, f"notes:{vid}") == [{"t": 15, "text": "다섯"}, {"t": 20, "text": "둘"}]
    expect(page.get_by_role("button", name="00:15 메모 삭제")).to_be_focused()  # 초점이 맨 위로 튀지 않음


def test_deleting_in_the_player_keeps_a_note_added_in_another_tab(page, site):
    vid = site.ids[ZMG]
    remember(page, site, {f"notes:{vid}": [{"t": 10, "text": "하나"}]})
    page.goto(f"{site.url}/watch.html?id={vid}")
    page.click("[data-tab=notes]")
    expect(page.locator("#notes")).to_contain_text("하나")
    page.evaluate("key => localStorage.setItem(key, JSON.stringify([{t: 10, text: '하나'}, {t: 20, text: '둘'}]))", f"notes:{vid}")
    page.get_by_role("button", name="00:10 메모 삭제").click()
    assert stored(page, f"notes:{vid}") == [{"t": 20, "text": "둘"}]
