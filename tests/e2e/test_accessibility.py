"""접근성(브라우저 테스트): 모든 화면에 axe-core(WCAG 2.1 A/AA와 권장 사항)를 돌려 위반이 없는지 봅니다.

axe-core는 npm으로 받고 AXE_JS에 axe.min.js 경로를 알려 줍니다(GitHub 테스트는 자동). 없으면 건너뜁니다.
  npm install --prefix /tmp/axe axe-core@4.10.3 && AXE_JS=/tmp/axe/node_modules/axe-core/axe.min.js python -m pytest tests/e2e
"""

import os

import pytest

pytest.importorskip("playwright.sync_api", reason="playwright가 없어 화면 테스트를 건너뜀")
from playwright.sync_api import expect  # noqa: E402

from tests.e2e.conftest import TEACHER_KEY, remember  # noqa: E402

AXE = os.environ.get("AXE_JS", "")
pytestmark = pytest.mark.skipif(not os.path.isfile(AXE), reason="axe-core가 없어 접근성 테스트를 건너뜀(AXE_JS)")
ZMG = "2022개정/고1/미래엔/제망매가"


def violations(page):
    page.wait_for_load_state("networkidle")
    page.add_script_tag(path=AXE)
    found = page.evaluate("""() => axe.run(document, {runOnly: {type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']}})""")["violations"]
    return [f"{v['id']}: {v['help']} → {[n['target'][0] for n in v['nodes'][:3]]}" for v in found]


@pytest.mark.parametrize("width", [1200, 390], ids=["desktop", "phone"])
def test_every_screen_passes_the_accessibility_check(page, site, width):
    page.set_viewport_size({"width": width, "height": 850})
    vid = site.ids[ZMG]
    remember(page, site, {"teacher-key": TEACHER_KEY, f"notes:{vid}": [{"t": 10, "text": "메모"}],
                          f"wrong:{vid}": [{"k": "제망매가의 갈래는?", "stage": 0, "due": 0}],
                          f"pos:{vid}": {"t": 60, "d": 150, "at": 1}})
    problems = {}

    def check(name):
        if found := violations(page):
            problems[name] = found

    for name, path in [("첫 화면", "/"), ("폴더", "/#f/2022개정/고1/미래엔"), ("이어 보기", "/#v/recent"),
                       ("복습", "/review.html"), ("내 메모", "/notes.html"), ("기기 옮기기", "/move.html"),
                       ("현황", "/status.html")]:
        page.goto(site.url + path)
        page.reload()  # 같은 문서의 # 주소만 바뀌는 이동도 새로 그리게
        check(name)
    page.goto(f"{site.url}/watch.html?id={vid}")
    expect(page.locator("#title")).to_have_text("제망매가")
    for tab in ["guide", "quiz", "notes", "find", "pages"]:
        page.click(f"[data-tab={tab}]")
        check(f"플레이어 {tab}")
    page.goto(f"{site.url}/watch.html?id={site.ids['2022개정/고1/미래엔/제망매가 학습활동']}")
    check("플레이어 학원 정리")
    page.goto(site.url + "/fixes.html")
    check("고치기 목록")
    page.get_by_role("button", name="고2 · 성난 풀잎").click()
    check("고치기 항목")

    assert problems == {}
