import os

import academy.settings

# 테스트는 이 컴퓨터의 학원 설정 파일(~/.config/academy/academy.env)을 읽지 않습니다: 실제 영상 폴더·열쇠가 섞이지 않게.
academy.settings.ENV_FILE = os.path.join(os.path.dirname(__file__), "no-such-academy.env")
os.environ.pop("ACADEMY_ENV", None)
