import hashlib
import hmac
import time

import pytest
from fastapi.testclient import TestClient

from academy.library import find_videos, save_frame
from academy.server import create_app, entry_settings

SECRET = "s" * 32


def hmac_hex(message: str, secret: str = SECRET) -> str:
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def entry_query(exp: int, secret: str = SECRET) -> str:
    return f"exp={exp}&sig={hmac_hex(f'enter:{exp}', secret)}"


@pytest.fixture
def make_client(tmp_path):
    video_dir = tmp_path / "videos"
    video_dir.mkdir()
    (video_dir / "1강.mp4").write_bytes(b"x" * 100)
    video_id = find_videos(video_dir)[0]["id"]

    def make(entry_secret=SECRET, site_url=""):
        app = create_app(video_dir, tmp_path / "data", lambda *a: "답", entry_secret, site_url)
        return TestClient(app, follow_redirects=False), video_id

    return make


def test_valid_link_sets_pass_and_redirects_home(make_client):
    client, _ = make_client()

    res = client.get(f"/enter?{entry_query(int(time.time()) + 300)}")

    assert res.status_code in (302, 303)
    assert res.headers["location"] == "/"
    assert "study_pass" in res.cookies
    assert client.get("/api/videos").status_code == 200  # TestClient가 받은 쿠키를 다시 보냄


@pytest.mark.parametrize("scheme", ["http", "https"])
def test_pass_cookie_is_httponly_lax_and_secure_over_https(make_client, scheme):
    client = TestClient(make_client()[0].app, base_url=f"{scheme}://testserver", follow_redirects=False)

    cookie = client.get(f"/enter?{entry_query(int(time.time()) + 300)}").headers["set-cookie"].lower()

    assert "httponly" in cookie and "samesite=lax" in cookie and "max-age=43200" in cookie
    assert ("secure" in cookie) == (scheme == "https")


def test_bad_link_shows_login_notice(make_client):
    client, _ = make_client(site_url="https://example.com")

    res = client.get(f"/enter?{entry_query(int(time.time()) + 300, 'x' * 32)}")

    assert res.status_code == 401
    assert "학원 사이트에 로그인" in res.text
    assert "https://example.com" in res.text
    assert "study_pass" not in res.cookies


def test_without_pass_everything_is_blocked(make_client):
    client, video_id = make_client()

    page = client.get("/")
    api = client.get("/api/videos")
    media = client.get(f"/media/{video_id}")

    assert page.status_code == 401 and "학원 사이트에 로그인" in page.text
    assert api.status_code == 401 and api.headers["content-type"].startswith("application/json")
    assert media.status_code == 401
    assert client.get(f"/api/videos/{video_id}/subtitles.vtt").status_code == 401


def test_board_photo_needs_pass(make_client, tmp_path):
    client, video_id = make_client()
    save_frame(tmp_path / "data", video_id, 60, b"\xff\xd8x")

    assert client.get(f"/frames/{video_id}/60.jpg").status_code == 401


def test_forged_or_expired_pass_is_blocked(make_client):
    client, _ = make_client()
    past = int(time.time()) - 1

    client.cookies.set("study_pass", "9999999999.deadbeef")
    forged = client.get("/api/videos")
    client.cookies.set("study_pass", f"{past}.{hmac_hex(f'pass:{past}')}")
    expired = client.get("/api/videos")

    assert forged.status_code == 401
    assert expired.status_code == 401


def test_no_secret_keeps_app_open(make_client):
    client, _ = make_client(entry_secret="")

    assert client.get("/api/videos").status_code == 200
    assert client.get("/enter").headers["location"] == "/"


def test_entry_settings_reads_and_trims():
    assert entry_settings({}) == ("", "")
    assert entry_settings({"ENTRY_SECRET": " " + SECRET + "\n", "SITE_URL": "https://example.com"}) \
        == (SECRET, "https://example.com")
    assert entry_settings({"REQUIRE_ENTRY": "0"}) == ("", "")


@pytest.mark.parametrize("flag", ["1", "true", "yes"])
@pytest.mark.parametrize("secret", ["", "s" * 31])
def test_required_entry_refuses_missing_or_short_secret(flag, secret):
    with pytest.raises(SystemExit):
        entry_settings({"REQUIRE_ENTRY": flag, "ENTRY_SECRET": secret})


def test_non_ascii_pass_cookie_is_blocked_not_crashing(make_client):
    client, _ = make_client()

    res = client.get("/api/videos", headers={b"cookie": b"study_pass=9999999999.\xe9\xe9"})

    assert res.status_code == 401
