#!/usr/bin/env bash
# Adds the reading.dahim.kr block to the existing nginx config and RESTARTS the nginx container,
# with an automatic rollback. Used on 2026-11-28 after a plain `nginx -s reload` of the same
# change broke TLS on the production nginx for about 3 minutes (cause still unknown; the same
# config works on a freshly started nginx, see docs/oracle-server.md).
#
# Usage: BAK=/opt/dahim/nginx/default.conf.bak_YYYYMMDD_HHMM ./apply-nginx-block.sh
# Take the backup first:  cp /opt/dahim/nginx/default.conf "$BAK"
set -u
CONF=/opt/dahim/nginx/default.conf
BLOCK="$(cd "$(dirname "$0")" && pwd)/reading.nginx.conf"
BAK="${BAK:?set BAK to the backup file taken before this change}"
chk() { curl -sk -m 5 -o /dev/null -w '%{http_code}' --resolve "$1:443:127.0.0.1" "https://$1$2"; }

if grep -q "reading.dahim.kr" "$CONF"; then echo "reading block already present: nothing to do"; exit 1; fi
cp "$CONF" "/opt/dahim/nginx/default.conf.pre_reading_$(date +%H%M%S)"
cat "$BLOCK" >> "$CONF"          # append in place: the container bind-mounts this single file
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
exit 1
