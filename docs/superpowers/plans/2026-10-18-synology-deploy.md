# 학습 플레이어 DS918+ 배포 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 학원 사이트에 로그인한 학생만 DS918+에서 서비스하는 학습 플레이어에 들어올 수 있게 하고, 시놀로지 Container Manager로 설치할 수 있게 만든다.

**Architecture:** 서명·검증은 새 모듈 `academy/entry.py`(순수 함수)에 두고, `academy/server.py`가 `/enter` 경로와 요청마다의 통과 쿠키 검사(미들웨어)를 붙인다. 학원 사이트는 같은 HMAC을 만드는 PHP 함수로 입장 링크를 만든다. 배포는 웹 서버 패키지만 담은 Docker 이미지 + `docker-compose.yml`.

**Tech Stack:** Python 3.10+ (표준 `hmac`/`hashlib`), FastAPI/Starlette 미들웨어, PHP 8 `hash_hmac`, Docker (python:3.12-slim), Synology DSM 7.2 Container Manager.

**Spec:** `docs/superpowers/specs/2026-10-18-synology-deploy-design.md`

## Global Constraints

- 입장 링크: `/enter?exp=<유닉스 초>&sig=<hex>`, `exp` = 지금 + 300초, `sig` = HMAC-SHA256(비밀 키, `"enter:" + exp`) 16진수 소문자. `now <= exp`일 때만 유효.
- 통과 쿠키: 이름 `study_pass`, 값 `<만료>.<HMAC-SHA256(비밀 키, "pass:" + 만료)>`, 만료 = 지금 + 43200초(12시간), HttpOnly, SameSite=Lax, 요청 scheme이 https면 Secure.
- 서명 비교는 `hmac.compare_digest`.
- `/enter`를 뺀 모든 경로는 유효한 통과 쿠키 필요. `/api/`·`/media/`로 시작하면 401 JSON, 그 밖은 401 한 장짜리 HTML("학원 사이트에 로그인한 뒤 들어와 주세요" + `SITE_URL`이 있으면 링크).
- `ENTRY_SECRET`이 비어 있으면 입장 확인 없음(지금처럼 열림).
- `REQUIRE_ENTRY`가 켜져 있으면(아래 Review Focus 5) 비밀 키가 없거나 32자 미만일 때 서버가 시작하지 않고 한국어로 이유를 출력.
- 공개 저장소: 비밀 키·API 키·실제 도메인을 커밋하지 않는다. compose 파일의 값은 빈 자리표시.
- 컨테이너에는 `anthropic`, `fastapi`, `uvicorn`만 (Whisper 없음).
- 화면 문구는 한국어.

## Review Focus

1. `exp`가 정수가 아님(`abc`, `1e9`, 빈 값) → 500이 아니라 막힘 화면. (Task 1 테스트)
2. 쿠키 값이 깨짐(점 없음, 만료가 숫자 아님, 빈 값) → 500이 아니라 401. (Task 1 테스트)
3. 12시간이 지나 쿠키가 만료된 학생이 플레이어 안에서 다음 동작을 하면 "영상을 찾을 수 없습니다" 대신 로그인 안내가 보여야 함 → 화면 JS가 401을 받으면 페이지를 새로 고쳐 막힘 화면을 띄운다. (Task 2 브라우저 확인)
4. 비밀 키를 복사하다 앞뒤 공백·줄바꿈이 붙음 → 그래도 통과해야 함. Python·PHP 모두 앞뒤 공백을 제거. (Task 2·3 테스트)
5. `REQUIRE_ENTRY`를 `1` 대신 `true`/`yes`로 적음 → 꺼진 것으로 보면 비밀 키 없이 인터넷에 열린다. 빈 값과 `0`이 아니면 모두 켜짐으로 본다. (Task 2 테스트)

---

### Task 1: 서명·검증 함수 (`academy/entry.py`)

**Files:**
- Create: `academy/entry.py`
- Test: `tests/test_entry.py`

**Interfaces:**
- Produces:
  - `ENTER_TTL = 300`, `PASS_TTL = 43200`, `MIN_SECRET_LEN = 32`
  - `sign(secret: str, message: str) -> str`
  - `entry_link_ok(secret: str, exp: str | None, sig: str | None, now: float) -> bool`
  - `make_pass(secret: str, now: float) -> str`
  - `pass_ok(secret: str, value: str | None, now: float) -> bool`

- [ ] **Step 1: 실패하는 테스트 작성** — 기대값은 테스트 안에서 표준 `hmac`으로 직접 계산(코드의 `sign`을 쓰지 않음). `SECRET = "s" * 32`, `NOW = 1_800_000_000`.
  - `test_sign_is_hmac_sha256_hex`: `sign(SECRET, "enter:1") == hmac.new(SECRET.encode(), b"enter:1", hashlib.sha256).hexdigest()`
  - `test_entry_link_accepts_valid_and_rejects_bad`: 표 형태로 `(exp, sig, 기대값)` — 유효(`exp=NOW+300`, 맞는 sig) True / 만료(`exp=NOW-1`) False / sig 틀림 False / sig 없음 False / exp 없음 False / `exp="abc"` False / `exp="1e9"` False / `exp=""` False
  - `test_pass_round_trip_and_expiry`: `pass_ok(SECRET, make_pass(SECRET, NOW), NOW + 43199)` True, `NOW + 43201` False, 다른 비밀 키로 검사 False
  - `test_pass_rejects_malformed`: `None`, `""`, `"abc"`, `"x.y"`, `"123."`, `".abc"` 모두 False
- [ ] **Step 2: 실패 확인** — `python -m pytest tests/test_entry.py -q` → `ModuleNotFoundError: academy.entry`
- [ ] **Step 3: 구현** — 위 Interfaces 그대로. `exp`·만료는 `int()` 변환이 실패하면 False(`ValueError`만 잡음). 비교는 `hmac.compare_digest`.
- [ ] **Step 4: 통과 확인** — 같은 명령 → 전부 PASS, 전체 `python -m pytest -q`도 PASS
- [ ] **Step 5: 커밋** — `git add academy/entry.py tests/test_entry.py && git commit -m "Add entry link and pass signing helpers"`

### Task 2: 서버에 입장 확인 붙이기 (`academy/server.py`, 화면 JS)

**Files:**
- Modify: `academy/server.py` (`create_app` 시그니처, 미들웨어, `/enter`, 설정 읽기)
- Modify: `academy/static/watch.js` (`fetch` 401 처리), `academy/static/index.html` (같음)
- Test: `tests/test_entry_server.py`

**Interfaces:**
- Consumes: Task 1의 `entry_link_ok`, `make_pass`, `pass_ok`, `PASS_TTL`, `MIN_SECRET_LEN`
- Produces:
  - `create_app(video_dir, data_dir, answer, entry_secret: str = "", site_url: str = "") -> FastAPI`
  - `entry_settings(env: Mapping[str, str]) -> tuple[str, str]` → `(비밀 키(앞뒤 공백 제거), SITE_URL)`. `REQUIRE_ENTRY`가 빈 값·`0`이 아닌데 비밀 키가 `MIN_SECRET_LEN` 미만이면 `SystemExit("…")`(한국어 이유).
  - 모듈 끝: `app = create_app(..., *entry_settings(os.environ))`

- [ ] **Step 1: 실패하는 테스트 작성** — 기존 `tests/test_server.py`의 픽스처 방식(가짜 `answer`, `tmp_path` 영상) 사용, `SECRET = "s" * 32`, 입장 링크 sig는 테스트에서 `hmac`으로 직접 계산, `TestClient(..., follow_redirects=False)`.
  - `test_valid_link_sets_pass_and_redirects_home`: `/enter?exp=…&sig=…` → 302/303, `location == "/"`, 응답 쿠키 `study_pass` 있음, 그 쿠키로 `/api/videos` 200
  - `test_bad_link_shows_login_notice`: 틀린 sig → 401, 본문에 "학원 사이트에 로그인" 포함, `site_url="https://example.com"`이면 본문에 그 주소 포함
  - `test_without_pass_everything_is_blocked`: 쿠키 없이 `/` → 401 HTML, `/api/videos` → 401 JSON, `/media/<id>` → 401
  - `test_forged_or_expired_pass_is_blocked`: `study_pass="9999999999.deadbeef"` → `/api/videos` 401; 테스트에서 과거 만료로 올바르게 서명한 쿠키 → 401
  - `test_no_secret_keeps_app_open`: `entry_secret=""` → 쿠키 없이 `/api/videos` 200 (기존 동작)
  - `test_entry_settings`: `{}` → `("", "")`; `{"ENTRY_SECRET": " " + SECRET + "\n"}` → 공백 제거된 SECRET; `{"REQUIRE_ENTRY": v}` (v = `"1"`, `"true"`, `"yes"`)이고 비밀 키 없음 또는 31자 → `SystemExit`; `{"REQUIRE_ENTRY": "0"}` 비밀 키 없음 → 통과
- [ ] **Step 2: 실패 확인** — `python -m pytest tests/test_entry_server.py -q` → `create_app() got an unexpected keyword argument 'entry_secret'` 등으로 FAIL
- [ ] **Step 3: 구현**
  - `@app.middleware("http")`: 비밀 키가 있고 경로가 `/enter`가 아니며 `pass_ok(secret, request.cookies.get("study_pass"), time.time())`가 False이면 401(경로 규칙은 Global Constraints). 막힘 HTML은 함수 안 문자열(외부 파일 없음, `site_url`은 `html.escape`).
  - `GET /enter`: `entry_link_ok`면 `RedirectResponse("/", 303)` + `set_cookie("study_pass", make_pass(...), max_age=PASS_TTL, httponly=True, samesite="lax", secure=request.url.scheme == "https")`, 아니면 막힘 HTML 401. 비밀 키가 없으면 쿠키 없이 바로 `/`로 보낸다. 정적 파일 마운트보다 먼저 등록.
  - 화면 JS: API `fetch` 응답이 401이면 `location.reload()` (watch.js의 데이터 불러오기·질문하기, index.html의 목록).
- [ ] **Step 4: 통과 확인** — `python -m pytest -q` 전부 PASS
- [ ] **Step 5: 브라우저 확인 (Review Focus 3)** — scratchpad의 시험 서버를 `entry_secret`을 넣어 띄우고 Playwright로: 링크 없이 `/` → 안내 문구; 입장 링크로 들어가면 목록과 영상 재생(기존 `e2e.js` 24개 검사를 입장 후 상태에서 실행해 모두 PASS); 쿠키를 지운 뒤 질문하기 → 페이지가 막힘 화면으로 바뀜. 시험 스크립트는 커밋하지 않는다.
- [ ] **Step 6: 커밋** — `git add academy/server.py academy/static/watch.js academy/static/index.html tests/test_entry_server.py && git commit -m "Require a signed entry link when ENTRY_SECRET is set"`

### Task 3: 학원 사이트용 PHP 함수

**Files:**
- Create: `deploy/study_player_link.php`
- Test: `tests/test_php_link.py`

**Interfaces:**
- Consumes: Task 2의 `create_app(..., entry_secret=...)`
- Produces: PHP `function study_player_link(string $base_url, string $secret): string` → `rtrim($base_url, '/') . "/enter?exp=$exp&sig=$sig"`, `$exp = time() + 300`, `$secret = trim($secret)`. 파일 맨 위 주석에 한국어 사용법 3줄(포함 방법, 버튼 예시, 비밀 키는 플레이어와 같은 값).

- [ ] **Step 1: 실패하는 테스트 작성** — `pytest.mark.skipif(shutil.which("php") is None)`.
  - `test_php_link_is_accepted_by_player`: `subprocess.run(["php", "-r", "require 'deploy/study_player_link.php'; echo study_player_link('https://study.example.com/', getenv('S'));"], env={…, "S": SECRET + "\n"})` → 출력이 `https://study.example.com/enter?` 로 시작, 그 쿼리로 `TestClient(create_app(..., entry_secret=SECRET)).get("/enter?" + query)` → 303
- [ ] **Step 2: 실패 확인** — `python -m pytest tests/test_php_link.py -q` → php가 파일을 못 찾아 FAIL
- [ ] **Step 3: 구현** — Interfaces 그대로, `hash_hmac('sha256', "enter:$exp", $secret)`
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, 전체 PASS
- [ ] **Step 5: 커밋** — `git add deploy/study_player_link.php tests/test_php_link.py && git commit -m "Add PHP helper that builds the entry link"`

### Task 4: Docker 이미지와 Container Manager 설정

**Files:**
- Create: `requirements-server.txt` (`anthropic>=1.15`, `fastapi>=0.143`, `uvicorn>=0.54`)
- Modify: `requirements.txt` (맨 위 `-r requirements-server.txt`, 그 세 줄 삭제)
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`

**Interfaces:**
- Consumes: Task 2의 환경 변수 `ENTRY_SECRET`, `REQUIRE_ENTRY`, `SITE_URL`
- Produces:
  - `Dockerfile`: `FROM python:3.12-slim`, `requirements-server.txt`만 설치, `academy/` 복사, `CMD ["uvicorn", "academy.server:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]`, `ENV VIDEO_DIR=/videos DATA_DIR=/data`
  - `.dockerignore`: `.git .venv data videos tests docs __pycache__ .pytest_cache`
  - `docker-compose.yml`: 서비스 `study-player`, `build: .`, `restart: unless-stopped`, `ports: ["8000:8000"]`, `volumes: ["/volume1/video:/videos:ro", "./data:/data"]`(영상 경로는 설치 때 바꾸라는 주석), `environment`: `REQUIRE_ENTRY: "1"`, `ENTRY_SECRET: ""`, `SITE_URL: ""`, `ANTHROPIC_API_KEY: ""` (각 줄 한국어 주석)

- [ ] **Step 1: 실패 확인(현재 상태)** — `docker build -t study-player .` → `Dockerfile` 없음으로 실패
- [ ] **Step 2: 파일 작성** — 위 Produces 그대로
- [ ] **Step 3: 이 환경에서 빌드** — 프록시 때문에 scratchpad의 빌드 전용 래퍼만 쓴다(커밋 금지): `--build-context ca=/root/.ccr`로 CA를 넣고 `PIP_CERT`·프록시 build-arg를 주는 `Dockerfile.sandbox`(`FROM` 저장소 Dockerfile과 같은 내용 + CA 줄). 결과: 이미지 생성 성공, `docker run --rm study-player python -c "import faster_whisper"` → `ModuleNotFoundError`(Whisper 미포함 확인)
- [ ] **Step 4: 실행 확인** —
  - `REQUIRE_ENTRY=1`, 비밀 키 없이 `docker run` → 컨테이너가 바로 끝나고 로그에 한국어 이유
  - 비밀 키 32자 + 시험 영상 폴더 연결로 `docker run -d -p 8000:8000 …` → 쿠키 없이 `curl /api/videos` 401; `php`로 만든 입장 링크 `curl -i` → 303 + `set-cookie: study_pass`; 그 쿠키로 `/api/videos` 200, `/media/<id>`에 `Range: bytes=0-99` → 206
  - `X-Forwarded-Proto: https`를 붙인 `/enter` 응답 쿠키에 `Secure` 포함
- [ ] **Step 5: 기존 설치 확인** — `.venv`에서 `pip install -r requirements.txt` 정상, `python -m pytest -q` PASS
- [ ] **Step 6: 커밋** — `git add requirements-server.txt requirements.txt Dockerfile .dockerignore docker-compose.yml && git commit -m "Add Docker image and Container Manager project for the DS918+"`

### Task 5: 시놀로지 설치 안내

**Files:**
- Create: `docs/시놀로지-설치.md`
- Modify: `README.md` (설치 절 끝에 "시놀로지에 올리기: docs/시놀로지-설치.md" 한 줄)

**Interfaces:**
- Consumes: Task 3 PHP 함수 이름·인자, Task 4 compose 항목 이름·경로

- [ ] **Step 1: DSM 7.2 메뉴 이름 확인** — Synology 공식 KB(kb.synology.com)에서 Container Manager 프로젝트 만들기, 로그인 포털 > 고급 > 역방향 프록시, 보안 > 인증서 > Let's Encrypt 경로를 WebSearch/WebFetch로 확인. 확인 못 한 메뉴 이름은 문서에 "(DSM 버전에 따라 이름이 조금 다를 수 있음)"으로 표시.
- [ ] **Step 2: 문서 작성** — 설계 문서 "새 파일" 절의 6단계 순서 그대로, 단계마다 클릭 경로와 확인 방법:
  1. 영상 폴더 비교·복사 — 윈도우에서 `robocopy \\DS718\video \\DS918\video /E /L /NJH /NJS /NDL` (목록만) → 확인 후 `/L` 빼고 실행(`/MIR` 금지: 지우지 않음)
  2. 비밀 키 만들기 — `python -c "import secrets; print(secrets.token_hex(32))"` (64자)
  3. ZIP 받기 → `/volume1/docker/study-player`에 풀기 → compose의 영상 경로·비밀 키·사이트 주소·API 키 입력 → Container Manager 프로젝트 생성 → `http://DS918주소:8000` 에서 안내 문구 확인
  4. 역방향 프록시 `https://study.<학원도메인>:443` → `http://localhost:8000`, 인증서
  5. DNS `study` 레코드 추가, 공유기 80/443을 DS918+로
  6. 학원 사이트에 `deploy/study_player_link.php` 넣고 "강의 보기" 버튼 예시
  7. Z840에서 `//DS918/video`, `//DS918/docker/study-player/data`를 연결하고 `VIDEO_DIR`, `DATA_DIR`로 분석
  - 막힐 때: "모든 학생이 막힘"(비밀 키 불일치·시계), "컨테이너가 바로 꺼짐"(비밀 키 누락), "영상이 안 보임"(영상 경로)
- [ ] **Step 3: 확인** — 문서의 모든 명령·경로·설정 이름이 Task 3·4 파일과 같은지 대조(`grep`로 compose 키 이름, PHP 함수 이름)
- [ ] **Step 4: 커밋** — `git add docs/시놀로지-설치.md README.md && git commit -m "Add step-by-step Synology setup guide"`

### Task 6: 마무리 검토

- [ ] **Step 1:** `python -m pytest -q` 전부 PASS, 화면 검사(입장 후 `e2e.js`, `e2e_ask.js`) 전부 PASS
- [ ] **Step 2:** superpowers:requesting-code-review로 이번 계획의 변경 범위 전체 검토 → receiving-code-review로 확인 후 반영
- [ ] **Step 3:** 푸시 (`git push -u origin claude/epic-dijkstra-0evz2k`)
