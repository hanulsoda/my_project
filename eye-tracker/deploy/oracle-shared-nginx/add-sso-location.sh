#!/usr/bin/env bash
# Adds `location = /sso { access_log off; ... }` to the reading.dahim.kr block that is ALREADY in
# the nginx config (apply-nginx-block.sh refuses to run twice), so the one-time SSO token stays out
# of the access log. Restarts nginx (not reload) and rolls back automatically on failure.
# Usage: ./add-sso-location.sh            (CONF can be overridden for a dry run: CONF=/tmp/x.conf NOAPPLY=1)
set -u
CONF="${CONF:-/opt/dahim/nginx/default.conf}"
BLOCK="$(cd "$(dirname "$0")" && pwd)/reading.nginx.conf"
chk() { curl -sk -m 5 -o /dev/null -w '%{http_code}' --resolve "$1:443:127.0.0.1" "https://$1$2"; }

grep -q "reading.dahim.kr" "$CONF" || { echo "no reading block in $CONF"; exit 1; }
grep -q "location = /sso" "$CONF" && { echo "already present: nothing to do"; exit 0; }
BAK="$CONF.pre_sso_$(date +%Y%m%d_%H%M%S)"
cp "$CONF" "$BAK"
python3 - "$CONF" "$BLOCK" <<'PY'
import sys,re
conf,block=sys.argv[1],sys.argv[2]
new=open(block).read()
m=re.search(r'    # /sso\?t=.*?\n    \}\n\n', new, re.S)
snippet=m.group(0)
s=open(conf).read()
i=s.index('server_name reading.dahim.kr')
j=s.index('    location / {', i)
open(conf,'w').write(s[:j]+snippet+s[j:])
PY
[ -n "${NOAPPLY:-}" ] && { echo "dry run done; backup $BAK"; exit 0; }
if ! docker exec dahim-nginx nginx -t >/dev/null 2>&1; then
  cat "$BAK" > "$CONF"; echo "syntax check failed: restored, nginx untouched"; exit 1
fi
docker restart dahim-nginx >/dev/null
for i in $(seq 1 10); do
  sleep 2
  a=$(chk app.dahim.kr /api/health); r=$(chk reading.dahim.kr /)
  echo "[$i] app=$a reading=$r"
  if [ "$a" = 200 ] && [ "$r" = 200 ]; then echo "ok: both answer"; exit 0; fi
done
echo "FAILED: rolling back"
cat "$BAK" > "$CONF"; docker restart dahim-nginx >/dev/null; sleep 4
echo "after rollback app=$(chk app.dahim.kr /api/health)"
