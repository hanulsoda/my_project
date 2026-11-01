"""학원 사이트의 입장 링크와 통과 쿠키를 서명하고 확인합니다.

입장 링크: /enter?exp=<만료 유닉스 초>&sig=HMAC-SHA256(비밀 키, "enter:<exp>")
통과 쿠키: "<만료>.<HMAC-SHA256(비밀 키, "pass:<만료>")>"
"""

import hashlib
import hmac

ENTER_TTL = 300        # 입장 링크 유효 시간 (5분)
CLOCK_SKEW = 300       # 학원 사이트 서버 시계가 이만큼 빨라도 받아 줍니다
PASS_TTL = 43200       # 통과 쿠키 유효 시간 (12시간)
MIN_SECRET_LEN = 32


def sign(secret: str, message: str) -> str:
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def _valid(secret: str, prefix: str, expiry: str | None, sig: str | None, now: float) -> bool:
    if not expiry or not sig:
        return False
    try:
        if int(expiry) < now:
            return False
    except ValueError:
        return False
    # 바이트로 비교: 문자열 비교는 한글 같은 문자가 섞이면 예외를 내서 500 오류가 납니다.
    return hmac.compare_digest(sign(secret, f"{prefix}:{expiry}").encode(), sig.encode())


def entry_link_ok(secret: str, exp: str | None, sig: str | None, now: float) -> bool:
    return entry_link_problem(secret, exp, sig, now) is None


def entry_link_problem(secret: str, exp: str | None, sig: str | None, now: float) -> str | None:
    """입장 링크를 받지 않는 까닭(서버 기록용). 받으면 None."""
    if not exp or not sig or not exp.isdigit():
        return "링크에 입장 정보가 없음"
    if not hmac.compare_digest(sign(secret, f"enter:{exp}").encode(), sig.encode()):
        return "서명이 맞지 않음(학원 사이트와 서버의 비밀 키 ENTRY_SECRET이 같은지 확인)"
    if int(exp) < now:
        return f"만료된 링크(학원 사이트 서버 시계와 {int(now) - int(exp) + ENTER_TTL}초 차이일 수 있음)"
    # 만료가 너무 먼 링크는 거절합니다. 비밀 키가 새어 나가도 몇 년씩 쓰는 링크를 만들어 돌릴 수 없게.
    if int(exp) - now > ENTER_TTL + CLOCK_SKEW:
        return f"만료가 너무 먼 링크(학원 사이트 서버 시계가 {int(int(exp) - now - ENTER_TTL)}초 빠를 수 있음)"
    return None


def make_pass(secret: str, now: float) -> str:
    expiry = int(now) + PASS_TTL
    return f"{expiry}.{sign(secret, f'pass:{expiry}')}"


def pass_ok(secret: str, value: str | None, now: float) -> bool:
    expiry, _, sig = (value or "").partition(".")
    return _valid(secret, "pass", expiry, sig, now)
