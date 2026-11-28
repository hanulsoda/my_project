# 아동 읽기 시선 추적 시스템 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 선생님이 아이별 읽기 시선 기록을 누적·비교하고 부모용 리포트를 만드는 웹 시스템(브라우저 측정 + Oracle VM 서버).

**Architecture:** 브라우저에서 WebGazer로 시선 좌표만 만들어(영상은 기기 밖으로 나가지 않음) 지문의 단어 박스 좌표와 함께 서버로 보낸다. 서버(Node/Express + SQLite)가 고정 응시 판정·지표·품질을 계산해 저장하고, 선생님 화면과 공유 링크 리포트를 제공한다. Docker Compose(앱 + Caddy)로 한 번에 기동하며 https는 Caddy가 자동 발급한다.

**Tech Stack:** Node 20 (CommonJS), express, better-sqlite3, `node:test`, 바닐라 JS 프런트엔드, WebGazer 3.5.3(`app/webgazer.js` 재사용), Docker Compose + Caddy.

**Spec:** `/home/user/eye-tracker/docs/superpowers/specs/2026-11-27-reading-eye-tracker-design.md`

## Global Constraints

- 얼굴 영상은 저장·전송하지 않는다. 서버 수신 데이터는 시선 좌표 `{t,x,y}`와 단어 박스뿐이다.
- 보호자 종이 동의 날짜가 기록되지 않은 아이는 측정 시작 불가(HTTP 403).
- 대상 초등~고등, 한국어 지문. 학년대(`elementary|middle|high`)에 따라 글자 크기·보정 시간·지문 길이가 다르다.
- 비교는 아이 본인의 과거 기록과만 한다. 학년 규준 비교 없음. 진단처럼 보이는 문구 금지("선별 지표, 진단 아님" 문구를 리포트에 표시).
- 선생님은 자신이 맡은 아이만 본다. 관리자가 선생님을 초대한다.
- 공유 링크: 기본 30일 만료, 선생님이 폐기 가능, 리포트에 실명 대신 이니셜/코드(`child.code`)만 표시.
- 아이 삭제 시 해당 아이의 세션·시선·공유 링크를 모두 영구 삭제.
- 품질 점수 0.6 미만 세션은 "참고용"으로 표시하고 줄 단위 결과만 제공한다(단어 단위 지표 숨김).
- 카메라는 https 또는 localhost에서만 동작. Let's Encrypt는 Caddy가 처리. 서비스 주소 `reading.dahim.kr`.
- Oracle VM 접속 정보 없음: 산출물은 `docker compose up` 묶음 + 배포 안내서까지. 서버 반영은 이번 범위 밖.

## Review Focus

1. 깜빡임/시선 이탈로 `x`,`y`가 `null`이거나 화면 밖인 샘플이 많거나 샘플이 0개 → 지표 계산이 죽지 않고 품질 0, "참고용".
2. 아이가 지문을 끝까지 읽지 않고 중단 → 읽은 단어 수까지만으로 속도 계산, 미완독 표시.
3. 만료·폐기된 공유 링크 → 410, 존재하지 않는 토큰 → 404, 리포트에 실명 미노출.
4. 선생님 A가 선생님 B의 아이/세션/리포트 접근 → 404.
5. 동의 미기록 아이 측정 시작 → 403, 동의 후 → 허용.

---

### Task 1: 지표 엔진 (순수 함수)

**Files:**
- Create: `package.json`, `server/metrics.js`, `tests/metrics.test.js`
- 첫 단계에서 `git init` (현재 폴더는 git 저장소가 아님)

**Interfaces:**
- Produces (`server/metrics.js`):
  - `type Sample = {t:number, x:number|null, y:number|null}` (ms, px)
  - `type WordBox = {i:number, line:number, x:number, y:number, w:number, h:number}`
  - `detectFixations(samples: Sample[], opts?: {maxDispersionPx?:number /*40*/, minDurationMs?:number /*100*/}): {tStart:number,tEnd:number,x:number,y:number}[]` — `null` 샘플은 응시를 끊는다.
  - `assignToWords(fixations, words: WordBox[], tolerancePx?:number /*30*/): ({wordIndex:number, line:number}|null)[]` — 가장 가까운 박스, 허용 오차 밖이면 `null`.
  - `computeMetrics(samples: Sample[], words: WordBox[], screen:{w:number,h:number}): Metrics`
  - `type Metrics = {wpm:number, wordsRead:number, completed:boolean, durationSec:number, regressions:number, skippedLines:number, dwellMsByWord:number[], longDwellWords:number[], quality:number, detail:'word'|'line'}`

- [ ] **Step 1: `git init`, `npm init -y`, `package.json`에 `"test": "node --test tests/"` 추가, `npm i express better-sqlite3`**
- [ ] **Step 2: Write failing tests** in `tests/metrics.test.js`: (a) 40px 안에서 150ms 머무는 샘플 → 고정 응시 1개, (b) `null` 샘플이 응시를 둘로 나눔, (c) 5단어 한 줄을 좌→우로 읽는 합성 샘플(단어당 250ms) → `wordsRead===5`, `completed===true`, `regressions===0`, `wpm`≈ 5/1.25s*60 (±5%), (d) 3번째→1번째 단어로 되돌아가는 샘플 → `regressions===1`, (e) 3줄 중 가운데 줄 응시 없음 → `skippedLines===1`, (f) 한 단어에 900ms 머무름 → `longDwellWords`에 포함(평균+2표준편차 이상이면서 400ms 이상), (g) 샘플 0개 → `quality===0`, `detail==='line'`, 예외 없음, (h) 전부 `null`/화면 밖 → `quality===0`, (i) 단어 5개 중 3개까지만 읽음 → `completed===false`, `wordsRead===3`.
- [ ] **Step 3: Run** `npm test` — Expected: FAIL (module not found)
- [ ] **Step 4: Implement** 위 시그니처. 정의: 되돌아읽기 = 이전 응시 단어보다 2단어 이상 앞(또는 이전 줄)으로 이동; 건너뛴 줄 = 도달한 최소~최대 줄 사이 응시 0인 줄; `quality` = (유효 샘플 비율) × (단어에 배정된 응시 비율); `detail = quality>=0.6 ? 'word':'line'`; `wpm = wordsRead / durationSec * 60`(durationSec는 첫~마지막 단어 응시 구간, 0이면 `wpm=0`).
- [ ] **Step 5: Run** `npm test` — Expected: PASS
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: gaze metrics engine"`

### Task 2: DB, 로그인, 관리자 초대

**Files:** Create `server/db.js`, `server/auth.js`, `server/app.js`, `tests/helpers.js`, `tests/auth.test.js`

**Interfaces:**
- Consumes: Task 1 없음.
- Produces:
  - `openDb(path:string): Database` — 스키마: `users(id,email unique,pw_hash,role 'admin'|'teacher',created_at)`, `invites(token pk,email,expires_at,used_at)`, `auth_sessions(token pk,user_id,expires_at)`, `children(id,teacher_id,code,initials,grade_band,consent_date,created_at)`, `read_sessions(id,child_id,passage_id,kind 'reference'|'new',started_at,screen_w,screen_h,words_json,samples_json,metrics_json)`, `share_links(token pk,session_id,expires_at,revoked_at)`. 외래키 `ON DELETE CASCADE`.
  - `createApp({db, now?:()=>number}): express.Application`
  - `tests/helpers.js`: `startTestServer(): Promise<{url, db, close, loginAs(role): Promise<cookie>}>` (임시 DB, 포트 0)
  - 라우트: `POST /api/login {email,password}` → `Set-Cookie: sid`, `POST /api/logout`, `POST /api/admin/invites {email}` → `{token}` (관리자만), `POST /api/invites/:token/accept {password}` → 선생님 계정 생성. 미들웨어 `requireTeacher`, `requireAdmin`.
  - 최초 관리자: 환경변수 `ADMIN_EMAIL`, `ADMIN_PASSWORD`로 시작 시 생성(없을 때만).

- [ ] **Step 1: Write failing tests** `tests/auth.test.js`: 올바른 로그인 → 200 + 쿠키; 틀린 비밀번호 → 401; 관리자 아닌 사용자의 초대 생성 → 403; 초대 수락 후 로그인 가능; 만료/사용된 초대 수락 → 410; 비로그인으로 `/api/children` 호출 → 401.
- [ ] **Step 2: Run** `npm test` — Expected: FAIL
- [ ] **Step 3: Implement** 비밀번호는 `crypto.scrypt`(솔트 포함), 세션 토큰은 `crypto.randomBytes(32)`, 쿠키는 `HttpOnly; SameSite=Lax; Secure`(테스트에서는 `NODE_ENV=test`일 때 Secure 제외).
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `git commit -am "feat: db schema, auth, invites"`

### Task 3: 아이 관리 + 동의 게이트 + 지문

**Files:** Create `server/routes/children.js`, `server/passages.js`, `data/passages.json`, `tests/children.test.js`, `tests/passages.test.js`; Modify `server/app.js`

**Interfaces:**
- Consumes: Task 2 `requireTeacher`, `db`.
- Produces:
  - `POST /api/children {code,initials,gradeBand,consentDate?}` → 201 `{id,...}`; `GET /api/children` (본인 담당만); `PATCH /api/children/:id {consentDate}`; `DELETE /api/children/:id` (cascade).
  - `listPassages(gradeBand): {id,title,kind:'reference'|'new',text,fontPx,lineHeight}[]`, `getPassage(id)`. `data/passages.json`: 학년대별 기준 지문 1개 + 새 지문 2개 이상(한국어, 초등 약 60~100어절, 중등 100~160, 고등 150~220).
  - 타 선생님의 아이 → 404.

- [ ] **Step 1: Write failing tests**: 아이 생성/목록; 선생님 B가 A의 아이 `PATCH`/`DELETE` → 404; 삭제 후 `read_sessions`·`share_links` 행 0(미리 삽입); `listPassages('elementary')`에 `reference` 정확히 1개, 모든 지문 어절 수가 학년대 범위 안.
- [ ] **Step 2: Run** — Expected: FAIL
- [ ] **Step 3: Implement** 라우트와 지문 로더. 지문 텍스트는 직접 작성한 창작 문장을 쓴다(저작권 문제 방지).
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `git commit -am "feat: children, consent, passages"`

### Task 4: 측정 세션 업로드와 지표 저장

**Files:** Create `server/routes/sessions.js`, `tests/sessions.test.js`; Modify `server/app.js`

**Interfaces:**
- Consumes: Task 1 `computeMetrics`, Task 3 `getPassage`, children 동의 필드.
- Produces:
  - `POST /api/children/:id/sessions {passageId, screen:{w,h}, words:WordBox[], samples:Sample[]}` → 201 `{id, metrics}`. 동의일 없으면 403 `{error:'consent_required'}`. 샘플 상한 100,000개 초과 → 413. 지표는 서버에서 `computeMetrics`로 계산해 `metrics_json`에 저장.
  - `GET /api/children/:id/sessions` → 시간순 `{id,passageId,kind,startedAt,metrics}[]`(samples/words 제외).
  - `GET /api/sessions/:id` → 상세(품질 < 0.6이면 `metrics.dwellMsByWord`, `longDwellWords`를 빈 배열로 응답).

- [ ] **Step 1: Write failing tests**: 동의 없는 아이 → 403; 동의 후 합성 샘플 업로드 → 201이고 `metrics.wordsRead` 일치; 타 선생님 → 404; 샘플 0개 업로드 → 201, `metrics.quality===0`, 상세에서 `dwellMsByWord` 빈 배열; 목록은 시간순.
- [ ] **Step 2: Run** — Expected: FAIL
- [ ] **Step 3: Implement** 요청 크기 제한(`express.json({limit:'10mb'})`)과 입력 검증(숫자·배열 형태).
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `git commit -am "feat: reading sessions with server-side metrics"`

### Task 5: 추이 데이터, 공유 링크, 리포트 API

**Files:** Create `server/routes/reports.js`, `tests/reports.test.js`; Modify `server/app.js`

**Interfaces:**
- Consumes: Task 4 세션 저장 구조.
- Produces:
  - `GET /api/children/:id/trend` → 기준 지문(`kind:'reference'`) 세션만 시간순 `{startedAt, wpm, regressions, skippedLines, quality}[]`.
  - `POST /api/sessions/:id/share {days?:number /*30*/}` → `{token, url, expiresAt}`; `DELETE /api/share/:token` (담당 선생님만) → 폐기.
  - `GET /api/report/:token` (비로그인) → `{child:{code,initials,gradeBand}, session:{startedAt, metrics(품질 규칙 적용)}, trend, disclaimer:'선별 지표이며 진단이 아닙니다.'}`. 만료·폐기 → 410, 없음 → 404. 응답에 `teacher_id`, 실명 필드 없음.

- [ ] **Step 1: Write failing tests**: 기준 지문 세션 2개 + 새 지문 1개 → `trend` 길이 2; 공유 링크로 리포트 조회 200이고 `disclaimer` 포함, 응답 JSON 문자열에 이메일·`teacher_id` 없음; 시간을 31일 뒤로 옮기면(`now` 주입) 410; 폐기 후 410; 임의 토큰 404; 타 선생님이 공유 생성 → 404.
- [ ] **Step 2: Run** — Expected: FAIL
- [ ] **Step 3: Implement** 토큰은 `randomBytes(24).toString('base64url')`.
- [ ] **Step 4: Run** — Expected: PASS
- [ ] **Step 5: Commit** `git commit -am "feat: trend, share links, report api"`

### Task 6: 프런트엔드 (선생님 화면, 측정 화면, 리포트 화면)

**Files:** Create `public/index.html`(로그인), `public/children.html`, `public/read.html`, `public/report.html`, `public/js/{api,calibrate,capture,layout,charts}.js`, `public/css/app.css`, `tests/frontend.test.js`; Move/Copy: `app/webgazer.js` + `app/mediapipe/` → `public/vendor/`; Modify `server/app.js`(정적 서빙)

**Interfaces:**
- Consumes: Tasks 2–5 API.
- Produces (브라우저 모듈, 전역 `ReadingApp`):
  - `layout.js`: `layoutPassage(el:HTMLElement, text:string): WordBox[]` — 어절을 `<span>`으로 감싸 `getBoundingClientRect`로 박스 계산, `line`은 y 값 클러스터링으로 부여(순수 함수 `groupLines(boxes)`는 Node 테스트 가능하게 분리).
  - `calibrate.js`: `runBallCalibration(webgazer, {seconds:number}): Promise<void>` — 화면의 공을 따라가는 놀이. 학년대별 초등 12초/중등 10초/고등 8초.
  - `capture.js`: `startCapture(webgazer): {stop(): Sample[]}` — `t`는 시작 기준 ms, 시선 없음은 `x:null`.
  - 측정 흐름: 동의 확인(서버가 403이면 안내 화면) → 보정 → 지문 읽기 → "다 읽었어요" 버튼 → `POST …/sessions`.
  - 카메라 영상은 `<video>` 미리보기에만 쓰고 네트워크로 보내지 않는다.
  - 화면: 아이 목록(동의일 입력/수정, 삭제 확인), 측정 시작, 추이 차트(SVG), 공유 링크 생성/폐기, 리포트(인쇄 CSS로 한 장 PDF, "참고용" 배지, 단어 강조).

- [ ] **Step 1: Write failing tests** `tests/frontend.test.js`: `groupLines`가 y가 비슷한 박스를 같은 `line`으로 묶음(3줄 합성 입력 → line 0,1,2); 리포트 페이지 HTML에 `선별 지표` 문구와 인쇄용 `@media print` 규칙 포함; 정적 서빙 `GET /read.html` 200.
- [ ] **Step 2: Run** — Expected: FAIL
- [ ] **Step 3: Implement** 모듈과 페이지. 학년대별 글자 크기는 지문의 `fontPx`/`lineHeight`를 사용. 실제 카메라 동작은 Task 7의 수동 점검에서 확인한다.
- [ ] **Step 4: Run** `npm test` — Expected: PASS
- [ ] **Step 5: Commit** `git commit -am "feat: teacher UI, reading page, report page"`

### Task 7: 배포 묶음, 정확도 측정 페이지, 안내서

**Files:** Create `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `.env.example`, `public/measure.html`, `docs/deploy.md`, `docs/accuracy-protocol.md`, `tests/deploy.test.js`

**Interfaces:**
- Consumes: Task 6 정적 파일, 앱 포트 3000, 환경변수 `ADMIN_EMAIL`,`ADMIN_PASSWORD`,`DB_PATH`.
- Produces: `docker compose up -d`로 앱+Caddy 기동, `reading.dahim.kr` https 서빙, SQLite는 볼륨 `data/`에 영속. `measure.html`: 화면 9개 지점을 차례로 보게 하고 예측 좌표와의 평균 오차(px, 화면 대각선 대비 %)를 표시·복사하는 점검 페이지. `docs/deploy.md`: VM 방화벽 80/443 개방, DNS A 레코드(`reading.dahim.kr`→VM IP), 백업(`data/` 복사), 업데이트 절차. `docs/accuracy-protocol.md`: 실제 아이·기기(iPad Safari, Android Chrome, 노트북)에서 오차를 재고 품질 기준 0.6을 조정하는 절차.

- [ ] **Step 1: Write failing test** `tests/deploy.test.js`: `docker-compose.yml`에 `caddy`와 앱 서비스 존재, `Caddyfile`에 `reading.dahim.kr`와 `reverse_proxy` 존재, `.env.example`에 `ADMIN_EMAIL`·`ADMIN_PASSWORD` 존재, `docs/deploy.md`에 `80`·`443` 언급.
- [ ] **Step 2: Run** — Expected: FAIL
- [ ] **Step 3: Implement** 파일들. `Dockerfile`은 `node:20-slim`, `npm ci --omit=dev`.
- [ ] **Step 4: Run** `npm test` — Expected: 전체 PASS
- [ ] **Step 5: 수동 점검(카메라 있는 기기 필요)** — 로컬에서 `ADMIN_EMAIL=… ADMIN_PASSWORD=… npm start` 후 `http://localhost:3000`에서 로그인→아이 등록→동의일 입력→측정→리포트 생성까지 확인하고 결과를 기록. 이 환경에는 카메라가 없어 자동 실행 불가.
- [ ] **Step 6: Commit** `git commit -am "feat: deployment bundle, accuracy protocol, docs"`
