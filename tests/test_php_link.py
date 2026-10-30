import os
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from academy.server import create_app

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SECRET = "s" * 32


@pytest.mark.skipif(shutil.which("php") is None, reason="php가 설치되어 있지 않음")
def test_php_link_is_accepted_by_player(tmp_path):
    php = ("require 'deploy/study_player_link.php'; "
           "echo study_player_link('https://study.example.com/', getenv('S'));")
    result = subprocess.run(["php", "-r", php], cwd=PROJECT_ROOT, capture_output=True, text=True,
                            env={**os.environ, "S": SECRET + "\n"})  # 복사하다 줄바꿈이 붙은 비밀 키
    link = result.stdout.strip()

    assert link.startswith("https://study.example.com/enter?"), result.stderr
    client = TestClient(create_app(tmp_path, tmp_path / "data", lambda *a: "", entry_secret=SECRET),
                        follow_redirects=False)
    assert client.get("/enter?" + link.split("?", 1)[1]).status_code == 303
