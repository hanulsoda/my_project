# 다힘 사이트로 들어오기 (single sign-on)

원장·선생님·학생은 읽기 시선 기록에 **따로 로그인하지 않습니다.** 이미 로그인한 다힘(학원) 사이트에서 메뉴를 누르면,
다힘 사이트가 짧게 유효한 **서명된 입장 토큰**을 만들어 보내고, 읽기 시선 기록이 그 토큰을 확인해 자동으로 로그인시킵니다.
다힘 쪽 설치는 `deploy/academy-site/README.md`를 보세요.

## 1. 흐름
```
[다힘 사이트, 로그인한 상태]
   메뉴 "읽기 시선 기록"/"읽기 측정" 또는 학생 화면 "측정"
        │  GET /reading_go.php[?student=0123]
        ▼
reading_go.php (다힘 서버)
   - 세션에서만 역할·번호를 읽음 (요청 값은 ?student= 하나, 형식·맡은 반 확인)
   - 토큰 = base64url(payload) + "." + HMAC-SHA256 hex
   - 302 Location: https://reading.dahim.kr/sso?t=<토큰>&next=<경로>
        │
        ▼
GET /sso (읽기 시선 기록, server/routes/sso.js)
   1. SSO_SECRET 없음 → 503 안내 페이지
   2. 토큰 검사 (server/sso-token.js): 형식·크기 → 서명(상수 시간 비교) → 내용 → 시간
   3. 한 번용: 난수 n을 sso_nonces에 기록 (이미 있으면 거절). 지난 것은 이때 지움
   4. 원장/선생님: users.external_id로 찾고 없으면 만듦 → 비활성 계정이면 거절 → 12시간 세션
      학생: children.external_student_id로 아이를 찾음 → 없으면 "아직 등록되지 않았어요" → 2시간 학생 세션
   5. 302 → 안전한 next (아래 허용 목록), 응답에 Cache-Control: no-store, Referrer-Policy: no-referrer
        │
        ▼
/children.html (원장·선생님)   /read.html?child=<자기 아이> (학생)
```
실패는 모두 같은 안내 페이지 하나입니다: "다힘 사이트에서 다시 들어와 주세요" + `ACADEMY_URL`로 가는 버튼. 왜 실패했는지는 알려 주지 않습니다.

## 2. 토큰 약속 (계약)
- 토큰 = `<payload_b64url>.<sig_hex>`, 전체 1 KB 이하. ASCII만(`A-Z a-z 0-9 _ -` 와 점 하나, 서명은 소문자 hex 64자).
- payload(JSON, 키는 정확히 이 6개, 다른 키가 있으면 거절):
  `{"v":1,"role":"director|teacher|student","uid":"...","sid":"...","exp":<유닉스 초>,"n":"<hex 16~64자>"}`
  - director: `uid` = `admin` (영숫자 `_-` 1~32자). teacher: `uid` = 다힘 `admin_teacher_id`(1 이상의 숫자).
  - student: `uid` = `sid` = 학생 번호(숫자 4~12자, 다힘은 4자리 "0123").
  - 선생님·원장의 `sid`: 학생 화면에서 왔을 때 그 학생 번호, 아니면 빈 문자열.
- 서명 = `HMAC-SHA256(SSO_SECRET, payload_b64url 문자열)`의 소문자 hex. 비밀값은 양쪽 모두 앞뒤 공백을 지운 값.
- 시간: 다힘은 `exp = 지금 + 300초`. 읽기 서버는 `exp`가 지금보다 330초 넘게 뒤면 거절, `exp + 60초`가 지나면 거절(시계 차이 허용).
- 한 번만: 난수 `n`은 `exp + 60초`까지 `sso_nonces`에 남아 같은 토큰을 다시 쓰지 못하게 합니다. 토큰 자체는 어디에도 저장·기록하지 않습니다.
- 개인정보(이름 등)는 넣지 않습니다.
- `next` 허용 목록(정확히 이 모양만): `/children.html`, `/children.html?student=<숫자>`, `/read.html?child=<숫자>`. 그 밖의 값은 역할 기본값.
  학생은 항상 `/read.html?child=<자기 아이>`, 선생님·원장 토큰에 `sid`가 있으면 `/children.html?student=<sid>`.

## 3. 설정 (환경변수, `.env`)
| 이름 | 뜻 |
|---|---|
| `SSO_SECRET` | 다힘의 `DAHIM_READING_SECRET`과 같은 값. 32자 이상. 없거나 짧거나 `change-me...` 그대로면 SSO 꺼짐(`/sso`가 503) |
| `ACADEMY_URL` | 다힘 사이트 주소(http/https). 안내 페이지 버튼, 첫 화면 버튼, 로그아웃(`/academy`)이 이리로 감 |
| `ALLOW_PASSWORD_LOGIN` | `1`일 때만 예전 비밀번호 로그인·초대·재설정이 열림(비상용). 기본 꺼짐 |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | `ALLOW_PASSWORD_LOGIN=1`이고 사용자가 없을 때만 첫 관리자 생성 |

## 4. 계정과 세션
- 원장 → `users.role = 'admin'`, `external_id = "director:admin"`. 선생님 → `role = 'teacher'`, `external_id = "teacher:12"`.
  처음 들어올 때 자동으로 만들어지고(감사 기록 `user.provision`), 두 번째부터는 같은 계정을 씁니다.
  이메일 칸은 `teacher-12@sso.invalid` 같은 자리표시 값, 비밀번호는 쓸 수 없는 값(`!sso`)이라 비밀번호 로그인으로는 열 수 없습니다.
- 세션은 기존 `auth_sessions` + `sid` 쿠키(HttpOnly, SameSite=Lax, 테스트 밖에서는 Secure), 12시간.
- 관리자 화면(API `/api/admin/teachers`)에서 계정을 비활성화하면 `/sso`도 거절됩니다(비밀번호 로그인과 똑같이).
- 학생 세션은 **별도 표** `student_sessions`에 둡니다: 쿠키 값의 sha256, 아이 id, 학생 번호, 만료(2시간).
  `auth_sessions`는 언제나 `users` 행으로만 이어지므로 학생 쿠키가 선생님 세션으로 받아들여질 길이 구조적으로 없습니다.
  아이의 학생 번호가 바뀌거나 지워지면 그 학생 세션은 즉시 무효입니다.
- `/sso`는 새 세션을 열기 전에 들고 온 옛 쿠키의 세션을 지웁니다(세션 고정 방지). `POST /api/logout`은 세션과 쿠키를 지우고 `{ ok, next: "/academy" }`를 돌려줍니다.

## 5. 볼 수 있는 범위 (가정 포함)
- **원장(`users.role = 'admin'`)은 모든 아이를 보고 관리합니다.** 예전의 "관리자도 예외 없음" 규칙을 원장 역할에 한해 일부러 완화한 것입니다(아래 가정 1).
  목록·상세·측정 기록·추이·CSV·메모·다시 분석·공유 링크·삭제 모두 해당. 아이 JSON에 `teacherId`(담당자)가 원장에게만 보입니다.
- 선생님은 자기가 맡은(만든) 아이만 봅니다(변경 없음). 남의 아이는 언제나 같은 404.
- 원장이 다른 사람 담당 아이에 쓰기를 하면 모두 감사 기록 `director.cross_write`(대상, 동작, 원래 담당자)가 남습니다.
  담당자 바꾸기 `PATCH /api/children/:id {teacherId}`는 원장만 할 수 있고 `child.reassign`으로 기록됩니다.
- 학생은 자기 아이의 측정만 합니다: `GET /api/me`, 자기 학년대의 `GET /api/passages`, `POST /api/children/<자기 아이>/sessions`(응답은 id만, 점수 없음),
  `POST /api/logout`, 그리고 `/read.html`과 그 파일들. 그 밖의 모든 API는 403/404이고 데이터가 없습니다. 다른 화면(.html)을 열면 자기 측정 화면으로 돌려보냅니다.
  동의일이 없는 아이는 기존 동의 필요 화면이 나오고 업로드는 403입니다.
- 아이와 다힘 학생 연결: `externalStudentId`(최대 32자, 앞뒤 공백 제거, 전체 아이 중 하나만). 중복이면 409 "이미 등록된 학생입니다". 학생 이름은 저장하지 않습니다.

## 6. 가정 (원장님께 확인 필요)
1. 원장은 모든 선생님의 아이를 봐야 한다(원장 역할에 한한 완화, 시험으로 양쪽을 확인).
2. 다힘의 원장 세션에는 원장을 구별하는 번호가 없어 `uid = "admin"` 하나로 둡니다. 원장 계정이 여럿이어도 읽기 시선 기록에서는 같은 원장 계정입니다.
3. 다힘 학생 번호는 4자리 숫자("0123")입니다. 읽기 서버는 4~12자리 숫자를 받습니다.
4. 다힘 세션 변수 이름과 `drs_scope()`/`drs_ok()`의 뜻은 다힘 코드를 읽어 확인했고 실제로 실행해 보지는 않았습니다.
5. 학생 세션 2시간, 원장·선생님 세션 12시간이면 충분합니다.
6. 선생님이 학생 화면에서 "측정"으로 올 때, 다힘 쪽에서 맡은 반을 확인할 수 없으면(함수 없음) 들여보내지 않습니다.

## 7. 비상 로그인 (break-glass)
다힘 사이트가 고장 났거나 비밀값이 어긋났을 때만:
1. 서버 `.env`에 `ALLOW_PASSWORD_LOGIN=1` → `docker compose up -d`.
2. `/login.html`에서 비밀번호 계정으로 로그인합니다. 계정이 없으면 `ADMIN_EMAIL`/`ADMIN_PASSWORD`(사용자가 하나도 없을 때만) 또는
   CLI로 비밀번호를 정합니다: `printf %s "$PW" | docker exec -i dahim-reading node server/admin-cli.js set-password <email>`
   (SSO로 만들어진 계정도 이메일 칸 `teacher-12@sso.invalid`로 지정 가능).
3. 일이 끝나면 `ALLOW_PASSWORD_LOGIN=0`으로 되돌리고 재시작합니다. 꺼져 있으면 `/api/login`, `/api/invites/*`, `/api/password-reset/*`,
   `/api/admin/invites*`, `/api/admin/teachers/:id/reset-link`, `/login.html`, `/invite.html`, `/reset.html`은 모두 404입니다.

## 8. 비밀값 교체
`deploy/academy-site/README.md`의 "비밀값 바꾸기"를 따릅니다. 요약: 새 값 생성 → 읽기 서버 `SSO_SECRET` 바꾸고 재시작 → 다힘 `DAHIM_READING_SECRET` 바꿈 → 확인.
이미 열린 세션은 유지되므로, 즉시 끊으려면 관리자 API로 계정을 비활성화합니다.

## 9. 문제 해결
| 증상 | 확인 |
|---|---|
| 늘 "다힘 사이트에서 다시 들어와 주세요" | 두 서버의 비밀값이 같은가, 두 서버 시계 차이가 1분 미만인가(`date -u`), 주소를 복사해 두 번 열지 않았는가(한 번용) |
| 503과 같은 안내 페이지 | 읽기 서버 `SSO_SECRET`이 없거나 32자 미만이거나 `change-me...` 그대로. 서버 시작 로그에 경고가 나옵니다(값은 찍지 않음) |
| 학생이 "아직 측정 대상으로 등록되지 않았어요" | 선생님이 아이 목록에서 그 학생 번호로 "측정 대상으로 등록"했는가(또는 아이의 `externalStudentId`) |
| 학생이 "측정을 시작할 수 없습니다" | 보호자 동의일이 없습니다. 선생님이 아이 목록에서 동의일을 넣습니다 |
| 선생님이 "맡은 반 학생만 측정할 수 있어요." | 다힘에서 그 학생이 그 선생님 반인지, `READING_SCOPE_LIB` 경로가 맞는지 |
| 특정 선생님만 못 들어옴 | 관리자 API에서 그 계정이 비활성화되어 있지 않은가(`externalId`로 찾기) |

토큰과 비밀값은 어떤 응답·로그·DB에도 남지 않습니다(시험 `tests/sso.test.js`가 DB 덤프·응답·로그를 검사). 브라우저 방문 기록에는 `/sso?t=...` 주소가 남을 수 있지만 한 번 쓰였고 5분 안에 만료됩니다.
