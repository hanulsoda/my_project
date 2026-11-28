#!/usr/bin/env bash
# Daily backup of the reading app's SQLite database on the stand-alone server
# (compose project in /opt/reading/eye-tracker, container eye-tracker-app-1).
# Uses SQLite's online backup API inside the running container, so the copy is consistent while the
# app writes. Keeps the newest 14 copies in /opt/reading-backups (root only).
#
# Install (once, on the server):
#   sudo mkdir -p /opt/reading-backups && sudo chmod 700 /opt/reading-backups
#   sudo install -m 755 /opt/reading/eye-tracker/deploy/new-server/backup-reading-db.sh /usr/local/bin/backup-reading-db.sh
#   echo '10 4 * * * root /usr/local/bin/backup-reading-db.sh >> /opt/reading-backups/backup.log 2>&1' | sudo tee /etc/cron.d/reading-backup
set -eu
DEST=/opt/reading-backups
KEEP=14
C=eye-tracker-app-1
STAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$DEST"; chmod 700 "$DEST"
docker exec "$C" node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/db/app.db', { fileMustExist: true });
db.backup('/tmp/app-backup.db').then(() => {
  const chk = new Database('/tmp/app-backup.db', { fileMustExist: true }).pragma('integrity_check', { simple: true });
  if (chk !== 'ok') { console.error('integrity_check:', chk); process.exit(2); }
  console.log('backup ok');
}).catch((e) => { console.error(e.message); process.exit(1); });
"
docker cp "$C:/tmp/app-backup.db" "$DEST/app_${STAMP}.db"
docker exec "$C" rm -f /tmp/app-backup.db
chmod 600 "$DEST/app_${STAMP}.db"
ls -1t "$DEST"/app_*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "$(date -Is) saved $DEST/app_${STAMP}.db ($(du -h "$DEST/app_${STAMP}.db" | cut -f1)), kept $(ls -1 "$DEST"/app_*.db | wc -l)"
