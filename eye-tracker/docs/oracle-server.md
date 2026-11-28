# Oracle 서버 확인 기록 (읽기 시선 추적 배포용)

작성: 2026-11-28 · 이 문서는 사용자가 보여 준 화면과 터미널 결과만 근거로 합니다. 추측은 "확인 안 됨"으로 따로 적었습니다.
앞으로 서버 작업은 이 문서와 어긋나면 안 됩니다. 어긋나는 내용이 생기면 먼저 이 문서를 고칩니다.

## 1. 확인된 사실

| 항목 | 값 | 근거 |
|---|---|---|
| 서버 이름 | `dahim-tokyo-a1` (Oracle Cloud, 리전 Japan East / Tokyo, 상태 Running) | 사용자 Oracle 콘솔 화면 |
| 퍼블릭 IP | `129.203.151.34` (내부 IP `10.0.0.17`) | 콘솔 화면 |
| 구성 | VM.Standard.A1.Flex, 2 OCPU, 메모리 12GB (ARM) | 콘솔 화면, `uname -m` = `aarch64` |
| 운영체제 | Ubuntu 24.04.5 LTS | 서버에서 `cat /etc/os-release` |
| 접속 계정 | **`ubuntu`** (`opc`는 거부됨: "Please login as the user ubuntu") | 접속 시도 결과 |
| 접속 키 | 사용자 PC의 `C:\Users\mouse\.ssh\dahim_oci_tokyo` (이름만 기록, 내용은 어디에도 붙이지 않음) | 접속 성공 |
| 접속 명령 | `ssh -i "$HOME\.ssh\dahim_oci_tokyo" ubuntu@129.203.151.34` | 사용자 PowerShell에서 성공 |
| Docker | 29.10.0 설치됨 | 서버 출력 |
| 디스크 / 메모리 | `/` 96GB 중 23GB 사용(74GB 여유), 메모리 약 9.8GB 사용 가능 | `df`, `free` |
| 80/443 포트 | **이미 도커 컨테이너 `dahim-nginx`가 사용 중** | `ss`, `docker ps` |

### 서버에서 이미 돌고 있는 시스템 (`/opt/dahim`, 도커 compose 프로젝트 `dahim`)
- 컨테이너: `dahim-nginx`(nginx:1.27-alpine, 80/443 공개), `dahim-php`, `dahim-python-api`, `dahim-attendance`, `dahim-trainer`, `dahim-redis`, `dahim-db`(MariaDB 10.11)
- 모두 같은 도커 네트워크 `dahim_dahim_net`에 있음. nginx만 외부 포트를 공개하고 나머지는 내부 포트만 가짐.
- 실행 기간: nginx 4일, attendance 2일, trainer 3일 (운영 중인 서비스로 취급한다).

### nginx와 인증서 (사용자 터미널 출력, 2026-11-28)
- 서버 폴더 `/opt/dahim`: `docker-compose.yml`, `nginx/default.conf`, `certbot/`(`conf`, `www`), `web/`, `php/`, `python_api/`, `attendance/`, `trainer/`, `db_data/`, `backups/`, 운영 스크립트(`backup_db.sh`, `enable_ssl.sh`, `health_watchdog.sh` 등)가 있다.
- `dahim-nginx`는 설정 파일 **한 개**(`/opt/dahim/nginx/default.conf` → 컨테이너의 `/etc/nginx/conf.d/default.conf`)만 직접 연결해서 쓴다. 인증서 폴더는 `/opt/dahim/certbot/conf` → `/etc/letsencrypt`, 인증 확인용 폴더는 `/opt/dahim/certbot/www` → `/var/www/certbot`.
- 설정에 이미 있는 서버 이름은 **`app.dahim.kr`** (80번 블록과 443 블록, 인증서 `/etc/letsencrypt/live/app.dahim.kr/`). 출력은 처음 60줄까지만 확인했으므로 다른 이름이 더 있는지는 확인 안 됨.
- 서버 호스트의 `/etc/letsencrypt`는 없고 `certbot`이 서버에 설치되어 있지 않다. 인증서는 `/opt/dahim/certbot`을 통해 도커 쪽에서 관리하는 것으로 보이지만, 발급·갱신 방식(`enable_ssl.sh`, compose의 certbot 서비스)은 아직 읽지 않았다.
- 인증서는 `docker run certbot/certbot certonly --webroot`(웹루트 `/opt/dahim/certbot/www`, 설정 `/opt/dahim/certbot/conf`)로 발급하고, 주간 cron(`certbot renew`)이 갱신한다(`/opt/dahim/enable_ssl.sh` 내용으로 확인). 이메일 `admin@dahim.kr`.
- **`enable_ssl.sh`를 다시 실행하면 안 된다.** 이 스크립트는 `default.conf`를 처음의 짧은 설정으로 덮어쓰고, 지금 파일에는 그 뒤에 추가된 설정이 있다.
- 80번 포트의 첫 서버 블록(`app.dahim.kr`)이 인증 확인 경로(`/.well-known/acme-challenge/`)를 `/var/www/certbot`에서 처리하고 나머지는 https로 보낸다. 다른 이름의 80번 요청도 이 블록이 받는다.
- 사용자가 말한 "메뉴의 부주소"는 이 서버에서 확인된 이름으로는 `app.dahim.kr`일 가능성이 높다(확정 아님).

### 도메인 관련
- `dahim.kr`은 Hostinger(`156.67.211.48`)를 가리킴(서버에서 이름 조회로 확인). 이 서버는 Oracle 서버와 **다른 서버**입니다.
- **DNS는 Hostinger가 아니라 Cloudflare에서 관리한다**(사용자 말씀, 2026-11-28). 앞서 Hostinger에서 하라고 안내한 것은 틀렸다. 이 Cloudflare 영역의 레코드 목록은 아직 보지 못했다.
- `reading.dahim.kr`은 2026-11-28 현재 어디에도 연결되어 있지 않음(이름 조회 결과 없음).
- Cloudflare DNS 화면(사용자 캡처, 2026-11-28): `app.dahim.kr` A `129.203.151.34`, `reading.dahim.kr` A `129.203.151.34`, `dahim.kr` A `156.67.211.48`, 모두 "DNS only"(회색 구름). 메일용 CNAME(`autoconfig`, `autodiscover`)은 Hostinger 메일을 가리킨다. 영역 전체 30개 레코드 중 위 5개만 화면에 보였다.
- 이 작업 환경에서는 `app.dahim.kr`·`reading.dahim.kr`의 이름 조회가 되지 않았다(캡처에는 레코드가 있음). 조회 환경의 한계일 수 있어, 전파 확인은 서버에서 한다.
- 코드 저장소들에서 확인되는 부주소는 `z840.dahim.kr`(음성 합성/인식 호출) 하나뿐입니다. 이것이 Oracle 서버와 연결된 것인지는 확인 안 됨.

## 2. 확인 안 됨 (추측으로 진행하지 않는다)
- `reading.dahim.kr` 인증서가 실제로 발급되는지(DNS 연결 전이라 시도하지 않음)
- `default.conf`에 서버 이름이 `app.dahim.kr` 말고 더 있는지(처음 60줄만 확인), 80번 블록 앞쪽에 다른 `listen 80` 블록이 있는지
- 어떤 부주소가 이미 이 서버로 연결되어 있는지(`app.dahim.kr` 외)
- Oracle 보안 목록(Security List)에 80/443 수신 규칙이 어떻게 되어 있는지 (이미 80/443으로 서비스 중이면 열려 있을 가능성이 크지만 직접 보지 않았음)
- ARM(aarch64)에서 이 프로그램의 도커 이미지 빌드가 되는지(이 프로젝트는 ARM에서 빌드해 본 적 없음)
- 실제 웹캠으로 본 시선 정확도

## 3. 결정한 방침
1. **기존 `/opt/dahim` 시스템과 그 컨테이너는 수정하지 않는다.** 단, `reading.dahim.kr`을 받기 위한 nginx 설정 추가는 필요하며, 이것만이 기존 시스템에 가하는 변경이다. 변경 전에 해당 파일을 백업하고, 사용자 확인 뒤에 한다.
2. nginx는 설정 파일 하나를 직접 연결해 쓰므로 `sed -i`처럼 파일을 새로 만드는 방식으로 고치면 컨테이너가 옛 파일을 보게 된다. 변경은 파일 내용을 덮어쓰는 방식(`cat`/`tee`)으로 하고, 변경 전 백업 → `docker exec dahim-nginx nginx -t` 통과 → 사용자 확인 → `nginx -s reload` 순서를 지킨다.
3. 이 프로그램(eye-tracker)은 **별도 compose 프로젝트**(별도 폴더)로 올리고, 기존 `dahim_dahim_net`에 붙여서 `dahim-nginx`가 `reading.dahim.kr` 요청을 넘기게 한다.
4. 이 서버에서는 **우리 묶음의 Caddy를 쓰지 않는다.** 80/443은 이미 `dahim-nginx`가 사용 중이라 같이 띄우면 충돌한다.
5. 접속 비밀키, 비밀번호, `.env`의 관리자 비밀번호는 채팅이나 저장소에 올리지 않는다.

## 4. 현재 상태 (거짓 없이)
- 서버에는 **아무것도 설치하거나 변경하지 않았다.** 지금까지는 읽기 전용 명령만 실행했다.
- 코드는 GitHub `hanulsoda/my_project`의 `ccr-d047b660-c42kqg` 브랜치와 PR #2(초안)에 있다. "서버에 올렸다"고 한 것은 GitHub를 뜻했고 Oracle 서버가 아니다.
- 저장소의 `docs/deploy.md`는 **이 서버와 맞지 않는 가정**을 담고 있다: Oracle Linux/`opc` 계정, 서버 안에 Caddy를 함께 띄우는 구조. 실제는 Ubuntu 24.04/`ubuntu` 계정, 기존 nginx 사용. 이 서버용 절차는 nginx 설정을 확인한 뒤 새로 쓴다.
- Cloudflare DNS의 `reading` A 레코드는 만들어져 있다(`129.203.151.34`, DNS only). 서버에서 이름이 실제로 풀리는지는 아직 확인하지 않았다.

## 5. 다음 단계 (순서)
1. (완료) nginx 설정 위치와 인증서 방식 확인.
2. (완료) 이 서버용 파일 작성: `deploy/oracle-shared-nginx/`(compose, nginx 블록, 절차 README). 서버에서는 실행해 보지 않음.
3. [사용자] **Cloudflare**에서 A 레코드 `reading` → `129.203.151.34`(DNS 전용)를 추가하고, `getent hosts reading.dahim.kr`로 확인한다.
4. [사용자 확인 후 진행] 서버에 코드를 내려받아 컨테이너를 빌드·기동하고, nginx 설정을 추가한다(변경 전 백업).
5. [사용자] 실제 아이/기기로 정확도 점검 페이지를 돌려 품질 기준(0.6)을 정한다.

## 6. 하지 않는 것
- 확인하지 않은 값을 사실처럼 쓰지 않는다.
- 운영 중인 컨테이너(`dahim-*`)를 중지·재시작·삭제하지 않는다. nginx 설정을 다시 읽게 하는 일(reload)은 설정 검사(`nginx -t`) 통과 뒤에 사용자 확인을 받고 한다.

## 7. 진행 기록 (2026-11-28, 서버 시각 기준)
- 11:34 `/opt/dahim-reading/src`에 코드 받기, `.env` 생성(권한 600).
- `docker compose up -d --build`: 처음에는 `data/passages.json` 누락으로 실패(저장소의 `data/` 무시 규칙 때문). 파일을 추가해 다시 빌드해 성공. ARM에서 빌드 통과. 컨테이너 `dahim-reading` healthy, 첫 관리자 계정 생성됨, nginx 컨테이너에서 `http://dahim-reading:3000/api/me` → 401 확인.
- 인증서 `reading.dahim.kr` 발급 성공(만료 2027-02-26). 기존 주간 갱신 cron(`certbot renew`) 등록 확인.
- `/opt/dahim/nginx/default.conf` 백업(`default.conf.bak_20261128_1140`) → `reading.nginx.conf` 덧붙임 → `nginx -t` 성공 → reload.
- **장애:** reload 직후 https가 전부 TLS 협상 중에 끊김. `app.dahim.kr` 포함. 출석 화면(Edge 브라우저)의 5초 주기 요청이 02:41:24에 멈춰 02:44:19에 재개됨(약 3분). 백업으로 되돌려 `nginx -t` 후 reload하자 즉시 복구(TLSv1.3, 인증서 `CN = app.dahim.kr`, 요청 재개).
- 조사: 우리 블록을 덧붙인 설정을 **새로 시작한** 시험 컨테이너(loopback 8443, 운영과 같은 `nginx.conf`·마운트·이미지)에서 돌리면 `app`/`reading` 모두 TLSv1.3 정상. 시험 컨테이너에서 "원래 설정 시작 → 블록 덧붙임 → reload"를 재현해도 정상. 운영 컨테이너의 설정 파일 해시/inode는 호스트와 같고 이미지도 같고 인증서 폴더도 보임. **운영에서만 reload가 깨진 원인은 미확인.**
- 02:50경 서버 시각 기준 적용 방식 변경: reload 대신 **`docker restart dahim-nginx` + 자동 원복 스크립트**(`deploy/oracle-shared-nginx/apply-nginx-block.sh`). 결과: 재시작 2초 후 `app=200`, `reading=200`, 자동 원복은 동작하지 않음. 이 시점부터 `/opt/dahim/nginx/default.conf`에는 `reading.dahim.kr` 블록이 들어 있다(백업은 `default.conf.bak_20261128_1140`, 적용 직전 사본 `default.conf.pre_reading_*`).
- 남은 위험(미확인): 기존 주간 갱신 cron이 갱신 뒤 `docker exec dahim-nginx nginx -s reload`를 실행한다(`enable_ssl.sh`가 등록). **reload가 운영에서 깨질 수 있는 원인이 미확인이므로, 다음 cron 실행(월요일 03:00, 서버 시간대)에서 같은 장애가 재발할 수 있다.** reload만 단독으로 실행했을 때(설정 변경 없이) 문제가 있는지는 확인하지 않았다.
