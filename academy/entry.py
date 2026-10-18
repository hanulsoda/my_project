"""학원 사이트의 입장 링크와 통과 쿠키를 서명하고 확인합니다.

입장 링크: /enter?exp=<만료 유닉스 초>&sig=HMAC-SHA256(비밀 키, "enter:<exp>")
통과 쿠키: "<만료>.<HMAC-SHA256(비밀 키, "pass:<만료>")>"
"""

import hashlib
import hmac

ENTER_TTL = 300        # 입장 링크 유효 시간 (5분)
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
    return hmac.compare_digest(sign(secret, f"{prefix}:{expiry}"), sig)


def entry_link_ok(secret: str, exp: str | None, sig: str | None, now: float) -> bool:
    return _valid(secret, "enter", exp, sig, now)


def make_pass(secret: str, now: float) -> str:
    expiry = int(now) + PASS_TTL
    return f"{expiry}.{sign(secret, f'pass:{expiry}')}"


def pass_ok(secret: str, value: str | None, now: float) -> bool:
    expiry, _, sig = (value or "").partition(".")
    return _valid(secret, "pass", expiry, sig, now)
