import hashlib
import hmac

import pytest

from academy.entry import entry_link_ok, make_pass, pass_ok, sign

SECRET = "s" * 32
NOW = 1_800_000_000


def hmac_hex(message: str, secret: str = SECRET) -> str:
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def test_sign_is_hmac_sha256_hex():
    assert sign(SECRET, "enter:1") == hmac.new(SECRET.encode(), b"enter:1", hashlib.sha256).hexdigest()


@pytest.mark.parametrize("exp, sig, expected", [
    (str(NOW + 300), hmac_hex(f"enter:{NOW + 300}"), True),
    (str(NOW - 1), hmac_hex(f"enter:{NOW - 1}"), False),  # 만료
    (str(NOW + 300), hmac_hex(f"enter:{NOW + 300}", "x" * 32), False),  # 다른 키로 서명
    (str(NOW + 300), None, False),
    (None, hmac_hex(f"enter:{NOW + 300}"), False),
    ("abc", hmac_hex("enter:abc"), False),
    ("1e9", hmac_hex("enter:1e9"), False),
    ("", hmac_hex("enter:"), False),
    (str(NOW + 300), "한글", False),  # 주소창에서 바뀐 서명
    (str(NOW + 600), hmac_hex(f"enter:{NOW + 600}"), True),  # 학원 사이트 시계가 5분 빨라도 됨
    (str(NOW + 601), hmac_hex(f"enter:{NOW + 601}"), False),  # 너무 먼 미래 (새어 나간 비밀 키로 만든 오래가는 링크)
    ("4102444800", hmac_hex("enter:4102444800"), False),  # 2100년까지 쓰는 링크
], ids=["valid", "expired", "wrong-key", "no-sig", "no-exp", "not-number", "float-like", "empty", "non-ascii-sig",
        "clock-5min-ahead", "too-far", "year-2100"])
def test_entry_link_accepts_valid_and_rejects_bad(exp, sig, expected):
    assert entry_link_ok(SECRET, exp, sig, NOW) is expected


def test_pass_round_trip_and_expiry():
    value = make_pass(SECRET, NOW)

    assert pass_ok(SECRET, value, NOW + 43199) is True
    assert pass_ok(SECRET, value, NOW + 43201) is False
    assert pass_ok("x" * 32, value, NOW) is False


@pytest.mark.parametrize("value", [None, "", "abc", "x.y", "123.", ".abc", "9999999999.\xe9\xe9"])
def test_pass_rejects_malformed(value):
    assert pass_ok(SECRET, value, NOW) is False
