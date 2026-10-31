"""서버 설정(환경 변수·열쇠 파일) 확인. 서버(academy.server)와 설정 점검(academy.check)이 함께 씁니다."""

import re
from collections.abc import Mapping
from pathlib import Path

from academy.entry import MIN_SECRET_LEN


def entry_settings(env: Mapping[str, str]) -> tuple[str, str]:
    """(입장 링크 비밀 키, 학원 사이트 주소). 복사하다 붙은 앞뒤 공백은 지웁니다."""
    secret = env.get("ENTRY_SECRET", "").strip()
    # "1"뿐 아니라 "true"·"yes"도 켜진 것으로 봅니다. 꺼진 것으로 잘못 읽으면 인터넷에 그대로 열리기 때문입니다.
    if env.get("REQUIRE_ENTRY", "").strip() not in ("", "0") and len(secret) < MIN_SECRET_LEN:
        raise SystemExit(f"ENTRY_SECRET(입장 링크 비밀 키)가 없거나 {MIN_SECRET_LEN}자보다 짧아서 서버를 시작하지 않습니다.")
    if 0 < len(secret) < MIN_SECRET_LEN:  # 짧은 키는 쉽게 풀려서 넣었다면 언제나 막습니다
        raise SystemExit(f"ENTRY_SECRET(입장 링크 비밀 키)가 {MIN_SECRET_LEN}자보다 짧아서 서버를 시작하지 않습니다.")
    site_url = env.get("SITE_URL", "").strip()
    # 입장이 막힌 화면의 "학원 사이트로 가기" 링크가 되므로 웹 주소만 받습니다.
    if site_url and not re.match(r"https?://", site_url, re.I):
        raise SystemExit(f"SITE_URL은 https:// 로 시작하는 학원 사이트 주소여야 합니다 (지금 값: {site_url})")
    return secret, site_url


def teacher_key(path):
    """선생님 열쇠 파일(TEACHER_KEY_FILE)의 글. 파일이 없거나 비었으면 None: 아무도 '이번 주 강의' 등을 바꿀 수 없습니다."""
    try:
        key = Path(path).read_text(encoding="utf-8-sig").strip() or None if path else None  # -sig: 메모장이 붙이는 BOM을 뺌
    except OSError:
        return None
    if key and not all(" " <= c <= "~" for c in key):  # 브라우저는 머리글(X-Teacher-Key)에 한글 등을 보내지 못합니다
        raise SystemExit(f"선생님 열쇠는 영문·숫자·기호로만 정해 주세요(한글은 쓸 수 없음): {path}")
    return key
