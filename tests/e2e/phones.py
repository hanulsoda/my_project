"""휴대폰 화면(좁은 화면, 손가락) 브라우저: 화면 테스트들이 함께 씁니다.

1200px 화면에서는 보이던 것이 휴대폰에서는 가려지거나 숨은 적이 있어, 휴대폰 문제는 휴대폰 크기로 열어 봅니다.
"""

import pytest


@pytest.fixture
def phone(browser, site):
    """phone(가로, 세로)로 휴대폰 화면을 엽니다(테스트마다 기록이 빈 학생). 화면에서 오류가 나면 실패로 칩니다."""
    contexts, errors = [], []

    def open_phone(width=390, height=844, **extra):
        context = browser.new_context(timezone_id="Asia/Seoul", viewport={"width": width, "height": height},
                                      is_mobile=True, has_touch=True, **extra)
        contexts.append(context)
        page = context.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        return page

    yield open_phone
    for context in contexts:
        context.close()
    assert not errors, f"화면 오류: {errors}"


def on_screen(page, locator):
    """요소가 화면 안에 있고 다른 것(위에 붙은 영상 등)에 가려지지 않았는지: 가운데 점에 있는 것이 그 요소인지 봅니다.
    to_be_visible()은 가려졌거나 화면 밖이어도 통과합니다."""
    return locator.evaluate("""(e) => { const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (!r.width || !r.height || x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
        const hit = document.elementFromPoint(x, y); return !!hit && (hit === e || e.contains(hit)); }""")
