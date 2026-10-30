from academy.references import find_references, ref_key, reference_quiz, reference_sections, reference_text, suspects

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


def test_summaries_are_cleaned_of_pdf_extraction_leftovers():
    messy = {"title": "노새 두 마리", "grade": "고1", "meta": {"갈래": "단편 \n소설"},
             "features": [{"text": "평소에 \n말수가 적은 아버지"}, {"text": "평소에 말수가 적은 아버지"},
                          {"text": "1인칭 관찰자 시점\n\n1-2.노새 두 마리\nI410-UCI(KEPA)201"},
                          {"text": "인물이 왜 그랬는\n지\x01 생각해 봄"}],
             "stages": [{"label": "전개", "bullets": []}, {"label": "결말", "bullets": ["노새가 된 아버지"]}]}

    assert reference_sections(messy) == [
        {"name": "개요", "items": ["갈래: 단편 소설"]},
        {"name": "핵심 특징", "items": ["평소에 말수가 적은 아버지", "1인칭 관찰자 시점", "인물이 왜 그랬는지 생각해 봄"]},
        {"name": "구조", "items": ["결말: 노새가 된 아버지"]},
    ]


def test_fill_in_questions_hide_the_blanks_marked_by_double_spaces():
    ref = {"title": "노새 두 마리", "grade": "고1", "fillins": [
        {"no": "Q1", "passage": "아버지는 연탄을 나른다.", "answer_line": "아버지의 직업은   연탄배달부  이고,   과묵한  성격이다."},
        {"no": "Q2", "passage": "이 글의 주제는?", "answer_line": "가난한 삶의 애환"}]}

    # item: 정리의 '빈칸 문제' 칸 항목(선생님이 숨기면 퀴즈에서도 뺍니다)
    assert reference_quiz(ref) == [
        {"context": "아버지는 연탄을 나른다.", "parts": ["아버지의 직업은", "연탄배달부", "이고,", "과묵한", "성격이다."],
         "item": "아버지는 연탄을 나른다. → 아버지의 직업은   연탄배달부  이고,   과묵한  성격이다."},
        {"context": "이 글의 주제는?", "parts": ["", "가난한 삶의 애환", ""],  # 빈칸 표시가 없으면 답 전체를 가립니다
         "item": "이 글의 주제는? → 가난한 삶의 애환"},
    ]
    assert [q["item"] for q in reference_quiz(ref)] == next(s for s in reference_sections(ref) if s["name"] == "빈칸 문제")["items"]


def test_fill_in_questions_repeated_in_the_summary_are_asked_once():
    same = {"no": "Q1", "passage": "평국은 규중에 홀로 있었다.", "answer_line": "평국은   여성  이다."}
    ref = {"title": "홍계월전", "grade": "고1", "fillins": [same, {**same, "no": "Q5"}]}  # PDF에서 뽑다가 두 번 들어감

    assert len(reference_quiz(ref)) == 1


def test_word_questions_ask_for_the_meaning_among_other_words_of_the_same_work():
    ref = {"title": "노새 두 마리", "grade": "고1",
           "words": [{"w": f"낱말{i}", "pos": "명사", "def": f"뜻{i}"} for i in range(5)]}

    quiz = reference_quiz(ref)

    assert len(quiz) == 5
    first = quiz[0]
    assert first["question"] == "‘낱말0’의 뜻으로 알맞은 것은?"
    assert len(set(first["choices"])) == 4 and set(first["choices"]) <= {f"뜻{i}" for i in range(5)}
    assert first["choices"][first["answer"]] == "뜻0"
    assert first["explanation"] == "낱말0(명사): 뜻0"
    assert reference_quiz(ref) == quiz  # 열 때마다 같은 문제·순서


def test_no_word_questions_when_too_few_words_to_make_four_choices():
    ref = {"title": "노새 두 마리", "grade": "고1",
           "words": [{"w": f"낱말{i}", "pos": "명사", "def": f"뜻{i}"} for i in range(3)]}

    assert reference_quiz(ref) == []


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


def test_summaries_carry_a_stable_key_and_flag_items_a_teacher_should_check():
    long = "가" * 260
    ref = {"title": "1-1.(2)성난 풀잎", "grade": "고2", "meta": {"갈래": "현대 수필"},
           "features": [{"text": long}, {"text": "짧은 특징"}],
           "stages": [{"label": "발단", "bullets": []}, {"label": "전개", "bullets": ["가", "나", "다", "라"]},
                      {"label": "결말", "bullets": []}]}

    found = find_references("고2/성난 풀잎 강의", [], [ref])

    assert found[0]["key"] == ref_key(ref) and len(ref_key(ref)) == 10
    assert ref_key(ref) != ref_key({**ref, "grade": "고1"})  # 같은 작품도 학년이 다르면 다른 정리
    # 학생에게 보이는 항목 가운데(깨진 기호·머리글 꼬리·중복·빈 단계는 이미 자동으로 정리) 선생님이 볼 만한 것
    assert suspects(ref) == {"핵심 특징": {long: "너무 긴 항목(260자)"},
                             "구조": {"전개: 가 / 나 / 다 / 라": "한 단계에 내용이 몰림(빈 단계: 발단, 결말)"}}
    assert suspects({**ref, "features": [{"text": "짧은 특징"}], "stages": []}) == {}


def test_summaries_with_only_a_title_are_not_used():
    empty = {"title": "공감하며 소통하기", "grade": "고1", "meta": {}, "features": [], "stages": []}

    assert find_references("2022개정/고1/공감하며 소통하기", [], [empty]) == []


# ---- 학원 정리 버그 찾기에서 나온 경우들 ----

def test_odd_shapes_in_the_summary_file_are_shown_as_text_or_left_out(caplog):
    from academy.references import usable_references
    odd = {"title": "운수 좋은 날", "grade": "고1", "meta": {"갈래": "단편 소설", "시점": None, "배경": ["1920년대", "서울"]},
           "features": ["인력거꾼의 하루"], "persons": ["김첨지: 인력거꾼"],
           "stages": [{"label": "발단", "bullets": None}, {"label": "", "bullets": ["비 오는 날"]}],
           "words": [{"w": "울안", "pos": "", "def": "울타리를 둘러친 안"}]}
    broken = [{"title": "관동별곡", "grade": "고1", "meta": ["가사"]},  # meta가 목록
              {"grade": "고1", "meta": {"갈래": "시"}},  # 제목 없음
              {"title": "속미인곡", "grade": "고1", "fillins": [{"passage": "임", "answer_line": 3}]},
              {"title": "사미인곡", "grade": "고1", "words": [{"w": "님", "def": ["임", "사랑하는 사람"]}]},
              "글만 있는 줄"]

    usable = usable_references([odd, *broken])

    assert usable == [odd]  # 쓸 수 없는 정리는 빼고(로그에 남김) 나머지는 그대로
    assert "건너뜀" in caplog.text
    assert reference_sections(odd) == [
        {"name": "개요", "items": ["갈래: 단편 소설", "배경: 1920년대, 서울"]},  # 비어 있는 값은 빼고 목록은 이어 씀
        {"name": "핵심 특징", "items": ["인력거꾼의 하루"]},
        {"name": "구조", "items": ["비 오는 날"]},  # 이름 없는 단계는 ': '를 붙이지 않음
        {"name": "인물", "items": ["김첨지: 인력거꾼"]},
        {"name": "어휘", "items": ["울안: 울타리를 둘러친 안"]},  # 품사가 없으면 '()'를 붙이지 않음
    ]


def test_the_same_grade_and_title_twice_keeps_the_first(caplog):
    from academy.references import usable_references
    first, second = {**POEM}, {**POEM, "meta": {"갈래": "다른 교재의 정리"}}

    assert usable_references([first, second]) == [first]  # 열쇠(학년+제목)가 같으면 선생님 고치기 화면에서 섞임
    assert "같은 학년·제목" in caplog.text


def test_word_questions_never_offer_another_meaning_of_the_same_word_or_a_near_copy():
    words = [{"w": "잠방이", "pos": "명사", "def": "가랑이가 무릎까지 오는 짧은 홑바지"},
             {"w": "잠방이", "pos": "명사", "def": "가랑이가 무릎까지 오는  짧은 홑바지."},  # PDF에서 두 번(띄어쓰기·마침표만 다름)
             {"w": "어리다", "pos": "형용사", "def": "어리석다"}, {"w": "어리다", "pos": "형용사", "def": "나이가 적다"},
             {"w": "비탈길", "pos": "명사", "def": "비탈진 언덕의 길"}, {"w": "울안", "pos": "명사", "def": "울타리를 둘러친 안"},
             {"w": "고샅", "pos": "명사", "def": "마을의 좁은 골목길"}]
    quiz = reference_quiz({"title": "노새 두 마리", "grade": "고1", "words": words})

    asked = [q["question"] for q in quiz]
    assert len(asked) == len(set(asked)) == 5  # 낱말마다 한 번
    flat = lambda text: text.replace(" ", "").rstrip(".")
    for q in quiz:
        assert len({flat(c) for c in q["choices"]}) == 4  # 화면에서 똑같아 보이는 보기 없음
    youth = next(q for q in quiz if "어리다" in q["question"])
    assert youth["choices"][youth["answer"]] == "어리석다" and "나이가 적다" not in youth["choices"]  # 다른 뜻을 오답으로 내지 않음
    vocabulary = next(s for s in reference_sections({"title": "t", "grade": "고1", "words": words}) if s["name"] == "어휘")
    assert sum("잠방이" in item for item in vocabulary["items"]) == 1  # 어휘 칸에도 한 번


def test_grade_folders_written_with_deung_pick_that_grade():
    first, second = {"title": "관동별곡", "grade": "고2", "meta": {"갈래": "가사"}}, {"title": "관동별곡", "grade": "고1", "meta": {"갈래": "가사"}}
    middle = [{"title": "동백꽃", "grade": "중1", "meta": {"갈래": "소설"}}, {"title": "동백꽃", "grade": "중3", "meta": {"갈래": "소설"}}]

    assert [r["source"] for r in find_references("고등1/관동별곡 1강", [], [first, second])] == ["고1 「관동별곡」"]
    assert [r["source"] for r in find_references("중등3/동백꽃", [], middle)] == ["중3 「동백꽃」"]
    assert [r["source"] for r in find_references("집중1강/중3/동백꽃", [], middle)] == ["중3 「동백꽃」"]  # '집중1강'은 중1이 아님


def test_long_fill_in_passages_are_not_flagged():
    ref = {"title": "노새 두 마리", "grade": "고1", "fillins": [{"passage": "가" * 300, "answer_line": "답은   노새  이다"}]}

    assert suspects(ref) == {}  # 빈칸 문제 지문은 보통 길어 '너무 긴 항목'이 아님


def test_a_blank_at_either_end_of_the_line_keeps_the_rest_visible():
    ref = {"title": "관동별곡", "grade": "고1", "fillins": [{"passage": "갈래", "answer_line": "이 작품의 갈래는   가사  "},
                                                       {"passage": "작가", "answer_line": "  정철  이 지었다"}]}

    assert [q["parts"] for q in reference_quiz(ref)] == [["이 작품의 갈래는", "가사", ""], ["", "정철", "이 지었다"]]


def test_file_names_copied_from_a_mac_still_match():
    import unicodedata
    title = unicodedata.normalize("NFD", "2022개정/고1/미래엔/3강 제망매가")  # 맥에서 NAS로 옮기면 한글이 자모로 나뉘기도 함
    ref = {"title": "제망매가", "grade": "고1", "meta": {"갈래": "향가"}}

    assert [r["source"] for r in find_references(title, [], [ref])] == ["고1 「제망매가」"]
