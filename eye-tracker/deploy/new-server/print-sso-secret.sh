#!/usr/bin/env bash
# Prints ONLY the SSO secret (no quotes, no newline). Meant to be piped between ssh sessions on the
# owner's own computer so the secret never has to be shown or pasted. Run with sudo.
set -eu
. /opt/reading/eye-tracker/.env
printf '%s' "$SSO_SECRET"
