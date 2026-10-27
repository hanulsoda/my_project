import json
from datetime import datetime

from academy.library import find_videos, load_analysis, save_analysis
from academy.toc import MODEL, add_tocs, make_toc

SEGMENTS = [{"start": 0.0, "end": 5.0, "text": "오늘은 꺼삐딴 리를 봅니다"},
            {"start": 65.0, "end": 70.0, "text": "회중시계가 중요해요"}]


def answer(*chapters):
    return lambda prompt, schema: json.dumps({"chapters": [{"start": s, "title": t} for s, t in chapters]})


def test_keeps_only_chapters_in_order_inside_the_lecture():
    ask = answer(("[00:05]", "인물 소개"), ("[02:30]", "회중시계의 상징"), ("01:00", "앞으로 돌아간 시간"),
                 ("02:50", "1분도 안 지난 챕터"), ("05:00", ""), ("10:00", "석방과 재회"), ("99:00", "영상 밖"))

    assert make_toc(SEGMENTS, 900.0, ask) == [
        {"start": 5.0, "title": "인물 소개"}, {"start": 150.0, "title": "회중시계의 상징"},
        {"start": 600.0, "title": "석방과 재회"}]


def test_no_toc_from_a_broken_or_too_short_answer():
    assert make_toc(SEGMENTS, 900.0, lambda prompt, schema: "목차입니다") is None
    assert make_toc(SEGMENTS, 900.0, answer(("00:05", "하나뿐인 챕터"))) is None


def test_the_model_reads_the_transcript_with_times():
    prompts = []

    make_toc(SEGMENTS, 900.0, lambda prompt, schema: prompts.append(prompt) or "{}")

    assert "[00:00] 오늘은 꺼삐딴 리를 봅니다\n[01:05] 회중시계가 중요해요" in prompts[0]


def test_long_lectures_are_asked_in_20_minute_parts_and_joined_in_order():
    # 시험에서 40분 넘는 강의는 통째로 물으면 챕터 자리가 크게 틀리고, 20분씩 물으면 잘 맞았습니다.
    # 다만 챕터가 너무 잘게 나뉘어(Claude의 두 배) 앞 챕터와 2분 안에 붙은 챕터는 뺍니다.
    segments = [{"start": float(t), "end": t + 5.0, "text": f"{t}초 설명"} for t in range(0, 3000, 300)]
    replies = iter([answer(("00:00", "도입"), ("19:40", "마무리")),
                    answer(("19:30", "조각 앞"), ("20:20", "앞 챕터와 1분 안"), ("21:30", "앞 챕터와 2분 안"), ("30:00", "위기")),
                    answer(("40:10", "결말"), ("99:00", "영상 밖"))])
    prompts = []

    def ask(prompt, schema):
        prompts.append(prompt)
        return next(replies)(prompt, schema)

    assert make_toc(segments, 3000.0, ask) == [
        {"start": 0.0, "title": "도입"}, {"start": 1180.0, "title": "마무리"},
        {"start": 1800.0, "title": "위기"}, {"start": 2410.0, "title": "결말"}]
    assert len(prompts) == 3
    assert "[20:00] 1200초 설명" in prompts[1] and "[15:00]" not in prompts[1]  # 조각마다 그 20분의 대본만


def lectures(tmp_path):
    video_dir, data_dir = tmp_path / "videos", tmp_path / "data"
    video_dir.mkdir()
    cases = {"1강": {}, "2강": {"guide": {"summary": "요약", "chapters": [], "quiz": []}}, "3강": {"duration": 3000.0},
             "제망매가": {}, "5강": {"toc": {"model": MODEL, "chapters": []}}, "6강": {}}
    for name in cases:
        (video_dir / f"{name}.mp4").write_bytes(b"x")
    ids = {v["title"]: v["id"] for v in find_videos(video_dir)}
    for name, extra in cases.items():
        save_analysis(data_dir, ids[name], {"title": name, "duration": 900.0, "segments": SEGMENTS, **extra})
    return video_dir, data_dir, ids


def test_adds_a_toc_to_every_lecture_without_a_claude_guide(tmp_path):
    video_dir, data_dir, ids = lectures(tmp_path)
    asked = []

    def ask(prompt, schema):
        asked.append(prompt)
        return answer(("00:05", "도입"), ("05:00", "전개"))(prompt, schema)

    add_tocs(video_dir, data_dir, ask, has_summary=lambda title: title == "제망매가")

    toc = lambda name: (load_analysis(data_dir, ids[name]) or {}).get("toc")
    assert toc("1강") == {"model": MODEL, "chapters": [{"start": 5.0, "title": "도입"}, {"start": 300.0, "title": "전개"}]}
    # 50분짜리 3강도, 학원 정리가 있는 제망매가도 만듭니다(학원 정리에는 챕터가 없어서).
    assert toc("6강")["chapters"] and toc("3강")["chapters"] and toc("제망매가")["chapters"]
    assert toc("2강") is None  # Claude 요점 정리에는 챕터가 있음
    # 1강·6강·제망매가 한 번씩, 3강은 20분 조각 중 대본이 있는 첫 조각만 묻고, 이미 해 본 5강은 다시 묻지 않습니다.
    assert len(asked) == 4


def test_lectures_without_an_academy_summary_come_first(tmp_path):
    video_dir, data_dir, ids = lectures(tmp_path)
    clock = iter([datetime(2026, 10, 22, 1, 0)] + [datetime(2026, 10, 22, 2, 0)] * 3 + [datetime(2026, 10, 22, 7, 1)])

    add_tocs(video_dir, data_dir, answer(("00:05", "도입"), ("05:00", "전개")),
             has_summary=lambda title: title == "1강", until="07:00", now=lambda: next(clock))

    toc = lambda name: (load_analysis(data_dir, ids[name]) or {}).get("toc")
    # 학원 정리가 없는 3강·6강·제망매가를 먼저 하고, 학원 정리가 있는 1강은 맨 뒤라 아침이 되어 남았습니다.
    assert [bool(toc(n)) for n in ["3강", "6강", "제망매가", "1강"]] == [True, True, True, False]


def test_stops_starting_lectures_at_the_morning_time(tmp_path):
    video_dir, data_dir, ids = lectures(tmp_path)
    clock = iter([datetime(2026, 10, 22, 22, 0), datetime(2026, 10, 22, 23, 0), datetime(2026, 10, 23, 7, 1)])

    failures, finished = add_tocs(video_dir, data_dir, answer(("00:05", "도입"), ("05:00", "전개")),
                                  has_summary=lambda title: False, until="07:00", now=lambda: next(clock))

    assert (failures, finished) == (0, False)
    assert load_analysis(data_dir, ids["1강"])["toc"]["chapters"]
    assert "toc" not in load_analysis(data_dir, ids["6강"])  # 아침 7시가 지나 시작하지 않았습니다


def test_remembers_unusable_answers_and_counts_failures(tmp_path):
    video_dir, data_dir, ids = lectures(tmp_path)

    def ask(prompt, schema):
        if not hasattr(ask, "called"):
            ask.called = True
            raise ConnectionError("ollama가 응답하지 않음")
        return "쓸 수 없는 답"

    failures, finished = add_tocs(video_dir, data_dir, ask, has_summary=lambda title: False)

    assert (failures, finished) == (1, True)
    assert "toc" not in load_analysis(data_dir, ids["1강"])  # 실패한 강의는 다음에 다시 시도합니다
    assert load_analysis(data_dir, ids["6강"])["toc"] == {"model": MODEL, "chapters": []}  # 매일 밤 다시 묻지 않습니다
