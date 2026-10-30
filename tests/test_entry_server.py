"""학원 사이트 입장 확인. 켜면 인터넷(학원 내부망 밖)에서 온 요청만 통과 쿠키가 있어야 합니다."""

import hashlib
import hmac
import time

import pytest
from fastapi.testclient import TestClient

from academy.library import find_videos
from academy.server import create_app, entry_settings

SECRET = "s" * 32
HOME = ("121.130.20.30", 50000)    # 집 인터넷 (공인 주소)
ACADEMY = ("192.168.0.5", 50000)   # 학원 PC (사설 주소)
PROXY = ("192.168.0.10", 50000)    # DS918+ 역방향 프록시


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

    def make(entry_secret=SECRET, site_url="", client=HOME, **kwargs):
        app = create_app(video_dir, tmp_path / "data", lambda *a: "답", entry_secret=entry_secret, site_url=site_url)
        return TestClient(app, follow_redirects=False, client=client, **kwargs), video_id

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
    client, _ = make_client(base_url=f"{scheme}://testserver")

    cookie = client.get(f"/enter?{entry_query(int(time.time()) + 300)}").headers["set-cookie"].lower()

    assert "httponly" in cookie and "samesite=lax" in cookie and "max-age=43200" in cookie
    assert ("secure" in cookie) == (scheme == "https")


def test_pass_cookie_is_secure_behind_https_proxy(make_client):
    # DS918+가 https로 받아 Z840에는 http로 넘겨도, 학생 브라우저와는 https이므로 Secure를 붙입니다.
    client, _ = make_client(client=PROXY)

    res = client.get(f"/enter?{entry_query(int(time.time()) + 300)}",
                     headers={"x-forwarded-for": HOME[0], "x-forwarded-proto": "https"})

    assert "secure" in res.headers["set-cookie"].lower()


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
    assert page.headers["x-frame-options"] == "DENY"  # 막힘 화면에도 보호 설정
    assert page.headers["x-content-type-options"] == "nosniff"
    assert api.status_code == 401 and api.headers["content-type"].startswith("application/json")
    assert media.status_code == 401
    assert client.get("/api/search?q=공식").status_code == 401
    assert client.get(f"/api/videos/{video_id}/pages/0.jpg").status_code == 401
    assert client.get("/status.html").status_code == 401


def test_forged_or_expired_pass_is_blocked(make_client):
    client, _ = make_client()
    past = int(time.time()) - 1

    client.cookies.set("study_pass", "9999999999.deadbeef")
    forged = client.get("/api/videos")
    client.cookies.set("study_pass", f"{past}.{hmac_hex(f'pass:{past}')}")
    expired = client.get("/api/videos")

    assert forged.status_code == 401
    assert expired.status_code == 401


def test_no_secret_keeps_the_academy_network_open(make_client):
    client, _ = make_client(entry_secret="", client=ACADEMY)

    assert client.get("/api/videos").status_code == 200
    assert client.get("/enter").headers["location"] == "/"


def test_academy_lan_stays_open_without_pass(make_client):
    # 학원 안에서 http://Z840:8000 으로 쓰던 방식은 입장 확인을 켜도 그대로입니다.
    client, _ = make_client(client=ACADEMY)

    assert client.get("/api/videos").status_code == 200
    assert client.get("/").status_code == 200


def test_internet_request_through_the_proxy_needs_pass(make_client):
    # 프록시가 붙인 맨 오른쪽 주소가 실제 접속 주소입니다. 그 앞의 주소는 학생이 마음대로 넣을 수 있습니다.
    client, _ = make_client(client=PROXY)

    assert client.get("/api/videos", headers={"x-forwarded-for": HOME[0]}).status_code == 401
    assert client.get("/api/videos", headers={"x-forwarded-for": f"192.168.0.7, {HOME[0]}"}).status_code == 401


def test_academy_pc_through_the_domain_stays_open(make_client):
    # 학원 안에서 https://study.학원도메인 으로 들어오면 공유기가 학원 PC 주소를 넘겨줍니다.
    client, _ = make_client(client=PROXY)

    assert client.get("/api/videos", headers={"x-forwarded-for": f"{HOME[0]}, 192.168.0.7"}).status_code == 200


def test_proxy_without_client_address_is_treated_as_outside(make_client):
    # 프록시 설정에서 X-Forwarded-For를 빠뜨려도 인터넷에 문이 열리지 않게 합니다.
    client, _ = make_client(client=PROXY)

    assert client.get("/api/videos", headers={"x-forwarded-proto": "https"}).status_code == 401


def test_without_entry_check_the_server_is_for_the_academy_only(make_client):
    # 프록시를 만들어 둔 채 ENTRY_SECRET 없이 서버를 다시 켜도 강의가 인터넷에 열리지 않게 합니다.
    home, video_id = make_client(entry_secret="")
    proxied, _ = make_client(entry_secret="", client=PROXY)

    page, api = home.get("/"), home.get("/api/videos")

    assert page.status_code == 403 and "인터넷으로는 열려 있지 않습니다" in page.text
    assert api.status_code == 403
    assert home.get(f"/media/{video_id}").status_code == 403
    assert proxied.get("/api/videos", headers={"x-forwarded-for": HOME[0]}).status_code == 403
    assert proxied.get("/api/videos", headers={"x-forwarded-proto": "https"}).status_code == 403


@pytest.mark.parametrize("address", ["192.168.0.5", "10.1.2.3", "172.16.0.9", "127.0.0.1", "100.101.102.103", "fd12::5"],
                         ids=["home-router", "10", "172", "this-pc", "vpn-tailscale", "ipv6-local"])
def test_academy_network_addresses_need_no_pass(make_client, address):
    client, _ = make_client(client=(address, 50000))

    assert client.get("/api/videos").status_code == 200


def test_records_moved_from_home_can_be_claimed_at_the_academy(make_client):
    home, _ = make_client()
    home.get(f"/enter?{entry_query(int(time.time()) + 300)}")
    academy = TestClient(home.app, client=ACADEMY)

    code = home.post("/api/transfer", json={"data": {"notes": "집에서 쓴 메모"}}).json()["code"]

    assert academy.post(f"/api/transfer/{code}").json()["data"] == {"notes": "집에서 쓴 메모"}


def test_entry_settings_reads_and_trims():
    assert entry_settings({}) == ("", "")
    assert entry_settings({"ENTRY_SECRET": " " + SECRET + "\n", "SITE_URL": "https://example.com"}) \
        == (SECRET, "https://example.com")
    assert entry_settings({"REQUIRE_ENTRY": "0"}) == ("", "")


@pytest.mark.parametrize("site_url", ["javascript:alert(1)", "study.example.com", "ftp://example.com"])
def test_site_url_must_be_a_web_address(site_url):
    # 입장이 막힌 화면의 "학원 사이트로 가기" 링크가 됩니다.
    with pytest.raises(SystemExit):
        entry_settings({"ENTRY_SECRET": SECRET, "SITE_URL": site_url})


@pytest.mark.parametrize("flag", ["1", "true", "yes"])
@pytest.mark.parametrize("secret", ["", "s" * 31])
def test_required_entry_refuses_missing_or_short_secret(flag, secret):
    with pytest.raises(SystemExit):
        entry_settings({"REQUIRE_ENTRY": flag, "ENTRY_SECRET": secret})


def test_non_ascii_pass_cookie_is_blocked_not_crashing(make_client):
    client, _ = make_client()

    res = client.get("/api/videos", headers={b"cookie": b"study_pass=9999999999.\xe9\xe9"})

    assert res.status_code == 401
