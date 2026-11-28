#!/usr/bin/env bash
# Replaces SSO_SECRET in /opt/reading/eye-tracker/.env with a fresh random value and restarts the app.
# The value is never printed. Run with sudo. Other .env lines are kept; the file stays root-only (600).
set -eu
ENV=/opt/reading/eye-tracker/.env
NEW="$(openssl rand -hex 32)"
[ "${#NEW}" -eq 64 ] || { echo "ERROR: could not generate a 64-character secret"; exit 1; }
umask 077
TMP="$(mktemp)"
grep -v '^SSO_SECRET=' "$ENV" > "$TMP" || true
printf "SSO_SECRET='%s'\n" "$NEW" >> "$TMP"
install -m 600 -o root -g root "$TMP" "$ENV"
rm -f "$TMP"
cd /opt/reading/eye-tracker
docker compose up -d --force-recreate app
echo ROTATED
