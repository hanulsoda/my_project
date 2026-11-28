# 기존 nginx 뒤에 reading.dahim.kr 올리기 (Oracle 서버용)

이 폴더는 서버에 **이미 nginx가 80/443을 쓰고 있을 때** 쓰는 방식입니다. `docs/deploy.md`의 Caddy 구성은 독립 서버용이라 이 서버에는 쓰지 않습니다.
서버에서 확인된 사실은 `docs/oracle-server.md`를 보세요. 아래 절차는 그 문서와 같은 전제를 씁니다.

> **경고 (2026-11-28): 4번에서 `nginx -s reload`를 쓰지 마세요.** 이 서버에서 같은 변경을 reload했을 때 https가 TLS 협상 중에 전부 끊겨 기존 사이트가 약 3분 멈췄습니다(원인 미확인). 같은 설정을 **새로 시작한** nginx(시험 컨테이너)에 적용하면 정상이었고, 시험 컨테이너에서 reload를 재현해도 문제가 없었습니다. 그래서 운영에는 컨테이너 **재시작 + 자동 원복** 스크립트(`apply-nginx-block.sh`)로 적용했고 성공했습니다.
> `nginx -t` 통과만으로는 안전하다고 볼 수 없습니다.

상태: 이 절차는 **아직 서버에서 실행해 보지 않았습니다.** 확인한 것은 compose 문법(`docker compose config`)과 nginx 설정 문법(`nginx -t`, 아래)뿐입니다.

## 반드시 지킬 것
- `/opt/dahim/enable_ssl.sh`를 **다시 실행하지 마세요.** 이 스크립트는 `default.conf`를 처음의 짧은 설정으로 **덮어씁니다.** 지금 파일에는 그 뒤에 추가된 설정(trainer, 학원 사이트 연결 등)이 있습니다.
- `default.conf`는 컨테이너에 파일 하나로 연결되어 있습니다. `sed -i`나 에디터의 "다른 이름으로 저장"처럼 파일을 새로 만드는 방식으로 고치면 컨테이너가 옛 파일을 봅니다. 아래처럼 `>>`(덧붙이기)나 `cat … >`(덮어쓰기)만 쓰세요.
- `nginx -t`가 성공하기 전에는 `reload`하지 마세요. 실패하면 아래 "되돌리기"를 먼저 합니다.
- 비밀번호는 채팅이나 저장소에 올리지 마세요. `.env`는 서버에만 둡니다.

## 0. 준비
1. **Cloudflare** DNS(dahim.kr 영역)에서 A 레코드를 추가합니다: 이름 `reading`, 값 서버 공인 IP.
   - **프록시 상태는 "DNS 전용"(회색 구름)으로 시작하세요.** 인증서 발급과 첫 확인이 가장 단순합니다. 기존 `app` 레코드가 어떻게 되어 있는지 Cloudflare 화면에서 보고 같은 방식으로 맞추세요.
   - 나중에 "프록시됨"(주황 구름)으로 바꾸려면 Cloudflare의 SSL/TLS 모드를 **Full (strict)** 로 해야 합니다. "Flexible"이면 Cloudflare가 서버에 http로 접속하고, 서버가 https로 되돌려 보내서 무한 리다이렉트가 납니다.
   - 서버에서 `getent hosts reading.dahim.kr`로 그 IP가 나오는지 확인합니다(주황 구름이면 서버 IP가 아니라 Cloudflare 주소가 나옵니다. 인증서 발급은 회색 구름일 때 하세요).

## 1. 코드 받기와 `.env`
```bash
sudo mkdir -p /opt/dahim-reading && sudo chown ubuntu:ubuntu /opt/dahim-reading
git clone --branch ccr-d047b660-c42kqg --depth 1 https://github.com/hanulsoda/my_project.git /opt/dahim-reading/src
cd /opt/dahim-reading/src/eye-tracker
cp .env.example .env && chmod 600 .env
nano .env     # ADMIN_EMAIL, ADMIN_PASSWORD 수정. 비밀번호는 작은따옴표로 감싸고 $ # " 는 피하세요.
```

## 2. 컨테이너 빌드와 기동 (아직 nginx는 건드리지 않음)
```bash
cd /opt/dahim-reading/src/eye-tracker/deploy/oracle-shared-nginx
docker compose up -d --build
docker compose ps                      # dahim-reading 이 healthy 인지 (첫 빌드는 몇 분 걸릴 수 있음)
docker exec dahim-nginx wget -S -qO- http://dahim-reading:3000/api/me 2>&1 | head -5   # HTTP/1.1 401 이면 nginx 컨테이너에서 연결 확인 완료
```

## 3. 인증서 발급 (기존과 같은 certbot 폴더, webroot 방식)
DNS가 서버로 연결된 뒤에 합니다. 80번 포트의 기본 서버가 인증 확인 경로를 이미 처리합니다.
```bash
docker run --rm \
  -v /opt/dahim/certbot/conf:/etc/letsencrypt \
  -v /opt/dahim/certbot/www:/var/www/certbot \
  certbot/certbot certonly --webroot -w /var/www/certbot \
  -d reading.dahim.kr --email admin@dahim.kr --agree-tos --no-eff-email
```
기존 주간 갱신 작업(cron의 `certbot renew`)이 이 인증서도 함께 갱신합니다.

## 4. nginx에 reading.dahim.kr 연결 (reload 대신 재시작 + 자동 원복)
```bash
BAK=/opt/dahim/nginx/default.conf.bak_$(date +%Y%m%d_%H%M)
cp /opt/dahim/nginx/default.conf "$BAK"                          # 백업
BAK="$BAK" /opt/dahim-reading/src/eye-tracker/deploy/oracle-shared-nginx/apply-nginx-block.sh
# 덧붙임 → nginx -t → 컨테이너 재시작 → app/reading 응답 확인 → 실패하면 자동 원복
```

## 5. 확인
- 서버: `curl -sI https://reading.dahim.kr/ | head -5`
- 브라우저: `https://reading.dahim.kr` 에서 로그인 화면 → 관리자 계정으로 로그인 → 아이 등록 → 측정(카메라 허용)
- 기존 사이트가 그대로인지: `https://app.dahim.kr` 도 열어 봅니다.

## 되돌리기
```bash
# nginx: 백업으로 복원 (cp/>> 로 같은 파일 위에 덮어쓰기)
cat /opt/dahim/nginx/default.conf.bak_YYYYMMDD_HHMM > /opt/dahim/nginx/default.conf
docker exec dahim-nginx nginx -t && docker exec dahim-nginx nginx -s reload
# 프로그램만 내리기 (데이터 볼륨은 남음)
cd /opt/dahim-reading/src/eye-tracker/deploy/oracle-shared-nginx && docker compose down
```

## 이 방식에서 확인된 것 / 안 된 것
- 확인: compose 문법, 추가할 nginx 블록의 문법(`nginx:1.27-alpine`, 임시 인증서). 그리고 컨테이너가 없어도 `nginx -t`가 통과하는 것(이름을 변수로 푸는 방식) — 변수 없이 고정 이름을 쓰면 `host not found in upstream`으로 실패하는 것도 같이 확인함.
- 확인 안 됨: 서버의 ARM(aarch64)에서의 빌드, 서버의 실제 `default.conf`와의 합쳐짐, 인증서 발급, 실제 카메라 동작.
- 백업: 기존 `backup_db.sh`는 MariaDB용입니다. 이 프로그램의 SQLite는 도커 볼륨 `dahim-reading_reading-data`에 있고, 별도 백업이 필요합니다(`docs/deploy.md`의 백업 절차 참고).

## 운영 (서버에서 한 번씩 실행)

### 데이터 백업 (매일 04:10)
이 프로그램의 데이터(아이, 측정 기록, 시선 좌표)는 SQLite 파일 하나입니다. 기존 `backup_db.sh`는 MariaDB만 백업하므로 따로 필요합니다.
```bash
mkdir -p /opt/dahim-reading/backups
(crontab -l 2>/dev/null; echo '10 4 * * * /opt/dahim-reading/src/eye-tracker/deploy/oracle-shared-nginx/backup-reading-db.sh >> /opt/dahim-reading/backups/backup.log 2>&1') | crontab -
# 지금 한 번 실행해서 확인
/opt/dahim-reading/src/eye-tracker/deploy/oracle-shared-nginx/backup-reading-db.sh && ls -la /opt/dahim-reading/backups
```
SQLite 온라인 백업 방식이라 프로그램이 쓰는 중에도 일관된 복사본이 만들어지고(WAL에 있는 내용 포함, 무결성 검사 `ok`일 때만 저장), 최근 14개만 남깁니다. 복원은 컨테이너를 멈춘 뒤 백업 파일을 `dahim-reading_reading-data` 볼륨의 `app.db`로 복사합니다. **복원 절차는 서버에서 시험해 보지 않았습니다.**

### 인증서 갱신 작업의 reload를 restart로 (월요일 03:00 전에)
`/opt/dahim/enable_ssl.sh`가 등록한 주간 갱신 작업은 끝에 `nginx -s reload`를 실행합니다. 이 서버에서 reload가 한 번 TLS를 끊은 적이 있어서(원인 미확인), 확인된 방식인 컨테이너 재시작으로 바꿉니다.
```bash
/opt/dahim-reading/src/eye-tracker/deploy/oracle-shared-nginx/fix-renewal-cron.sh
```
실행하기 전 crontab을 `~/crontab.bak_날짜`에 백업하고, 바뀐 줄을 보여 줍니다. 되돌리려면 `crontab ~/crontab.bak_날짜`.
