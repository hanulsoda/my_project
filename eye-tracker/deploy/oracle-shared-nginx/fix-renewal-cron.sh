#!/usr/bin/env bash
# The weekly certificate-renewal job installed by /opt/dahim/enable_ssl.sh ends with
# `docker exec dahim-nginx nginx -s reload`. On 2026-11-28 a reload of this nginx broke TLS for about
# 3 minutes (cause not found; a freshly started nginx with the same config works). Until the cause is
# known, make that job restart the container instead, which is the method verified on this server.
# Backs up the current crontab first and prints before/after. Run as the ubuntu user.
set -eu
BAK="$HOME/crontab.bak_$(date +%Y%m%d_%H%M%S)"
crontab -l > "$BAK"
echo "backup: $BAK"
echo "--- before:"; grep -n "nginx" "$BAK" || echo "(no nginx line found)"
if ! grep -q "docker exec dahim-nginx nginx -s reload" "$BAK"; then
  echo "no 'nginx -s reload' line in the crontab: nothing changed"; exit 0
fi
sed 's#docker exec dahim-nginx nginx -s reload#docker restart dahim-nginx#' "$BAK" | crontab -
echo "--- after:"; crontab -l | grep -n "nginx"
echo "restore with: crontab $BAK"
