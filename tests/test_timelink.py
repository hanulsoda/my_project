import copy

from academy.timelink import link_times

FILLER = "자 그러면 다음 내용을 한번 볼까요 여기 보면"
SEGMENTS = [
    {"start": 0.0, "end": 5.0, "text": "오늘은 노새 두 마리를 공부합니다"},
    {"start": 120.0, "end": 125.0, "text": FILLER},
    {"start": 250.0, "end": 255.0, "text": FILLER},
    {"start": 400.0, "end": 405.0, "text": "잠방이 입은 아버지가 연탄을 싣고 비탈길을 오른다"},
    {"start": 500.0, "end": 505.0, "text": FILLER},
    {"start": 600.0, "end": 605.0, "text": "아버지가 노새를 찾아 헤매다 결국 자신이 노새가 된다"},
]


def summary():
    return [{"source": "고1 「노새 두 마리」",
             "sections": [{"name": "핵심 특징", "items": ["아버지가 노새를 찾아 헤매다 노새가 됨",
                                                       "근대화에서 소외된 도시 빈민의 삶"]},
                          {"name": "어휘", "items": ["잠방이(명사): 짧은 홑바지", "포효하다(동사): 사나운 짐승이 울부짖다"]}],
             "quiz": [{"question": "‘잠방이’의 뜻으로 알맞은 것은?", "choices": ["짧은 홑바지", "가", "나", "다"],
                       "answer": 0, "explanation": "잠방이(명사): 짧은 홑바지"},
                      {"question": "‘포효하다’의 뜻으로 알맞은 것은?", "choices": ["사나운 짐승이 울부짖다", "가", "나", "다"],
                       "answer": 0, "explanation": "포효하다(동사): 사나운 짐승이 울부짖다"},
                      {"context": "지문", "parts": ["", "답", ""]}]}]


def test_words_link_to_where_they_are_first_spoken():
    sections = link_times(summary(), SEGMENTS)[0]["sections"]

    assert sections[1]["times"] == [400.0, None]  # 강의에서 말하지 않은 낱말은 시간이 없습니다


def test_sentences_link_to_the_best_matching_part_of_the_lecture_only_when_it_matches_well():
    sections = link_times(summary(), SEGMENTS)[0]["sections"]

    assert sections[0]["times"] == [600.0, None]


def test_vocabulary_questions_get_the_time_of_their_word():
    quiz = link_times(summary(), SEGMENTS)[0]["quiz"]

    assert [q.get("time") for q in quiz] == [400.0, None, None]


def test_the_summaries_given_are_left_unchanged():
    given = summary()

    link_times(given, SEGMENTS)

    assert given == summary()  # 서버가 기억해 둔 정리를 바꾸지 않습니다
    assert link_times(copy.deepcopy(given), [])[0]["sections"][0]["times"] == [None, None]  # 대본이 없을 때


def test_a_word_without_a_part_of_speech_still_gets_its_time():
    from academy.references import reference_sections
    ref = {"title": "t", "grade": "고1", "words": [{"w": "울안", "def": "울타리를 둘러친 안"}]}
    summaries = [{"source": "s", "sections": reference_sections(ref), "quiz": []}]
    segments = [{"start": 0.0, "end": 9.0, "text": "오늘은 처음 시작합니다"},
                {"start": 42.0, "end": 50.0, "text": "울안은 울타리를 둘러친 안을 말해요"}]

    assert link_times(summaries, segments)[0]["sections"][0]["times"] == [42.0]
