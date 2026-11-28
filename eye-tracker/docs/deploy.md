# 배포 안내서 (reading.dahim.kr)

## 이 저장소에서 하지 않은 것

**실제 Oracle VM 배포는 하지 않았습니다.** VM 접속 정보가 없어서 이 저장소는 `docker compose up -d` 한 번으로 뜨는 묶음과 이 안내서까지만 담습니다. DNS 등록, Oracle 네트워크 설정, Let's Encrypt 인증서 발급은 아직 아무도 해 본 적이 없습니다 (아래 "확인한 범위" 참고).

## 1. 준비물

- Oracle Cloud VM 한 대 (Ubuntu 또는 Oracle Linux), 고정 공용 IP 권장. 이 문서에서는 `<VM_PUBLIC_IP>`로 씁니다.
- VM에 Docker Engine + compose 플러그인. `docker compose version`이 나오면 됩니다. 설치는 Docker 공식 문서(docs.docker.com/engine/install)를 따르세요.
- `dahim.kr` DNS를 고칠 수 있는 권한.

## 2. 포트 열기: TCP 80, 443

Let's Encrypt 인증과 https 서비스에 **80과 443 둘 다** 인터넷에서 들어올 수 있어야 합니다. 앱 포트 3000은 열지 않습니다 (컨테이너 안에서만 쓰입니다).

1. **Oracle 콘솔**: VM이 속한 서브넷의 Security List(또는 VM에 붙인 NSG)에 인그레스 규칙 두 개를 추가합니다. Source `0.0.0.0/0`, 프로토콜 TCP, 목적지 포트 `80`과 `443`.
2. **VM 안의 방화벽**:
   - Oracle Linux (firewalld): `sudo firewall-cmd --permanent --add-port=80/tcp --add-port=443/tcp && sudo firewall-cmd --reload`
   - Ubuntu + ufw가 켜진 경우: `sudo ufw allow 80/tcp && sudo ufw allow 443/tcp`
   - Oracle의 Ubuntu 이미지는 iptables에 22번만 허용하고 나머지를 REJECT하는 규칙이 들어 있는 경우가 있습니다. `sudo iptables -L INPUT -n --line-numbers`로 REJECT 줄 번호 `<N>`을 확인한 뒤 그 앞에 넣고 저장합니다: `sudo iptables -I INPUT <N> -p tcp --dport 80 -j ACCEPT`, 443도 같게, 저장은 `sudo netfilter-persistent save`. (Docker가 게시한 포트는 INPUT 규칙을 거치지 않는 경우도 있어서, 위 규칙 없이도 열려 보일 수 있습니다. 안 열리면 이 단계를 의심하세요.)

## 3. DNS A 레코드

`dahim.kr` DNS 관리 화면에서 A 레코드를 추가합니다.

| 호스트 | 타입 | 값 | TTL |
| --- | --- | --- | --- |
| `reading` (= `reading.dahim.kr`) | A | `<VM_PUBLIC_IP>` | 300 |

**첫 기동 전에** 공개 DNS에서 이미 보이는지 확인합니다. 값이 `<VM_PUBLIC_IP>`로 나올 때까지 기다리세요.

```bash
dig +short reading.dahim.kr A
dig +short reading.dahim.kr A @1.1.1.1   # 내 DNS 캐시가 아닌 공개 DNS 기준
```

아직 안 보이는데 기동하면 Caddy의 인증서 발급이 실패하고 재시도하며, Let's Encrypt는 실패가 반복되면 잠시 발급을 막습니다. AAAA(IPv6) 레코드는 VM에서 IPv6가 실제로 열려 있을 때만 추가하세요.

## 4. 설정과 첫 기동

```bash
git clone <REPO_URL> reading && cd reading
cp .env.example .env && chmod 600 .env
nano .env        # ADMIN_EMAIL, ADMIN_PASSWORD를 실제 값으로 (비밀번호 8자 이상, 긴 문장 권장)
                 # ADMIN_PASSWORD는 작은따옴표로 감싸세요: ADMIN_PASSWORD='내 비밀번호'
docker compose up -d --build
docker compose ps                  # app은 (healthy), caddy는 Up
docker compose logs -f caddy       # "certificate obtained successfully"가 나오면 인증서 발급 완료
```

`.env`는 Git에 올리지 않습니다 (`.gitignore`에 있음). `DB_PATH`와 `NODE_ENV`는 `.env.example` 값을 그대로 두세요. (`DB_PATH`를 빼먹어도 이미지 기본값이 볼륨 경로라 DB가 컨테이너 안에 갇히지는 않습니다.)

**`ADMIN_PASSWORD`의 특수문자 함정**: docker compose는 `.env`/`env_file` 값을 읽을 때 따옴표 없는 `$`, `#`, `"`, `'`를 해석합니다. 예를 들어 `pa$word`는 `$word`가 빈 값으로 바뀌고, `abc #1`은 `#` 뒤가 주석으로 잘립니다. **오류 없이 다른 비밀번호가 만들어져** 관리자가 잠깁니다. 값 전체를 **작은따옴표**로 감싸거나(`ADMIN_PASSWORD='...'`, 작은따옴표 자체는 쓸 수 없음) 이 네 문자(`$ # " '`)를 아예 쓰지 마세요. 그리고 **첫 기동 직후 바로 로그인해서 확인**하세요. 안 되면 아래 비밀번호 재설정으로 고칩니다.

브라우저에서 `https://reading.dahim.kr`를 열어 `ADMIN_EMAIL`/`ADMIN_PASSWORD`로 로그인합니다.

- `ADMIN_*`는 **DB에 사용자가 아직 없을 때만** 첫 관리자를 만드는 데 쓰입니다. 이후 `.env`의 비밀번호를 바꿔도 계정에는 영향이 없습니다. 비밀번호 재설정은 아래 "계정 관리"의 명령줄(CLI)로만 할 수 있고, 웹 화면은 없습니다.
- 첫 로그인 후에는 `.env`에서 `ADMIN_PASSWORD` 줄을 지우고 `docker compose up -d`로 다시 반영해도 됩니다.

## 5. 선생님 계정 만들기

관리자로 로그인하면 "아이 목록" 화면에 "선생님 초대 (관리자)" 칸이 보입니다. 선생님 이메일을 넣고 만든 초대 링크를 전달하세요 (7일 안에 한 번만 사용). 선생님이 링크에서 비밀번호를 정하면 로그인할 수 있습니다. 선생님은 자신이 등록한 아이만 봅니다.

### 계정 관리 (명령줄 전용, 웹 화면은 없습니다)

비밀번호를 잊은 선생님·관리자를 위해, 퇴직한 선생님을 막기 위해 `server/admin-cli.js`를 씁니다. 서버가 켜진 채로 실행해도 됩니다. 이메일은 대소문자를 구분하지 않습니다.

```bash
# 비밀번호 재설정: 새 비밀번호를 표준 입력(stdin)으로 넘깁니다 (명령줄 인자나 셸 기록에 남기지 않기 위해).
# 8~256자. 그 사람의 기존 로그인은 모두 끊깁니다. -T를 꼭 붙이세요.
read -rs NEWPW && printf '%s' "$NEWPW" | docker compose exec -T app node server/admin-cli.js set-password teacher@example.com; unset NEWPW

docker compose exec -T app node server/admin-cli.js list                       # 이메일, 역할, 비활성 여부 (해시는 출력하지 않음)
docker compose exec -T app node server/admin-cli.js disable teacher@example.com # 퇴직 등: 즉시 로그아웃, 로그인 불가. 아이 기록은 그대로 남음
docker compose exec -T app node server/admin-cli.js enable teacher@example.com  # 다시 활성화
```

- 없는 이메일이면 오류 메시지와 함께 0이 아닌 값으로 끝납니다.
- 마지막 남은 관리자는 `disable`되지 않습니다 (아무도 계정을 관리하지 못하게 되는 것을 막기 위해).
- 선생님이 비밀번호를 잊어 다시 초대하려 하면 "이미 계정이 있음"(409)이 나옵니다. 이때는 초대 대신 `set-password`를 쓰세요.
- 로그인은 같은 이메일로 15분 안에 10번 틀리면 잠시 막힙니다 (429, 서버 재시작 시 초기화).

## 6. 백업과 복원

데이터는 Docker 볼륨 `app-data`의 SQLite(`/app/data/db/app.db`) 하나입니다. 인증서(`caddy-data`)는 없어져도 다시 발급됩니다. 백업 파일에는 아이 기록이 그대로 들어 있으니 접근을 제한하세요.

```bash
mkdir -p backups
docker compose exec -T app node -e "require('better-sqlite3')('/app/data/db/app.db').backup('/tmp/backup.db').then(() => console.log('backup ok'))"
docker compose cp app:/tmp/backup.db ./backups/app-$(date +%F).db
docker compose exec -T app rm /tmp/backup.db
```

서버가 켜진 채로 해도 안전한 SQLite 온라인 백업입니다. VM이 사라지면 같이 사라지므로 `backups/` 파일은 VM 밖(내 PC 등)에 정기적으로 복사하세요.

복원 (앱을 멈추고 DB 파일을 바꾼 뒤 이전 WAL 파일을 지움):

```bash
docker compose stop app
docker compose cp ./backups/app-YYYY-MM-DD.db app:/app/data/db/app.db
docker compose run --rm --no-deps --user root --entrypoint sh app -c "chown node:node /app/data/db/app.db && rm -f /app/data/db/app.db-wal /app/data/db/app.db-shm"
docker compose start app
```

## 7. 업데이트

```bash
# 먼저 위 백업을 한 번 한다
git pull
docker compose up -d --build
docker image prune -f
```

볼륨은 그대로라 데이터는 유지됩니다. `docker compose down`은 컨테이너만 지웁니다. **`docker compose down -v`는 DB 볼륨까지 지우니 쓰지 마세요.**

## 8. 상태와 로그

```bash
docker compose ps
docker compose logs -f app            # 앱
docker compose logs --since 1h caddy  # 프록시, 인증서
docker compose restart app
```

## 9. 개인정보와 동의 운영

- 측정은 **보호자 종이 동의**를 받은 뒤 선생님이 아이 목록에서 "동의일"을 입력해야 시작됩니다. 동의일이 없으면 화면과 서버(HTTP 403) 모두 막습니다. 종이 동의서 원본은 이 시스템 밖에서 선생님이 보관합니다.
- 서버에 저장되는 것: 아이 코드·이니셜·학년군·동의일, 시선 좌표(`t,x,y`), 지문 단어 위치, 계산된 지표. 얼굴 영상은 저장하지도 전송하지도 않습니다 (브라우저 안에서만 처리).
- **아이 삭제** (아이 목록의 삭제 버튼)는 그 아이의 세션, 시선 좌표, 공유 링크를 모두 영구 삭제하며 되돌릴 수 없습니다. 동의 철회나 삭제 요청이 오면 이 방법을 씁니다.
- 이미 만들어 둔 **백업 파일에는 삭제된 아이의 기록이 남아 있습니다.** 백업 보관 기간을 정해 두고, 삭제 요청을 받으면 그 기간이 지난 뒤 이전 백업을 지우세요.
- 공유 링크는 기본 30일 뒤 만료되고 선생님이 언제든 폐기할 수 있으며, 리포트에는 실명 대신 코드·이니셜만 나옵니다.
- 이 문서는 법률 자문이 아닙니다. 개인정보 처리 방침과 고지 문구는 운영 기관이 따로 확인해야 합니다.

## 확인한 범위

로컬 Docker(Debian 기반 `node:22-slim`, x86_64)에서 확인한 것: 이미지 빌드와 `app` 헬스체크, 비root(uid 1000) 실행, Caddy를 거친 `https` 로그인 (쿠키 `Secure`·`HttpOnly`), gzip·보안 헤더·`camera=(self)`, 80→https 리다이렉트, 호스트에서 3000번 접근 불가, 위의 백업·복원 명령, `down` 후 `up`해도 데이터 유지. 이때 Caddy는 `localhost` 주소와 내부 CA를 썼고, 로컬 빌드 환경에서는 프록시 인증서를 빌드에 넣는 우회를 썼습니다.

**확인하지 못한 것**: 실제 도메인의 Let's Encrypt 발급, Oracle Security List/방화벽 설정, Oracle ARM(Ampere) VM에서의 빌드 (better-sqlite3는 linux-arm64 바이너리를 같이 배포하지만 시험하지 않음), 실제 카메라 정확도 (`docs/accuracy-protocol.md`).
