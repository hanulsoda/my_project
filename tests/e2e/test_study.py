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
    site = study_site([entry_with(FULL, words=[{"w": "가짜낱말", "def": "가짜 낱말 뜻"}])])
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


# ---- 시험대비 탭 ----
def open_quiz(page, site, entry=None):
    open_notes(page, site)
    page.click("#tab-btn-study-quiz")
    return page.locator("#tab-study-quiz")


def entry_with_short(answer, alts=()):
    entry = make_entry()
    entry["quiz"]["short"][0].update(answer=answer, alts=list(alts))
    return entry


def test_quiz_tab_has_passages_and_35_questions_in_four_sections(page, study_site):
    site = study_site([make_entry()])
    open_notes(page, site, UNLINKED)
    expect(page.locator("#tab-btn-study-quiz")).to_be_hidden()
    box = open_quiz(page, site)
    expect(page.locator("#tab-btn-study-quiz")).to_have_text("시험대비")
    expect(box).to_contain_text("점수는 연습용이며 실제 평가가 아닙니다.")
    passage = box.locator("details.study-passage")
    expect(passage).to_have_count(1)
    assert passage.evaluate("d => d.open") is True
    expect(passage.locator("summary")).to_have_text("[가] 가짜 지문 제목")
    expect(box.get_by_text("가짜 문단입니다.")).to_be_visible()
    expect(box.locator(".question")).to_have_count(35)
    heads = box.locator("h3.study-section")
    expect(heads).to_have_text(["객관식 (5지선다)", "주관식", "OX", "단답형"])
    expect(box.locator(".question h3").nth(34)).to_contain_text("Q35.")


def test_mc_and_ox_grade_instantly_without_review_promise(page, study_site):
    site = study_site([make_entry()])
    box = open_quiz(page, site)
    first = box.locator(".question").first  # 객관식 0번: 정답은 첫 보기
    first.locator(".choice").nth(1).click()
    expect(first).to_contain_text("가짜 해설입니다")
    expect(first).to_contain_text("아쉬워요.")
    expect(box).not_to_contain_text("틀린 문제 복습")
    ox = box.locator(".question", has_text="가짜 OX 0번")
    ox.locator(".choice").nth(0).click()  # 0번은 정답 O
    expect(ox).to_contain_text("정답입니다!")
    expect(box.locator(".study-score")).to_contain_text("1/30")  # 맞힌 문제만 셉니다(틀린 1개, 맞은 1개)
    # 기본 동작은 그대로: 옵션 없이 부르면 문구가 있고, review:false면 없다
    texts = page.evaluate("""() => {
      const run = (options) => {
        const card = quizCard({question: "q", choices: ["a", "b"], answer: 0, explanation: "e"}, 1, () => {}, () => null, options);
        document.body.append(card); card.querySelectorAll(".choice")[1].click(); return card.textContent;
      };
      return [run(), run({review: false})];
    }""")
    assert "‘틀린 문제 복습’에 넣었어요." in texts[0]
    assert "틀린 문제 복습" not in texts[1]


def answer_short(box, n, text):
    card = box.locator(".question", has_text=f"가짜 단답형 {n}번")
    card.locator("input").fill(text)
    card.get_by_role("button", name="확인").click()
    return card


def test_short_answer_ignores_spaces_case_and_punctuation(page, study_site):
    entry = entry_with_short("매스 미디어")
    entry["quiz"]["short"][1].update(answer="SNS", alts=[])
    entry["quiz"]["short"][2].update(answer="정답", alts=[])
    entry["quiz"]["short"][5].update(answer="매스 미디어", alts=[])
    site = study_site([entry])
    box = open_quiz(page, site)
    score = box.locator(".study-score")
    expect(score).to_contain_text("0/30")
    expect(answer_short(box, 0, "매스미디어")).to_contain_text("정답입니다!")
    expect(score).to_contain_text("1/30")
    entry_two = answer_short(box, 1, "sns")
    expect(entry_two).to_contain_text("정답입니다!")
    expect(answer_short(box, 3, "가짜 다른 답.")).to_contain_text("정답입니다!")  # alts
    # 빈 입력은 채점하지 않습니다
    blank = answer_short(box, 4, "   ")
    expect(blank).to_contain_text("답을 써 주세요.")
    expect(score).to_contain_text("3/30")
    expect(answer_short(box, 5, "매스 미디어.")).to_contain_text("정답입니다!")
    expect(score).to_contain_text("4/30")
    # 틀린 답: 정답·해설을 보이고 '내 답도 맞아요'로 정정
    wrong = answer_short(box, 2, "<b>엉뚱</b>")
    expect(wrong).to_contain_text("정답")
    expect(wrong).to_contain_text("가짜 해설입니다")
    assert wrong.locator("b").count() == 0  # 학생이 쓴 글은 HTML로 그리지 않음
    expect(score).to_contain_text("4/30")
    wrong.get_by_role("button", name="내 답도 맞아요").click()
    expect(score).to_contain_text("5/30")
    expect(wrong).to_contain_text("정답입니다!")


def test_subjective_reveals_model_answer(page, study_site):
    site = study_site([make_entry()])
    box = open_quiz(page, site)
    card = box.locator(".question", has_text="가짜 주관식 0번")
    card.locator("textarea").fill("내 생각")
    expect(card).not_to_contain_text("가짜 모범 답안입니다")
    card.get_by_role("button", name="모범 답안 보기").click()
    expect(card).to_contain_text("가짜 모범 답안입니다")
    expect(card).to_contain_text("가짜 참고입니다")
    expect(card.get_by_role("button", name="알았어요")).to_be_visible()
    expect(card.get_by_role("button", name="몰랐어요")).to_be_visible()


def solve_all(box):
    for n in range(10):
        box.locator(".question", has_text=f"가짜 객관식 {n}번").locator(".choice").nth(n % 5).click()
    for n in range(10):
        box.locator(".question", has_text=f"가짜 OX {n}번").locator(".choice").nth(0 if n % 2 == 0 else 1).click()
    for n in range(10):
        answer_short(box, n, "가짜답")


def test_score_is_saved_under_study_key_only(page, study_site):
    site = study_site([make_entry()])
    box = open_quiz(page, site)
    keys_before = page.evaluate("Object.keys(localStorage)")
    solve_all(box)
    expect(box.locator(".study-score")).to_contain_text("30/30")
    saved = page.evaluate("JSON.parse(localStorage.getItem('study:midaen-4-2'))")
    assert saved["right"] == 30 and saved["total"] == 30 and saved["at"] > 0
    new_keys = set(page.evaluate("Object.keys(localStorage)")) - set(keys_before)
    assert "study:midaen-4-2" in new_keys
    assert not [k for k in new_keys if k.startswith(("wrong:", "score:"))]
    # 다음에 열면 지난번 점수가 보이고, 다시 풀기는 탭을 새로 그린다
    page.reload()
    page.click("#tab-btn-study-quiz")
    expect(page.locator("#tab-study-quiz .study-score")).to_contain_text("지난번 30/30")
    page.locator("#tab-study-quiz").locator(".choice").first.click()
    page.get_by_role("button", name="다시 풀기").click()
    expect(page.locator("#tab-study-quiz .choice:disabled")).to_have_count(0)


def test_mc_and_ox_titles_and_choices_allow_b_u_br_only(page, study_site):
    evil = "<img src=x onerror=window.hacked=1>"
    entry = make_entry()
    entry["quiz"]["mc"][0].update(q=f"다음 <u>밑줄</u> 친 말은? {evil}\n〈보기〉 <u>보기밑줄</u>",
                                  choices=["<u>밑줄보기</u>", f"가짜 {evil}", "셋", "넷", "다섯"], answer=0)
    entry["quiz"]["ox"][0].update(q="다음 <u>밑줄</u> 문장은 맞다", answer=True)
    site = study_site([entry])
    box = open_quiz(page, site)
    mc = box.locator(".question").first
    expect(mc.locator("h3 u")).to_have_text("밑줄")
    expect(mc.locator("h3")).to_contain_text("<img src=x onerror=window.hacked=1>")
    expect(mc.locator("blockquote u")).to_have_text("보기밑줄")
    expect(mc.locator(".choice").first.locator("u")).to_have_text("밑줄보기")
    expect(mc.locator(".choice").nth(1)).to_contain_text("<img src=x onerror=window.hacked=1>")
    assert mc.locator("img").count() == 0
    mc.locator(".choice").nth(1).click()
    expect(mc.locator(".choice").first).to_contain_text("✓ 정답")
    expect(mc.locator(".choice").nth(1)).to_contain_text("✗ 내가 고른 답")
    expect(mc.locator(".choice").first.locator("u")).to_have_text("밑줄보기")
    expect(mc.locator(".feedback")).to_contain_text("아쉬워요.")
    ox = box.locator(".question", has_text="문장은 맞다")
    expect(ox.locator("h3 u")).to_have_text("밑줄")
    ox.locator(".choice").nth(0).click()
    expect(ox).to_contain_text("정답입니다!")
    assert page.evaluate("window.hacked") is None
