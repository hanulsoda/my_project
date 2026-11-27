# 요점노트·시험대비 연결 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 단원별 요점노트·시험대비문제 JSON을 영상에 자동 연결하고, 학생이 플레이어에서 읽고 바로 풀게 하며, 같은 JSON에서 선생님용 PDF를 만든다.

**Architecture:** 새 모듈 `academy/study.py`가 JSON 읽기·점검·영상 연결을 맡고, `academy/server.py`가 `/api/study/{id}`와 영상 상세의 `study` 필드를 준다. 플레이어는 새 `study.js`로 두 탭(요점노트, 시험대비)을 그린다. PDF는 `tools/study/`가 같은 JSON에서 만든다(서버와 별개).

**Tech Stack:** Python 3.10+, FastAPI, pytest, 순수 JS(빌드 도구 없음), Playwright(e2e·PDF), Noto Sans KR(npm `@fontsource/noto-sans-kr`).

**Spec:** `docs/superpowers/specs/2026-11-27-study-materials-design.md`

## Global Constraints

- 항목마다 문항 수는 **객관식 10, 주관식 5, OX 10, 단답형 10**. 객관식 보기는 **5개**, 정답 번호는 **0~4**.
- 환경 변수: `STUDY_FILE`, `STUDY_LINKS_FILE`, `STUDY_INTERNET`. 설정하지 않으면 새 기능은 꺼지고 기존 동작은 그대로다.
- 연결은 `scope`의 모든 낱말이 **폴더 경로**에 있어야 한다. `scope`가 비면 연결하지 않는다. 서로 다른 항목 둘 이상과 맞으면 연결하지 않는다.
- 규칙 1(단원 번호)은 **파일 이름이 단원 번호로 시작**할 때만(바로 뒤에 숫자가 이어지면 안 됨). 규칙 2는 `unit_title` 네 글자 이상, 규칙 3은 `works` 세 글자 이상. 한글은 NFC로 합치고 띄어쓰기·기호는 무시한다.
- `notes.words`는 `{"w": "낱말", "def": "뜻"}` 객체의 목록이다(쌍이 아님).
- 글 속 꾸밈은 `<b>`, `<u>`, `<br>`만 해석한다. 통째로 `innerHTML`에 넣지 않는다.
- 새 화면은 `wrong:`·`score:` 저장 칸을 쓰지 않고 `study:`만 쓴다. 공용 `quizCard`의 기본 동작은 바꾸지 않는다.
- 인터넷(학원 내부망 밖)에서 온 요청에는 `STUDY_INTERNET`이 켜졌을 때만 `study`와 `/api/study`를 준다.
- 화면에 보이는 글은 이 플레이어의 기존 말투(대체로 합니다체)를 따른다. 점수는 연습용이며 합격과 무관하다는 안내를 지우지 않는다.
- 저장소에 교재 원문을 넣지 않는다. 시험 자료는 가짜 지문만 쓴다. 실제 자료 JSON은 `tools/study/data/`에 두되 `.gitignore`한다.
- 시험은 `tests/`의 기존 방식을 따른다. 실행: `python -m pytest <파일> -v` (필요 패키지: fastapi, httpx, anthropic, uvicorn, pytest, numpy. faster-whisper는 이 시험들에 필요 없음).

## Review Focus

1. 맥에서 옮긴 한글 자모(NFD) 파일 이름이 연결된다 → Task 2.
2. `STUDY_FILE`이 없거나 비었거나 한 항목만 모양이 깨져도 서버·점검이 멈추지 않고 나머지가 동작한다 → Task 1·3.
3. JSON에 `<script>`·`<img onerror>`가 들어 있어도 글자로 보일 뿐 실행되지 않는다 → Task 5.
4. 인터넷에서 온 요청은 `STUDY_INTERNET` 없이는 `study` 필드가 비고 `/api/study/{id}`가 404다 → Task 3.
5. 단답형은 띄어쓰기·대소문자·마침표 차이를 무시하고, 빈 입력은 채점하지 않는다 → Task 6.

## File Structure

- Create `academy/study.py`: JSON 읽기·점검·연결 규칙. 서버와 도구가 모두 쓴다.
- Create `academy/study_links.py`: 연결 현황을 찍는 명령(`python -m academy.study_links`).
- Modify `academy/server.py`: `create_app` 인자, 두 곳의 응답, 마지막 `app = create_app(...)` 연결.
- Modify `academy/check.py`: `STUDY_FILE` 등 점검.
- Create `academy/static/study.js`: 두 탭 그리기.
- Modify `academy/static/common.js`(`quizCard`), `watch.html`, `watch.js`, `style.css`.
- Create `tools/study/` (`build_pdf.py`, `render.js`, `package.json`, `promote.py`), `.gitignore` 한 줄.
- Create `tests/study_data.py`(가짜 항목 만들기), `tests/test_study.py`, `tests/test_study_server.py`, `tests/test_study_links.py`, `tests/test_study_tools.py`, `tests/e2e/test_study.py`. Modify `tests/test_check.py`.

---

### Task 1: 항목 형식 읽기·점검

**Files:**
- Create: `academy/study.py`, `tests/study_data.py`
- Test: `tests/test_study.py`

**Interfaces:**
- Produces (모두 `academy/study.py`):
  - `read_study(path: str | None) -> list` — 경로가 없거나 비면 `[]`. 파일을 못 읽거나 JSON 오류거나 목록이 아니면 한국어 한 줄로 `SystemExit`(`read_references`와 같은 방식).
  - `entry_problems(entry: object) -> list[str]` — 문제가 없으면 `[]`.
  - `usable_study(entries: list) -> list[dict]` — 문제 있는 항목과 id가 겹치는 뒤쪽 항목을 `logging.warning`과 함께 뺀다.
- Produces (`tests/study_data.py`): `make_entry(**overrides) -> dict` — 가짜 지문의 올바른 항목(`id` "midaen-4-2", `unit` "4-2", `unit_title` "가짜 단원 제목입니다", `works` ["가짜작품"], `scope` ["미래엔"], 문항 10/5/10/10, 보기 5개)을 돌려주고 최상위 키를 덮어쓸 수 있다.

항목 형식은 스펙 ‘결정한 것 1’을 그대로 따른다. `entry_problems`가 확인하는 것: 사전인지; `id`·`unit`·`unit_title`이 비지 않은 글; `works`가 글 목록; `scope`가 비지 않은 글 목록; `notes.blocks`가 목록; `quiz.passages`가 비지 않은 목록; 네 종류 문항 수; 객관식 보기 5개·정답 0~4; OX 정답이 `true/false`; 단답형 정답이 비지 않은 글.

- [ ] **Step 1: 실패하는 시험을 쓴다** (`tests/test_study.py`)
  - `test_valid_entry_has_no_problems`: `entry_problems(make_entry()) == []`.
  - `test_wrong_counts_are_reported`: 객관식 9개인 항목 → 문제 글 중 "객관식"과 "10"을 함께 담은 줄이 있다. OX 11개, 주관식 4개, 단답형 9개도 같은 방식.
  - `test_choice_and_answer_shape`: 보기 4개 / 정답 5 / 정답 `"1"`(글) → 각각 "객관식"이 든 문제 줄이 있다.
  - `test_empty_scope_and_missing_blocks_are_reported`: `scope=[]`, `notes={}`, `quiz` 없음 → 각각 문제가 있다. 사전이 아닌 값(`"글"`, `None`)도 문제가 있다.
  - `test_usable_study_drops_bad_and_duplicate_ids`: 올바른 항목, 깨진 항목, id가 같은 올바른 항목을 주면 첫 항목만 남고 경고 두 줄이 로그에 남는다(`caplog`).
  - `test_read_study_missing_or_empty_path_gives_empty_list`: `read_study(None) == []`, `read_study("") == []`.
  - `test_read_study_bad_file_exits_with_one_line`: 없는 경로·깨진 JSON·목록이 아닌 JSON → `SystemExit`, 메시지에 경로와 "STUDY_FILE"이 있다. BOM이 붙은 파일은 읽힌다.
- [ ] **Step 2: 실패를 확인한다.** `python -m pytest tests/test_study.py -v` → ImportError.
- [ ] **Step 3: `academy/study.py`에 위 세 함수를, `tests/study_data.py`에 `make_entry`를 만든다.** `read_study`는 `academy/references.py`의 `read_references`(UTF-8-sig, `~` 풀기)를 따라 쓴다.
- [ ] **Step 4: 통과를 확인한다.** 같은 명령 → 모두 PASS.
- [ ] **Step 5: 커밋.** `git add academy/study.py tests/study_data.py tests/test_study.py && git commit -m "feat: read and validate study entries"`

---

### Task 2: 영상 연결 규칙

**Files:**
- Modify: `academy/study.py`
- Test: `tests/test_study.py`

**Interfaces:**
- Consumes: Task 1의 `make_entry`.
- Produces (`academy/study.py`):
  - `norm(text: str) -> str` — NFC로 합치고 `[\W_]+`를 지운다.
  - `read_links(path: str | None) -> dict[str, str | None]` — `{영상 제목(폴더 포함): 항목 id 또는 null}`. 경로가 없으면 `{}`. 읽기 실패는 `read_study`처럼 `SystemExit`. 키는 NFC로 합친다.
  - `link_video(entries: list[dict], title: str, links: dict | None = None) -> dict` — `{"status": "matched"|"number_only"|"direct"|"ambiguous"|"none", "entries": list[dict]}`. `title`은 폴더를 `/`로 이은 영상 제목이고, 파일 이름은 마지막 조각, 폴더는 나머지다.

규칙은 Global Constraints와 같다. 상태: 항목 하나만 후보이고 규칙 1로만 맞으면 `number_only`, 규칙 2·3으로도 맞으면 `matched`, 후보가 서로 다른 항목 둘 이상이면 `ambiguous`(항목 없음), 직접 연결 파일(`links`)에 있으면 규칙보다 앞서 `direct`(값이 `None`이거나 없는 id면 `none`).

- [ ] **Step 1: 실패하는 시험을 쓴다.** 제목 견본은 `"2022개정/고1/미래엔/"` 뒤에 파일 이름을 붙인 것.
  - `test_unit_number_prefix_matches`: `"4-2. 아무 제목"`, `"4-2 아무 제목"`, `"4-2_아무 제목"`, `"4–2. 아무 제목"` → 모두 `status == "number_only"`이고 항목은 `make_entry()` 하나.
  - `test_unit_number_must_start_the_name_and_not_run_into_digits`: `"3강 4-2 복습"`, `"2024-4-2 수업"`, `"4-21. 다른 단원"` → `status == "none"`.
  - `test_unit_title_and_work_names_match_anywhere_in_the_name`: 이름에 `"가짜 단원 제목입니다"` 또는 `"가짜작품"`(띄어쓰기·기호 달라도)이 있으면 `matched`. 두 글자 이름 `works=["가짜"]`는 연결하지 않는다.
  - `test_scope_words_must_all_be_in_the_folder`: 폴더에 "미래엔"이 없으면 `none`. `scope=["미래엔","고1"]`인데 폴더에 "고1"이 없으면 `none`. 폴더 없는 영상(`"4-2. 제목"`)도 `none`. 이름에만 "미래엔"이 있고 폴더에 없으면 `none`.
  - `test_nfd_titles_match`: 제목 전체를 `unicodedata.normalize("NFD", ...)`한 것도 `matched`.
  - `test_two_entries_make_it_ambiguous`: 서로 다른 id의 항목 둘이 같은 영상에 맞으면 `ambiguous`, `entries == []`. 한 항목이 규칙 둘에 걸리는 것은 `matched`.
  - `test_direct_links_override_rules`: `links={제목: "midaen-4-2"}`이면 규칙에 안 맞아도 `direct`. `links={제목: None}`이면 규칙에 맞아도 `none`. 모르는 id는 `none`.
  - `test_read_links`: 파일 `{"a": "x", "b": null}`을 읽으면 같은 사전. 경로 없음 → `{}`. 목록·깨진 JSON → `SystemExit`.
- [ ] **Step 2: 실패를 확인한다.** `python -m pytest tests/test_study.py -v` → 새 시험 FAIL.
- [ ] **Step 3: `norm`, `read_links`, `link_video`를 구현한다.** 규칙 1은 `unit`을 `-`로 쪼개 `\s*[-–]\s*`로 이은 정규식을 파일 이름 앞에서 `match`하고 끝에 `(?!\d)`를 둔다. 후보 모으기는 항목별로 `(scope 통과) and (규칙1 or 규칙2 or 규칙3)`.
- [ ] **Step 4: 통과를 확인한다.** 같은 명령 → 모두 PASS.
- [ ] **Step 5: 커밋.** `git commit -am "feat: link study entries to lecture videos"` (새 파일이면 `git add` 포함)

---

### Task 3: 서버 연결

**Files:**
- Modify: `academy/server.py` (`create_app` 인자·`video_detail`·새 엔드포인트·끝의 `app = create_app(...)`)
- Test: `tests/test_study_server.py`

**Interfaces:**
- Consumes: `usable_study`, `read_study`, `read_links`, `link_video` (Task 1·2), `make_entry`.
- Produces: `create_app(..., proxy_addrs=(), study=(), study_links=None, study_internet=False)`. `GET /api/videos/{id}` 응답에 `"study": [{"id", "title", "unit"}]`(`title`은 `unit_title`)가 더해진다. `GET /api/study/{entry_id}` → `{"id","unit","unit_title","notes","quiz"}`, 모르는 id나 닫힌 요청은 404 `{"detail": "자료를 찾을 수 없습니다"}`.

`study_open(request)`는 `study_internet or not outside(request)`다. 영상 상세는 연결 결과를 영상 id별로 기억한다(`matched`와 같은 방식). 연결에는 영상 `title`(폴더 포함)을 쓴다. 끝의 `app = create_app(...)`에는 `read_study(os.environ.get("STUDY_FILE"))`, `read_links(os.environ.get("STUDY_LINKS_FILE"))`, `ASK_ENABLED`와 같은 방식으로 읽은 `STUDY_INTERNET`을 넘긴다.

- [ ] **Step 1: 실패하는 시험을 쓴다.** 영상 `고1/미래엔/4-2. 가짜 제목.mp4`를 만든 `TestClient`(`tests/test_entry_server.py`의 `HOME`·`ACADEMY` 주소 견본을 따른다).
  - `test_video_detail_lists_linked_study`: 학원 PC 주소 요청의 상세 응답 `study == [{"id": "midaen-4-2", "title": "가짜 단원 제목입니다", "unit": "4-2"}]`.
  - `test_unlinked_video_has_empty_study`: 폴더에 "미래엔"이 없는 영상은 `study == []`.
  - `test_study_endpoint_returns_notes_and_quiz`: `/api/study/midaen-4-2`의 `quiz`에 문항 수가 10/5/10/10이고 `notes.blocks`가 있다.
  - `test_unknown_study_id_is_404`.
  - `test_internet_requests_get_nothing_without_opt_in`: `entry_secret`를 켜고 통과 쿠키를 가진 인터넷 주소 요청: `study_internet=False`이면 상세의 `study == []`, `/api/study/midaen-4-2`는 404. `study_internet=True`이면 둘 다 보인다.
  - `test_server_without_study_works_as_before`: `study`를 주지 않은 앱의 상세 응답에 `study == []`이고 나머지 키가 그대로다.
  - `test_one_broken_entry_does_not_stop_the_others`: 올바른 항목 + 깨진 항목 → 올바른 항목만 연결된다.
- [ ] **Step 2: 실패를 확인한다.** `python -m pytest tests/test_study_server.py -v` → FAIL.
- [ ] **Step 3: 구현한다.** 인자 세 개 추가, `study = usable_study(study)`, `/api/study/{entry_id}`, `video_detail` 응답의 `study`.
- [ ] **Step 4: 기존 시험이 깨지지 않았는지 확인한다.** `python -m pytest tests/test_server.py tests/test_entry_server.py tests/test_references.py -q` → 모두 PASS, 그리고 `tests/test_study_server.py` PASS.
- [ ] **Step 5: 커밋.** `git add academy/server.py tests/test_study_server.py && git commit -m "feat: serve study materials linked to videos"`

---

### Task 4: 설정 점검과 연결 현황 명령

**Files:**
- Modify: `academy/check.py`
- Create: `academy/study_links.py`
- Test: `tests/test_check.py`, `tests/test_study_links.py`

**Interfaces:**
- Consumes: `read_study`, `usable_study`, `entry_problems`, `read_links`, `link_video`; `academy.library.find_videos`; `academy.settings.load_env_file`.
- Produces: `academy.study_links.report(videos: list[dict], entries: list[dict], links: dict | None = None) -> list[str]`, `academy.study_links.main(env=os.environ) -> int`(항상 0).

`report`의 첫 줄은 `연결됨 {n}개 · 번호로만 연결 {n}개 · 직접 연결 {n}개 · 모호함 {n}개 · 연결 안 됨 {n}개`. 이어서 `번호로만 연결`, `모호함` 영상을 `[번호로만 연결] 제목 → 항목id`, `[모호함] 제목 → id1, id2` 줄로, `연결 안 됨`은 최대 50개를 `[연결 안 됨] 제목` 줄로 보이고 넘치면 `… 외 {n}개`를 붙인다.

`checks(env)`에 더할 줄: `STUDY_FILE`이 없으면 `참고` "시험대비 자료(STUDY_FILE)를 설정하지 않았습니다…"; 있으면 항목마다 `entry_problems`를 `문제` 줄로, 정상이면 `확인` "시험대비 자료 {n}개"; `STUDY_LINKS_FILE`을 못 읽으면 `문제`; `ENTRY_SECRET`이 있고 `STUDY_INTERNET`이 꺼져 있으면 `참고` "인터넷으로 들어오는 학생에게는 요점노트·시험대비가 보이지 않습니다(STUDY_INTERNET=1로 켭니다)".

- [ ] **Step 1: 실패하는 시험을 쓴다.**
  - `test_report_counts_and_lists_each_kind` (`tests/test_study_links.py`): 영상 네 개(연결됨, 번호로만, 모호함, 없음)로 첫 줄의 숫자와 세 종류의 줄 모양을 확인한다.
  - `test_report_truncates_unlinked_after_50`: 연결 안 된 영상 60개 → `[연결 안 됨]` 줄 50개와 `… 외 10개`.
  - `test_main_prints_report_and_returns_zero`: 임시 `VIDEO_DIR`·`STUDY_FILE`로 `main(env)` 출력(`capsys`)에 첫 줄이 있고 반환값이 0.
  - `test_check_reports_study_file_states` (`tests/test_check.py`): 설정 없음 → 참고; 정상 항목 → 확인 "시험대비 자료 1개"; 객관식이 9개인 항목 → 문제; `ENTRY_SECRET` 켬 + `STUDY_INTERNET` 없음 → 참고에 "STUDY_INTERNET".
- [ ] **Step 2: 실패를 확인한다.** `python -m pytest tests/test_study_links.py tests/test_check.py -v` → 새 시험 FAIL.
- [ ] **Step 3: `check.py` 점검과 `study_links.py`를 구현한다.** `main`은 서버·점검과 같은 설정 파일을 `load_env_file()`로 읽는다.
- [ ] **Step 4: 통과를 확인한다.** 같은 명령 → 모두 PASS.
- [ ] **Step 5: 커밋.** `git add academy/check.py academy/study_links.py tests/test_check.py tests/test_study_links.py && git commit -m "feat: check study settings and report video links"`

---

### Task 5: 요점노트 탭

**Files:**
- Create: `academy/static/study.js`
- Modify: `academy/static/watch.html`, `academy/static/watch.js`, `academy/static/style.css`
- Test: `tests/e2e/test_study.py`(새로 만들고 `tests/e2e/conftest.py` 보강)

**Interfaces:**
- Consumes: Task 3의 `/api/study/{id}`, 영상 상세의 `study`; `common.js`의 `el`, `watch.js`의 `$`·`notice`.
- Produces (전역 함수, `study.js`): `inlineMarkup(text: string): DocumentFragment`(`<b>`, `<u>`, `<br>`만 해석, 나머지는 글자로 보임), `renderNotes(box: HTMLElement, notes: object): void`. 탭: 버튼 `tab-btn-study-notes`(글자 "요점노트"), 본문 `tab-study-notes`. `watch.js`의 `loadStudy(entryId: string): void`가 `/api/study/{id}`를 받아 `renderNotes`를 부른다(실패하면 `notice`).

`watch.html`은 `common.js`와 `watch.js` 사이에 `study.js`를 넣고 탭 버튼을 `hidden`으로 둔다. `render()`는 `$("tab-btn-ask").hidden = !ask;` 바로 아래에서(분석이 없어 일찍 돌아가는 경로보다 앞) `study`가 비지 않으면 버튼을 보이고 `loadStudy(study[0].id)`를 부른다. `renderNotes`는 스펙의 `notes.blocks` 종류(`big`, `h`, `def`, `tip`, `card`, `list`, `flow`, `table`)와 `words`(`{"w","def"}` 객체 목록, 낱말·뜻 표)를 그리고, 알 수 없는 `t`는 건너뛴다. 스타일은 기존 색 변수만 쓴다(새 색을 만들지 않음: `tests/test_style.py`가 대비를 검사함).

- [ ] **Step 1: 실패하는 시험을 쓴다.** (`tests/e2e/test_study.py`, 기존 `test_player.py` 방식. e2e 서버 fixture에 `STUDY_FILE`용 항목과 `고1/미래엔/4-2. …` 영상을 더한다.)
  - `test_study_tabs_are_hidden_for_unlinked_videos`: 연결 안 된 영상에서 `#tab-btn-study-notes`가 보이지 않는다.
  - `test_notes_tab_shows_blocks`: 연결된 영상에서 탭을 누르면 `big` 제목, `table`의 머리 칸과 한 칸, `tip` 글, 낱말 표가 보인다.
  - `test_markup_other_than_b_u_br_is_shown_as_text`: 항목의 `tip` 글을 `"<b>굵게</b><script>window.hacked=1</script><img src=x onerror=window.hacked=1>"`로 한 서버에서 탭을 열면 `window.hacked`가 없고, 화면 글자에 `<script>`가 그대로 보이며 `<b>` 안은 굵게 그려진다.
  - `test_study_load_failure_shows_a_notice`: `/api/study/…`를 막으면 탭에 안내 글이 보인다.
- [ ] **Step 2: 실패를 확인한다.** `python -m pytest tests/e2e/test_study.py -v` → FAIL (브라우저가 없으면 SKIP이라고 나오는데, 그 경우 `pip install playwright`와 Chromium 경로를 맞춘 뒤 다시 돌린다. 끝내 못 돌리면 Task 8의 화면 확인 절차로 대신하고 보고에 적는다).
- [ ] **Step 3: 구현한다.** `inlineMarkup`은 허용한 세 태그만 요소로 만들고 나머지는 `createTextNode`로 넣는다.
- [ ] **Step 4: 통과를 확인한다.** 같은 명령 → PASS. `python -m pytest tests/test_style.py -q` → PASS.
- [ ] **Step 5: 커밋.** `git add academy/static tests/e2e && git commit -m "feat: show study notes tab in the player"`

---

### Task 6: 시험대비 탭

**Files:**
- Modify: `academy/static/study.js`, `academy/static/common.js`(`quizCard`), `academy/static/watch.html`, `academy/static/watch.js`, `academy/static/style.css`
- Test: `tests/e2e/test_study.py`

**Interfaces:**
- Consumes: Task 5의 탭 연결(`loadStudy`), `common.js`의 `quizCard`, `store`.
- Produces: `quizCard(q, n, onResult, replay, options = {})` — `options.review === false`이면 틀렸을 때 안내에서 ‘틀린 문제 복습’ 문구를 뺀다(기본값은 지금과 같음). `study.js`: `normalizeAnswer(text: string): string`(NFC, 소문자, 공백과 `. , · : ; ! ? ' " ‘ ’ “ ” ( ) [ ] ~ -` 제거), `renderStudyQuiz(box: HTMLElement, quiz: object, studyId: string): void`. 탭 버튼 `tab-btn-study-quiz`("시험대비"), 본문 `tab-study-quiz`.

화면: 맨 위 안내 "점수는 연습용이며 실제 평가가 아닙니다." → 지문마다 펼쳐 둔 `<details class="study-passage">`(요약 "[가] 제목") → 문제 1~35번을 이어서 번호 매겨 네 묶음("객관식 (5지선다)", "주관식", "OX", "단답형")으로 → 점수 줄.
- 객관식·OX: 기존 `quizCard`에 `{question, choices, answer, explanation}`을 넘긴다(OX는 보기 `["O","X"]`, 정답 `ox.answer ? 0 : 1`). 객관식 글에 줄바꿈이 있으면 첫 줄만 제목으로, 나머지(〈보기〉)는 `blockquote`로 따로 둔다.
- 단답형: 입력칸 + "확인". `normalizeAnswer`한 값이 정답 또는 `alts`와 같으면 정답 처리. 다르면 정답과 해설을 보이고 "내 답도 맞아요" 버튼으로 정정할 수 있다. 빈 입력은 채점하지 않고 "답을 써 주세요."를 보인다.
- 주관식: 쓰는 칸(저장 안 함) + "모범 답안 보기" → 모범 답안과 `note`, "알았어요/몰랐어요".
- 점수: 객관식·OX·단답형 30문제. 모두 풀면 `store.set("study:" + studyId, {right, total: 30, at: Date.now()})`. 다음에 열면 "지난번 right/30"을 보인다. "다시 풀기" 버튼은 탭을 다시 그린다. `wrong:`·`score:`는 건드리지 않는다.

- [ ] **Step 1: 실패하는 시험을 쓴다.**
  - `test_quiz_tab_has_passages_and_35_questions_in_four_sections`: 지문 상자가 펼쳐져 있고, `.question`이 35개, 묶음 제목 네 개.
  - `test_mc_and_ox_grade_instantly_without_review_promise`: 틀린 보기를 누르면 해설이 보이고 화면에 "틀린 문제 복습"이 없다. 기존 퀴즈 탭에서 틀리면 그 문구가 여전히 보인다(기본 동작 유지).
  - `test_short_answer_ignores_spaces_case_and_punctuation`: 정답 "매스 미디어"에 `"매스미디어"`, `"매스 미디어."` 모두 정답. 정답 "SNS"에 `"sns"` 정답. 빈 입력은 "답을 써 주세요."이고 점수가 늘지 않는다. 틀린 답 뒤 "내 답도 맞아요"를 누르면 정답으로 바뀐다.
  - `test_subjective_reveals_model_answer`: "모범 답안 보기"를 누르면 모범 답안과 "알았어요/몰랐어요"가 보인다.
  - `test_score_is_saved_under_study_key_only`: 30문제를 모두 풀면 `localStorage`에 `study:midaen-4-2`가 있고 `wrong:`·`score:`로 시작하는 키는 새로 생기지 않는다.
- [ ] **Step 2: 실패를 확인한다.** `python -m pytest tests/e2e/test_study.py -v` → 새 시험 FAIL(또는 SKIP, Task 5와 같은 처리).
- [ ] **Step 3: 구현한다.** `quizCard`에는 선택 인자만 더하고 기존 호출은 그대로 둔다.
- [ ] **Step 4: 통과를 확인한다.** `python -m pytest tests/e2e -q` → 기존 시험 포함 PASS. `python -m pytest tests/test_style.py -q` → PASS.
- [ ] **Step 5: 커밋.** `git add academy/static tests/e2e && git commit -m "feat: add the study quiz tab"`

---

### Task 7: PDF 만들기와 승인한 항목 모으기

**Files:**
- Create: `tools/study/build_pdf.py`, `tools/study/render.js`, `tools/study/package.json`, `tools/study/promote.py`
- Modify: `.gitignore`(`tools/study/data/` 한 줄과 설명 주석)
- Test: `tests/test_study_tools.py`

**Interfaces:**
- Consumes: `academy.study.entry_problems`, `tests/study_data.make_entry`.
- Produces:
  - `tools/study/build_pdf.py`: `notes_html(entry: dict) -> str`, `quiz_html(entry: dict) -> str`(각각 완전한 HTML 문서: A4, 9pt, 2단, Noto Sans KR), `main(argv: list[str]) -> int` — `python tools/study/build_pdf.py <study json> <출력 폴더> [항목 id…]`이 항목마다 `요점정리_<unit>_<unit_title>.html`, `시험대비문제_<unit>_<unit_title>.html`을 쓴다. `render.js`가 폴더의 HTML을 PDF로 바꾼다(Playwright, 쪽번호 바닥글).
  - `tools/study/promote.py`: `promote(draft_path: str, out_path: str, ids: list[str]) -> list[str]` — 초안에서 승인한 id의 항목만 `out_path`(이미 있으면 합침, id가 같으면 교체)에 쓰고 쓴 id를 돌려준다. 초안에 없는 id가 있으면 `SystemExit`로 알리고 아무것도 쓰지 않는다. 쓰기 전에 `entry_problems`를 통과해야 한다.

`quiz_html`: 지문 상자 → Ⅰ 객관식(5지, ①~⑤) → Ⅱ 주관식(쓰는 줄 3개) → Ⅲ OX(○ 칸) → Ⅳ 단답형 → 새 쪽에서 `정답과 해설`(정답 번호·모범 답안·해설). `<b>`, `<u>`, `<br>` 외의 글은 HTML 이스케이프한다. 지금 쓰는 임시 생성기(대화 환경의 `build.py`, `build2.py`)의 모양을 그대로 옮긴다.

- [ ] **Step 1: 실패하는 시험을 쓴다.**
  - `test_quiz_html_has_all_sections_and_answers_on_a_new_page`: `quiz_html(make_entry())`에 "객관식", "주관식", "OX", "단답형"이 순서대로 있고, "정답과 해설"이 그 뒤에 있으며 그 앞에 `break-before: page`가 있다. 보기 번호 `⑤`가 있다. 지문 제목이 있다.
  - `test_html_escapes_everything_but_allowed_markup`: 지문 글에 `<script>`가 있으면 결과에 `<script>`가 없고 `&lt;script&gt;`가 있다. `<b>굵게</b>`는 그대로.
  - `test_notes_html_has_unit_title_and_blocks`: `notes_html(make_entry())`에 단원 제목, `def` 글, 낱말(`{"w","def"}`)이 있다.
  - `test_promote_writes_only_approved_and_replaces_same_id`: 항목 둘이 든 초안에서 하나만 승격 → 출력에는 그 하나뿐. 같은 id를 다시 승격하면 교체되어 개수가 늘지 않는다.
  - `test_promote_refuses_unknown_id_and_bad_entries`: 없는 id → `SystemExit`이고 출력 파일이 만들어지지 않는다. 문제 있는 항목 → `SystemExit`.
- [ ] **Step 2: 실패를 확인한다.** `python -m pytest tests/test_study_tools.py -v` → FAIL.
- [ ] **Step 3: 구현한다.** `tools/study`를 import할 수 있게 시험 쪽에서 경로를 더하거나 `tools/__init__.py`를 둔다(둘 중 하나, 저장소 방식에 맞춰 선택).
- [ ] **Step 4: 통과를 확인한다.** 같은 명령 → PASS. 손으로 `python tools/study/build_pdf.py`와 `node tools/study/render.js`를 가짜 항목으로 돌려 PDF가 생기는지 확인한다(`npm install`은 `tools/study`에서).
- [ ] **Step 5: 커밋.** `git add tools .gitignore tests/test_study_tools.py && git commit -m "feat: build study PDFs and promote approved entries"`

---

### Task 8: 4-2·5-1 항목 만들기와 끝까지 확인

**Files:**
- Create (저장소 밖 보관, git 제외): `tools/study/data/study_draft.json`, 승인 후 `tools/study/data/study.json`
- 코드 변경 없음(필요하면 이 과정에서 드러난 결함만 고친다).

이 작업은 코드가 아니라 자료 작업이다. 입력은 이 대화 환경의 임시 폴더에 있는 4-2·5-1 사전(요점노트 `content.py`, 시험 `content2.py`·`content3.py`).

- [ ] **Step 1: 사전을 스펙 형식 JSON 항목 둘로 바꾼다.** 한 번 쓰고 버리는 스크립트로 `tools/study/data/study_draft.json`에 쓴다. 항목: `midaen-4-2`(`unit` "4-2", `unit_title` "주제 통합적 읽기(한 권 읽기) - 친구에 관한 세 가지 글", `works` 세 지문 제목), `midaen-5-1`(`unit` "5-1", `unit_title` "매체 소통 문화와 공동 보고서 쓰기", `works` ["매체 소통 문화", "공동 보고서"]). 둘 다 `scope` ["미래엔"]. 요점노트 `blocks`는 사전의 튜플을 `{"t": …}` 형식으로, 시험 사전의 `q/exp` 이름은 스펙의 이름으로 옮긴다. 출처 줄은 `passages[].source`로 뺀다.
- [ ] **Step 2: 점검한다.** `python -c "from academy.study import *; print([entry_problems(e) for e in read_study('tools/study/data/study_draft.json')])"` → `[[], []]`.
- [ ] **Step 3: PDF를 같은 JSON에서 다시 만든다.** `build_pdf.py`와 `render.js`로 4개를 만들고, 이미 드라이브에 올린 PDF와 쪽수·절을 눈으로 비교해 어긋난 곳을 고친다.
- [ ] **Step 4: 가짜 영상으로 화면을 끝까지 확인한다.** 임시 `VIDEO_DIR`에 `고1/미래엔/4-2. 시험.mp4`(ffmpeg로 만든 짧은 영상)를 두고 `STUDY_FILE`을 `study_draft.json`으로 하여 `uvicorn academy.server:app`을 켠다. Playwright로 영상 상세를 열어 요점노트 탭, 시험대비 탭(객관식 하나·OX 하나·단답형 하나 풀기)을 누르고 화면 캡처를 확인한다. `python -m academy.study_links`도 돌려 `번호로만 연결 1개`가 나오는지 본다.
- [ ] **Step 5: 초안 JSON을 드라이브에 보관한다.** 새 폴더 `자료 데이터(JSON)`(수업용 > 2022년 개정)에 `study_draft.json`을 올린다(이 환경은 일회성이라 보관본이 필요하다).
- [ ] **Step 6: 사용자에게 보고하고 승인을 받는다.** 승인된 id가 오면 `promote.py`로 `study.json`을 만들어 보내고, 서버 담당자가 `STUDY_FILE`(과 필요하면 `STUDY_INTERNET=1`)을 설정하는 방법을 알린다. 승인 전에는 `study.json`을 만들지 않는다.

---

### Task 9: 문서 정리

**Files:**
- Modify: `README.md`(설정 표에 세 변수, ‘시험대비 연결’ 절), `docs/superpowers/specs/2026-11-27-study-materials-design.md`, `docs/superpowers/specs/2026-11-26-frequent-analysis-design.md`

- [ ] **Step 1: README에 세 변수와 사용법을 적는다.** 표에 `STUDY_FILE`, `STUDY_LINKS_FILE`, `STUDY_INTERNET`을 더하고, 아래를 짧게 적는다: 연결 규칙 한 문단, `python -m academy.study_links`와 `python -m academy.check`로 확인하는 법, 자료가 학원 교재 원문이라 공개 저장소에 올리지 말 것, 인터넷 공개는 `STUDY_INTERNET=1`로만.
- [ ] **Step 2: 설계 문서를 고친다.** 스펙에서 "`tools/study/data/`에 둔다"를 "`.gitignore`된 `tools/study/data/`에 두고 드라이브에 보관본을 둔다"로 바로잡는다(저장소에 교재 원문을 올리지 않는다는 원칙과 맞춘다). 15분 주기 설계 문서 맨 위에 "상태: 보류 — 영상이 자주 올라가지 않아 기존 밤 23시 작업으로 충분하다고 판단함(2026-11-27)"를 적는다.
- [ ] **Step 3: 전체 시험을 돌린다.** `python -m pytest -q` → 모두 PASS(브라우저가 없어 SKIP된 e2e는 건수를 보고에 적는다).
- [ ] **Step 4: 커밋.** `git add README.md docs && git commit -m "docs: document study materials settings"`

---

## Self-Review 기록

- 스펙 대응: 데이터 형식(1), 연결 규칙(2), 서버·인터넷 기본값(3), 플레이어(4), 만드는 순서와 승인·PDF(5), 시험(6) 모두 Task 1~9에 있다. ‘나머지 15개 단원 생산’은 코드가 아닌 반복 작업이라 이 계획의 범위 밖이며, Task 8을 사용자가 승인한 뒤 별도 계획으로 이어 간다.
- 이름 일치: `entry_problems`, `usable_study`, `read_study`, `read_links`, `link_video`, `norm`(Task 1·2) ↔ Task 3·4·7의 사용처, `quizCard(..., options)`·`renderNotes`·`renderStudyQuiz`·`loadStudy`·`inlineMarkup`·`normalizeAnswer`(Task 5·6)가 같다.
- 비례: 계획은 스펙의 약 3배 길이이고, 코드 본문은 넣지 않았다.
