# 판서 내용 분석 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 강의 화면을 30초마다 캡처해 겹치는 장면을 버리고, 대본과 함께 Claude에 보내 판서 내용을 요점에 반영하며, 챕터마다 고른 칠판 사진을 학생 화면에 보여 준다.

**Architecture:** 캡처·중복 제거는 새 모듈 `academy/frames.py`(PyAV + Pillow). `ai.make_study_guide`가 장면을 이미지 블록으로 받아 챕터별 `board` 시점을 돌려주고, `analyze_all`이 고른 장면만 `data/frames/<id>/<초>.jpg`로 저장한다. 서버는 `/frames/{video_id}/{name}`으로 사진을 내주고 화면은 챕터 카드에 붙인다.

**Tech Stack:** Python 3.10+, PyAV(av<19), Pillow, numpy(이미 설치됨), Claude API 이미지 입력, FastAPI, 순수 JS.

**Spec:** `docs/superpowers/specs/2026-10-19-board-frames-design.md`

## Global Constraints

- 캡처 간격 30초(0초부터), 폭 1280(작은 영상은 키우지 않음), JPEG 품질 75.
- 겹침 판정: 32×18 흑백으로 줄여 직전에 남긴 장면과 화소 차이 평균이 8 미만(0~255)이면 버림.
- 장수 제한 `min(100, max(1, ceil(길이초 / 60)))`, 넘으면 시간 순으로 고르게 줄임.
- 영상 트랙이 없거나 읽기 오류, 길이 정보 없음 → 경고 출력 후 빈 목록(분석은 계속).
- 챕터 `board`: 모델이 준 "분:초"를 보낸 장면 중 가장 가까운 장면의 초(int)로 바꾸고, 빈 값·형식이 틀린 값·장면 없음은 `None`.
- 사진 파일: `DATA_DIR/frames/<영상 id>/<초>.jpg`, 임시 파일 후 바꿔치기.
- `/frames/{video_id}/{name}`: 영상 id가 실제 영상이고 `name`이 `숫자.jpg` 형식일 때만, 파일이 없으면 404. 입장 확인 미들웨어가 그대로 적용.
- Pillow는 `requirements.txt`(분석 PC)에만. `requirements-server.txt`는 바꾸지 않음.
- 화면 문구 한국어. 공개 저장소이므로 강의 내용·사진을 커밋하지 않음.

## Review Focus

1. 30초보다 짧은 영상(예: 10초) → 장면 정확히 1장(0초). (Task 1 테스트)
2. 폭이 1280보다 작은 영상 → 키우지 않고 원래 폭 유지. (Task 1 테스트)
3. 모델이 `board`에 형식이 틀린 값(`abc`, `1분 20초`)을 주면 엉뚱한 0초 사진이 아니라 사진 없음(`None`). (Task 2 테스트)
4. 두 챕터가 같은 장면을 고름 → 사진은 한 번만 저장되고 둘 다 같은 파일을 가리킴. (Task 3 테스트)
5. 아주 긴 영상(장면 300개) → 100장으로 고르게 줄고 처음·끝 시점이 포함됨. (Task 1 테스트)

---

### Task 1: 화면 캡처와 겹침 제거 (`academy/frames.py`)

**Files:**
- Create: `academy/frames.py`
- Modify: `requirements.txt` (`Pillow>=11` 추가, "영상 분석용" 아래)
- Test: `tests/test_frames.py`

**Interfaces:**
- Produces:
  - `INTERVAL = 30`, `WIDTH = 1280`, `JPEG_QUALITY = 75`, `SAME_SCENE = 8`, `MAX_FRAMES = 100`
  - `extract_frames(path: Path) -> list[tuple[int, bytes]]` — (초, JPEG 바이트), 시간 순
  - `thin(frames: list, limit: int) -> list` — 시간 순으로 고르게 `limit`개(처음·끝 포함), `len <= limit`이면 그대로

- [ ] **Step 1: 실패하는 테스트 작성** — 테스트 안에서 PyAV로 시험 영상을 만드는 도우미 `make_video(path, scenes, size=(320, 180))`: `scenes`는 `[(초 길이, 색 또는 그림 배열), ...]`, `mpeg4`, 1fps.
  - `test_keeps_one_frame_per_distinct_scene`: 흰 60초 → 검은 바탕 흰 사각형 60초 → 검은 바탕 다른 위치 사각형 60초 → `[t for t, _ in extract_frames(p)] == [0, 60, 120]`
  - `test_frames_are_jpeg_and_not_upscaled`: 위 영상의 첫 장 바이트가 `b"\xff\xd8"`로 시작, Pillow로 열면 폭 320
  - `test_short_video_gives_one_frame`: 10초 영상 → 장면 1장, 시점 0
  - `test_file_without_video_gives_empty_list`: 텍스트 파일 또는 오디오만 있는 파일 → `[]` (예외 없음)
  - `test_thin_spreads_evenly_and_keeps_ends`: `thin(list(range(300)), 100)` 길이 100, 첫 값 0, 끝 값 299, 오름차순; `thin([1, 2], 5) == [1, 2]`
- [ ] **Step 2: 실패 확인** — `python -m pytest tests/test_frames.py -q` → `ModuleNotFoundError: academy.frames`
- [ ] **Step 3: 구현** — `pip install -r requirements.txt`로 Pillow 설치 후. 시점마다 `container.seek`로 그 시점 앞 키프레임에 간 뒤 `frame.time >= t`인 첫 장면을 쓴다. 겹침 판정은 `frame.reformat(width=32, height=18, format="gray").to_ndarray()`의 평균 절대 차이. JPEG는 `frame.reformat(width=min(WIDTH, w), height=비율)`→`to_image()`→`save(BytesIO, "JPEG", quality=75)`. 장수 제한 후 `thin`. 오류는 `av.error.FFmpegError`·`IndexError`·`StopIteration`을 잡아 경고(`print(..., file=sys.stderr)`) 후 `[]`.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, 전체 `python -m pytest -q` PASS
- [ ] **Step 5: 커밋** — `git add academy/frames.py tests/test_frames.py requirements.txt && git commit -m "Capture distinct lecture frames for board analysis"`

### Task 2: 장면을 Claude에 보내고 챕터별 사진 시점 받기 (`academy/ai.py`)

**Files:**
- Modify: `academy/ai.py` (`GUIDE_PROMPT`, `GUIDE_SCHEMA`의 챕터에 `board`, `make_study_guide`)
- Modify: `tests/test_ai.py` (기존 요청 검사를 블록 형태에 맞춤 + 새 테스트)

**Interfaces:**
- Consumes: Task 1의 장면 형식 `list[tuple[int, bytes]]`
- Produces: `make_study_guide(client, title: str, segments: list[dict], frames: Sequence[tuple[int, bytes]] = ()) -> dict` — 각 챕터에 `board: int | None`

- [ ] **Step 1: 실패하는 테스트 작성** — 가짜 장면 `FRAMES = [(0, b"\xff\xd8A"), (60, b"\xff\xd8B"), (120, b"\xff\xd8C")]`, 가짜 응답 챕터 `board`: `"01:05"`, `""`, `"abc"`.
  - `test_guide_request_sends_transcript_then_frames`: `messages[0]["content"]`이 리스트, 첫 블록 text에 대본 줄 포함, 이어서 `[00:00] 화면` text + image 블록이 시간 순으로 3쌍, image 블록 `source == {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(b"\xff\xd8A").decode()}`
  - `test_board_maps_to_nearest_frame_or_none`: 결과 챕터 `board`가 순서대로 `60`, `None`, `None`
  - `test_no_frames_means_no_board`: `frames` 없이 호출, 응답 `board: "01:05"` → `None`, 요청에 image 블록 없음
  - 기존 `test_study_guide_request_sends_transcript_and_json_schema`: 대본 확인을 첫 text 블록에서 하도록 고침, 기존 `GUIDE` 픽스처 챕터에 `"board": ""` 추가
- [ ] **Step 2: 실패 확인** — `python -m pytest tests/test_ai.py -q` → 새 테스트 FAIL(`frames` 인자 없음 등)
- [ ] **Step 3: 구현** — 내용은 항상 블록 리스트. 프롬프트에 "화면의 판서(수식·도표·정리)를 읽어 요점에 반영하고 수식은 텍스트로 옮겨 적기, 챕터마다 판서가 가장 잘 보이는 화면 시점을 board에 '분:초'로, 없으면 빈 문자열" 추가. `board` 해석: 정규식 `^\d+(:\d{1,2}){1,2}$`이 맞을 때만 `parse_time` 후 가장 가까운 장면 초, 아니면 `None`.
- [ ] **Step 4: 통과 확인** — `python -m pytest -q` PASS
- [ ] **Step 5: 커밋** — `git add academy/ai.py tests/test_ai.py && git commit -m "Send lecture frames to Claude and pick a board photo per chapter"`

### Task 3: 분석 흐름에 연결하고 고른 사진 저장 (`academy/analyze.py`, `academy/library.py`)

**Files:**
- Modify: `academy/library.py` (`save_frame`), `academy/analyze.py` (`analyze_all` 시그니처, `main`)
- Modify: `tests/test_analyze.py`, `tests/test_library.py`

**Interfaces:**
- Consumes: Task 1 `extract_frames`, Task 2 `make_study_guide(..., frames)`
- Produces:
  - `save_frame(data_dir: Path, video_id: str, seconds: int, jpeg: bytes) -> None` → `data_dir/frames/<id>/<seconds>.jpg` (임시 파일 후 `os.replace`)
  - `analyze_all(video_dir, data_dir, transcribe, make_guide, extract_frames, force=False) -> int`, `make_guide(title, segments, frames)`

- [ ] **Step 1: 실패하는 테스트 작성**
  - `test_library.py::test_save_frame_writes_jpeg_under_frames_dir`: `save_frame(tmp, "abc", 60, b"\xff\xd8x")` → `(tmp / "frames" / "abc" / "60.jpg").read_bytes() == b"\xff\xd8x"`, `.tmp` 남지 않음
  - `test_analyze.py`: `Recorder`에 `extract_frames(path)`(호출 기록, `[(0, b"A"), (60, b"B")]` 반환) 추가, `make_guide(title, segments, frames)`가 받은 frames 기록, 반환 GUIDE 챕터 두 개가 모두 `board: 60`
    - `test_saves_only_chosen_frames_once`: 분석 후 `frames/<id>/60.jpg == b"B"`이고 `0.jpg`는 없음, 두 챕터 `board == 60`
    - `test_silent_video_skips_claude`(기존): `extract_frames`도 호출되지 않음을 추가 확인
    - 기존 테스트들은 새 인자(`rec.extract_frames`)를 넘기도록 고침
- [ ] **Step 2: 실패 확인** — `python -m pytest tests/test_analyze.py tests/test_library.py -q` → FAIL(`save_frame` 없음, 인자 수)
- [ ] **Step 3: 구현** — 요점 정리 직전에 `frames = extract_frames(video["path"])`, `guide = make_guide(title, segments, frames)`, 챕터 `board`들의 초를 모아(중복 제거) 해당 JPEG만 `save_frame`. `main`은 `academy.frames.extract_frames`를 넘기고 `make_study_guide(client, title, segments, frames)`로 연결.
- [ ] **Step 4: 통과 확인** — `python -m pytest -q` PASS
- [ ] **Step 5: 커밋** — `git add academy/analyze.py academy/library.py tests/test_analyze.py tests/test_library.py && git commit -m "Save the board photos chosen for each chapter"`

### Task 4: 사진 제공과 화면 표시 (`academy/server.py`, 화면)

**Files:**
- Modify: `academy/server.py` (`GET /frames/{video_id}/{name}`)
- Modify: `academy/static/watch.js` (`renderGuide`), `academy/static/style.css` (`.board`)
- Test: `tests/test_server.py`, `tests/test_entry_server.py`

**Interfaces:**
- Consumes: Task 3 파일 위치 `DATA_DIR/frames/<id>/<초>.jpg`, 챕터 `board: int | None`
- Produces: `GET /frames/{video_id}/{name}` → `image/jpeg`

- [ ] **Step 1: 실패하는 테스트 작성**
  - `test_server.py::test_serves_board_photo`: `save_frame(data_dir, id, 60, b"\xff\xd8x")` 후 `/frames/<id>/60.jpg` → 200, `content-type`이 `image/jpeg`, 본문 일치
  - `test_server.py::test_board_photo_rejects_bad_requests`: `/frames/<id>/61.jpg`(없음), `/frames/<id>/abc.jpg`, `/frames/<id>/60.png`, `/frames/nope/60.jpg` → 모두 404
  - `test_entry_server.py::test_board_photo_needs_pass`: 비밀 키 켜고 쿠키 없이 `/frames/<id>/60.jpg` → 401
- [ ] **Step 2: 실패 확인** — `python -m pytest tests/test_server.py tests/test_entry_server.py -q` → 새 테스트 FAIL
- [ ] **Step 3: 구현** — 서버: `get_video`로 확인, `re.fullmatch(r"\d+\.jpg", name)`, 파일 없으면 404, `FileResponse(path, media_type="image/jpeg")`. 화면: 챕터 `c.board`가 숫자면 핵심 내용 아래 `button.board > img[src="/frames/${id}/${c.board}.jpg"][loading=lazy][alt="판서 분:초"]`, 누르면 `seek(c.board)`. CSS: 이미지 폭 100%, 둥근 모서리, 테두리.
- [ ] **Step 4: 통과 확인** — `python -m pytest -q` PASS
- [ ] **Step 5: 브라우저 확인** — scratchpad 시험 데이터의 챕터 하나에 `board: 60`과 사진 파일을 넣고 Playwright로: 해당 챕터에 사진이 보이고(`naturalWidth > 0`) 누르면 `currentTime ≈ 60`, `board`가 없는 챕터엔 사진 없음. 기존 `e2e.js` 24개, 입장 후 24개 전부 PASS. 시험 스크립트는 커밋하지 않음.
- [ ] **Step 6: 커밋** — `git add academy/server.py academy/static/watch.js academy/static/style.css tests/test_server.py tests/test_entry_server.py && git commit -m "Show the chosen board photo on each chapter"`

### Task 5: 안내 문서

**Files:**
- Modify: `README.md` (기능 표의 요점 정리 칸에 칠판 사진, 3단계 분석 설명에 "이미 분석한 영상에 사진을 넣으려면 `--force`", 비용 줄에 "판서 사진 포함 1시간 강의당 약 $0.2~0.3 추가")

- [ ] **Step 1: 수정** — 위 세 곳
- [ ] **Step 2: 확인** — README의 명령(`--force`)과 금액이 설계 문서와 같은지 대조
- [ ] **Step 3: 커밋** — `git add README.md && git commit -m "Document board photos in the README"`

### Task 6: 마무리

- [ ] **Step 1:** `python -m pytest -q` 전부 PASS, 화면 검사 전부 PASS
- [ ] **Step 2:** 새 검토 담당(가장 뛰어난 모델)이 계획 범위 전체 검토 → 확인 후 반영
- [ ] **Step 3:** 푸시
