"""요점노트·시험대비문제 시험에 쓰는 가짜 항목(가짜 지문입니다. 실제 교재 내용이 아닙니다)."""


def make_entry(**overrides) -> dict:
    """올바른 항목 하나를 새로 만들어 돌려줍니다(호출마다 새 사전). 최상위 키는 덮어쓸 수 있습니다."""
    entry = {
        "id": "midaen-4-2", "unit": "4-2", "unit_title": "가짜 단원 제목입니다",
        "works": ["가짜작품"], "scope": ["미래엔"],
        "notes": {"unit": "가짜 단원", "sub": "가짜 부제", "goals": ["가짜 목표입니다"],
                  "blocks": [{"t": "big", "title": "가짜 큰 제목",
                              "blocks": [{"t": "def", "text": "가짜 <b>뜻풀이</b>입니다"}]}],
                  "words": [{"w": "가짜말", "def": "가짜 뜻풀이입니다"}]},
        "quiz": {
            "passages": [{"label": "가", "title": "가짜 지문 제목", "source": "가짜 출처", "paras": ["가짜 문단입니다."]}],
            "mc": [{"q": f"가짜 객관식 {n}번 질문입니다", "choices": [f"가짜 보기 {c}" for c in range(1, 6)],
                    "answer": n % 5, "exp": "가짜 해설입니다"} for n in range(10)],
            "sub": [{"q": f"가짜 주관식 {n}번 질문입니다", "model": "가짜 모범 답안입니다", "note": "가짜 참고입니다"} for n in range(5)],
            "ox": [{"q": f"가짜 OX {n}번 질문입니다", "answer": n % 2 == 0, "exp": "가짜 해설입니다"} for n in range(10)],
            "short": [{"q": f"가짜 단답형 {n}번 질문입니다", "answer": "가짜답", "alts": ["가짜 다른 답"], "exp": "가짜 해설입니다"}
                      for n in range(10)],
        },
    }
    entry.update(overrides)
    return entry
