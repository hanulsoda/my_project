"""학원 요점 정리 항목이 강의의 언제 나오는지 받아쓰기 대본에서 찾습니다(Claude 없이).

시험해 보니 화면 글자는 정리 프린트처럼 모든 항목이 한 화면에 오래 떠 있어 오히려 틀려서 대본만 씁니다.
"""

import math
import re
from bisect import bisect_right
from collections import Counter
from itertools import accumulate

WINDOW = 180  # 3분 구간을 1분 30초씩 옮겨 가며 봅니다
MIN_SCORE = 0.3  # 항목 글자 조각이 이만큼 겹쳐야 시간을 붙입니다(시험에서 Claude 챕터와 82% 일치)


_NOT_WORD = re.compile(r"[^가-힣a-zA-Z0-9]")


def _norm(text):
    return _NOT_WORD.sub("", text)


def _pieces(line):
    """다듬은 줄(_norm)의 세 글자 조각"""
    return {line[i:i + 3] for i in range(len(line) - 2)}


def _grams(text):
    return _pieces(_norm(text))


def _spoken_forms(term):
    """어휘 낱말을 강의에서 찾을 꼴. 사전형('포효하다')은 '포효하는·포효해·포효했다'처럼 말하므로 줄기로도 찾습니다.
    줄기가 한 글자면(바다 → 바) 다른 말과 겹치기 쉬워 사전형 그대로만 찾습니다."""
    forms = [term]
    if term.endswith("다") and len(term) >= 3:
        stem = term[:-1]
        forms.append(stem)
        if stem.endswith("하"):  # 하다 → 해·했(줄어든 꼴)
            forms += [stem[:-1] + "해", stem[:-1] + "했"]
    return forms


def link_times(summaries, segments) -> list[dict]:
    """학원 정리 [{"source", "sections", "quiz"}]에 시간을 붙인 사본을 돌려줍니다.

    sections마다 items와 나란한 "times"(초 또는 None), 어휘 퀴즈에는 그 낱말의 "time"을 붙입니다.
    """
    end = max((s["end"] for s in segments), default=0)
    lines = [_norm(s["text"]) for s in segments]  # 띄어쓰기·기호를 뺀 대본 줄(줄마다 한 번만 다듬음)
    grams = [_pieces(line) for line in lines]
    windows = [[n for n, s in enumerate(segments) if s["start"] < t + WINDOW and s["end"] > t]
               for t in range(0, math.ceil(end), WINDOW // 2)]
    window_grams = [set().union(*(grams[n] for n in said)) for said in windows]
    # 글자 조각이 나오는 구간 수: 항목에 든 조각만 셉니다(대본의 모든 조각을 세면 몇 배 느림).
    asked = set().union(*(_grams(item) for summary in summaries for s in summary["sections"] for item in s["items"]))
    df = Counter(g for wg in window_grams for g in wg & asked)

    # 대본 줄을 '|'로 이어 두고 낱말마다 한 번에 찾습니다(찾는 꼴에는 '|'가 없어 줄을 넘지 않음).
    said = "|".join(lines)
    line_ends = list(accumulate(len(line) + 1 for line in lines))

    def word_time(item):
        term = _norm(item.split("(")[0])
        if len(term) < 2:
            return None
        found = [at for at in (said.find(f) for f in _spoken_forms(term)) if at >= 0]
        return segments[bisect_right(line_ends, min(found))]["start"] if found else None  # 가장 먼저 말한 줄

    def sentence_time(item):
        if not windows:
            return None
        # 여러 구간에 흔한 글자 조각('그다음' 등)은 가볍게 봅니다.
        weight = {g: math.log(len(windows) / (1 + df[g])) + 1 for g in _grams(item)}
        if len(weight) < 2:
            return None
        overlap = lambda grams: sum(v for g, v in weight.items() if g in grams)
        best = max(range(len(windows)), key=lambda i: overlap(window_grams[i]))
        if overlap(window_grams[best]) / sum(weight.values()) < MIN_SCORE:
            return None
        return segments[max(windows[best], key=lambda n: overlap(grams[n]))]["start"]  # 구간 안에서 가장 잘 맞는 말

    linked = []
    for summary in summaries:
        sections = [{**s, "times": [(word_time if s["name"] == "어휘" else sentence_time)(item) for item in s["items"]]}
                    for s in summary["sections"]]
        word_times = {item: t for s in sections if s["name"] == "어휘" for item, t in zip(s["items"], s["times"])}
        # 어휘 문제의 해설은 어휘 항목과 같은 글이라 그 시간을 씁니다.
        quiz = [{**q, "time": word_times.get(q["explanation"])} if "choices" in q else q for q in summary["quiz"]]
        linked.append({**summary, "sections": sections, "quiz": quiz})
    return linked
