"""서버 설정(환경 변수·열쇠 파일) 확인. 서버(academy.server)와 설정 점검(academy.check)이 함께 씁니다."""

import logging
import os
import re
from collections.abc import Mapping
from pathlib import Path

from academy.entry import MIN_SECRET_LEN


ENV_FILE = "~/.config/academy/academy.env"


def load_env_file(env=os.environ):
    """설정 파일(ACADEMY_ENV, 없으면 ~/.config/academy/academy.env)의 '이름=값' 줄을 env에 채우고 그 파일을 돌려줍니다.

    서버·밤 작업(cron)·설정 점검이 같은 파일을 읽어, 예약 줄마다 설정을 옮겨 적다 빠뜨리지 않게 합니다.
    명령 앞에 적은 값이 이깁니다. # 줄과 값 뒤에 띄어 쓴 # 설명, 'export ', 값을 감싼 따옴표는 빼고, ~로 시작하는 값은 집 폴더로 풉니다.
    기본 파일이 없으면 None."""
    named = env.get("ACADEMY_ENV", "").strip()
    path = Path(named or ENV_FILE).expanduser()
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except FileNotFoundError:
        if named:
            raise SystemExit(f"설정 파일이 없습니다: {path} (ACADEMY_ENV 경로 확인)")
        return None
    except (OSError, UnicodeDecodeError) as e:
        raise SystemExit(f"설정 파일을 읽지 못했습니다: {path} ({e}). UTF-8로 저장했는지, 읽기 권한이 있는지 확인하세요")
    found = {}  # 같은 이름이 또 나오면 셸에서 읽을 때처럼 나중 줄(README의 '>>' 명령을 다시 돌려 고친 키)
    for n, line in enumerate(lines, 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, equals, value = line.removeprefix("export ").partition("=")
        name, value = name.strip(), value.strip()
        if not equals or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            raise SystemExit(f"설정 파일 {path}의 {n}번째 줄을 읽지 못했습니다. '이름=값'으로 적어 주세요: {line[:40]}")
        if value[:1] in ("'", '"') and (close := value.find(value[0], 1)) > 0:
            value = value[1:close]  # 따옴표 뒤의 설명(# …)은 뺍니다
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0]  # 'LOG_DIR=/logs  # 로그 폴더': 띄어 쓴 # 뒤는 설명
        found[name] = os.path.expanduser(value) if value.startswith("~") else value  # 셸처럼 ~는 집 폴더
    for name, value in found.items():
        env.setdefault(name, value)
    return path


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
    if not path:
        return None
    try:  # ~: 따옴표 안에 적어 셸이 풀어 주지 않은 집 폴더. -sig: 메모장이 붙이는 BOM을 뺌
        key = Path(path).expanduser().read_text(encoding="utf-8-sig").strip() or None
    except OSError as e:  # 경로가 틀리면 열쇠가 늘 '맞지 않습니다'로 나오므로 서버 기록에 남깁니다
        logging.warning("선생님 열쇠 파일을 읽지 못해 열쇠 없이 켭니다(TEACHER_KEY_FILE 경로 확인): %s (%s)", path, e.strerror)
        return None
    except UnicodeDecodeError:  # 메모장에서 '유니코드(UTF-16)'로 저장함
        raise SystemExit(f"선생님 열쇠 파일을 UTF-8로 저장해 주세요(메모장: 다른 이름으로 저장 › 인코딩 UTF-8): {path}") from None
    if key and not all(" " <= c <= "~" for c in key):  # 브라우저는 머리글(X-Teacher-Key)에 한글 등을 보내지 못합니다
        raise SystemExit(f"선생님 열쇠는 영문·숫자·기호로만 정해 주세요(한글은 쓸 수 없음): {path}")
    return key
