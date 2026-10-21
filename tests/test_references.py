from academy.references import find_references, reference_text

POEM = {"title": "1-1.(2)성난 풀잎", "grade": "고2", "meta": {"갈래": "현대 수필", "주제": "자연의 순리"},
        "features": [{"num": "①", "text": "도덕경을 인용함"}],
        "stages": [{"label": "전개", "bullets": ["풀독이 오름", "고추밭"]}],
        "fillins": [{"no": "Q1", "passage": "글쓴이가 깨달은 것은?", "answer_line": "자연의 순리"}],
        "words": [{"w": "울안", "pos": "명사", "def": "울타리를 둘러친 안"}]}
SAME_WORK_OTHER_GRADE = {**POEM, "grade": "중3"}
SHORT = {"title": "눈", "grade": "고1", "meta": {"갈래": "시"}}
GRAMMAR = {"title": "4-1.음운의 변동", "grade": "고1", "meta": {"갈래": "시"}}


def test_matches_work_titles_in_the_video_file_name_and_prefers_the_folder_grade():
    refs = [SAME_WORK_OTHER_GRADE, POEM, GRAMMAR]

    found = find_references("고2출판사별/지학사/[이해완성] 1-1.(2)성난 풀잎 요점정리", [], refs)

    assert [r["source"] for r in found] == ["고2 「성난 풀잎」"]


def test_short_titles_and_unnamed_videos_match_only_works_quoted_on_screen():
    refs = [SHORT, POEM, GRAMMAR]

    assert find_references("ebs/2019년/눈물의 바다", [], refs) == []
    found = find_references("보강/녹화_2024_01_20", ["김수영, 「눈」", "다음 시간: 음운의 변동"], refs)

    assert [r["source"] for r in found] == ["고1 「눈」"]


def test_reference_text_lists_every_part_of_the_summary():
    text = reference_text(POEM)

    for part in ["「성난 풀잎」(고2)", "갈래: 현대 수필", "도덕경을 인용함", "전개: 풀독이 오름 / 고추밭",
                 "글쓴이가 깨달은 것은? → 자연의 순리", "울안(명사): 울타리를 둘러친 안"]:
        assert part in text


def test_found_summaries_come_in_sections_for_showing_as_is():
    found = find_references("고2/성난 풀잎 강의", [], [POEM])

    assert found[0]["sections"] == [
        {"name": "개요", "items": ["갈래: 현대 수필", "주제: 자연의 순리"]},
        {"name": "핵심 특징", "items": ["도덕경을 인용함"]},
        {"name": "구조", "items": ["전개: 풀독이 오름 / 고추밭"]},
        {"name": "빈칸 문제", "items": ["글쓴이가 깨달은 것은? → 자연의 순리"]},
        {"name": "어휘", "items": ["울안(명사): 울타리를 둘러친 안"]},
    ]


def test_a_work_whose_name_is_part_of_another_matched_work_is_dropped():
    longer = {"title": "관점과 형식을 비교하며 읽기", "grade": "중3", "meta": {"갈래": "시"}}
    shorter = {"title": "비교하며 읽기", "grade": "중3", "meta": {"갈래": "시"}}

    found = find_references("중등부/천재(박)/관점과 형식을 비교하며 읽기 요점정리", [], [shorter, longer])

    assert [r["source"] for r in found] == ["중3 「관점과 형식을 비교하며 읽기」"]


def test_school_level_in_the_folder_picks_the_matching_grade_when_no_grade_number():
    high = {"title": "동백꽃", "grade": "고1", "meta": {"갈래": "시"}}
    middle = {"title": "동백꽃", "grade": "중2", "meta": {"갈래": "시"}}

    found = find_references("중등부/천재(노)/1단원 동백꽃 정리", [], [high, middle])

    assert [r["source"] for r in found] == ["중2 「동백꽃」"]


def test_summaries_with_only_a_title_are_not_used():
    empty = {"title": "공감하며 소통하기", "grade": "고1", "meta": {}, "features": [], "stages": []}

    assert find_references("2022개정/고1/공감하며 소통하기", [], [empty]) == []
