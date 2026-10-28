"""화면 색(style.css): 밝은·어두운 모드 모두 글자는 바탕과 4.5:1, 입력칸·버튼 테두리는 3:1 이상(WCAG AA)."""

import re
from pathlib import Path

import pytest

CSS = (Path(__file__).parent.parent / "academy" / "static" / "style.css").read_text(encoding="utf-8")


def tokens(block):
    return dict(re.findall(r"--([\w-]+):\s*(#[0-9a-fA-F]{6})\b", block))


LIGHT = tokens(CSS.split("@media (prefers-color-scheme: dark)")[0])
DARK = {**LIGHT, **tokens(re.search(r"@media \(prefers-color-scheme: dark\) \{(.*?)\n\}", CSS, re.S).group(1))}

# (글자·선 색, 그 뒤 바탕색)
TEXT = [("text", bg) for bg in ("bg", "surface", "hover", "fill", "segment", "highlight", "accent-soft",
                                "right-soft", "wrong-soft")]
TEXT += [("muted", bg) for bg in ("bg", "surface", "hover", "fill")]
TEXT += [("accent", "bg"), ("accent", "surface"), ("accent", "accent-soft"), ("on-accent", "accent")]
LINES = [("control", "bg"), ("control", "surface"), ("right", "surface"), ("wrong", "surface")]


def luminance(hex_color):
    channels = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    r, g, b = (c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    hi, lo = sorted([luminance(a), luminance(b)], reverse=True)
    return (hi + 0.05) / (lo + 0.05)


@pytest.mark.parametrize("colors", [LIGHT, DARK], ids=["light", "dark"])
def test_text_and_control_edges_stand_out_from_their_backgrounds(colors):
    weak = [f"{fg} on {bg}: {contrast(colors[fg], colors[bg]):.2f}" for pairs, need in ((TEXT, 4.5), (LINES, 3))
            for fg, bg in pairs if contrast(colors[fg], colors[bg]) < need]

    assert weak == []


def test_the_contrast_check_rejects_a_color_too_pale_for_text():
    assert contrast("#007aff", "#ffffff") < 4.5  # 맥 기본 파랑은 흰 바탕 글자로 쓰기엔 옅습니다
    assert round(contrast("#000000", "#ffffff"), 1) == 21.0
