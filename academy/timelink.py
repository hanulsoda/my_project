"""학원 요점 정리 항목이 강의의 언제 나오는지 받아쓰기 대본에서 찾습니다(Claude 없이).

시험해 보니 화면 글자는 정리 프린트처럼 모든 항목이 한 화면에 오래 떠 있어 오히려 틀려서 대본만 씁니다.
"""

import math
import re
from collections import Counter

WINDOW = 180  # 3분 구간을 1분 30초씩 옮겨 가며 봅니다
MIN_SCORE = 0.3  # 항목 글자 조각이 이만큼 겹쳐야 시간을 붙입니다(시험에서 Claude 챕터와 82% 일치)


def _norm(text):
    return re.sub(r"[^가-힣a-zA-Z0-9]", "", text)


def _grams(text):
    t = _norm(text)
    return {t[i:i + 3] for i in range(len(t) - 2)}


def link_times(summaries, segments) -> list[dict]:
    """학원 정리 [{"source", "sections", "quiz"}]에 시간을 붙인 사본을 돌려줍니다.

    sections마다 items와 나란한 "times"(초 또는 None), 어휘 퀴즈에는 그 낱말의 "time"을 붙입니다.
    """
    end = max((s["end"] for s in segments), default=0)
    windows = [(t, [s for s in segments if s["start"] < t + WINDOW and s["end"] > t])
               for t in range(0, math.ceil(end), WINDOW // 2)]
    window_grams = [set().union(*(_grams(s["text"]) for s in said)) for _, said in windows]
    df = Counter(g for grams in window_grams for g in grams)

    def word_time(item):
        term = _norm(item.split("(")[0])
        return next((s["start"] for s in segments if len(term) >= 2 and term in _norm(s["text"])), None)

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
        return max(windows[best][1], key=lambda s: overlap(_grams(s["text"])))["start"]  # 구간 안에서 가장 잘 맞는 말

    linked = []
    for summary in summaries:
        sections = [{**s, "times": [(word_time if s["name"] == "어휘" else sentence_time)(item) for item in s["items"]]}
                    for s in summary["sections"]]
        word_times = {item: t for s in sections if s["name"] == "어휘" for item, t in zip(s["items"], s["times"])}
        # 어휘 문제의 해설은 어휘 항목과 같은 글이라 그 시간을 씁니다.
        quiz = [{**q, "time": word_times.get(q["explanation"])} if "choices" in q else q for q in summary["quiz"]]
        linked.append({**summary, "sections": sections, "quiz": quiz})
    return linked
