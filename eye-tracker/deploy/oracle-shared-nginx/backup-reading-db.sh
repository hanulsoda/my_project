#!/usr/bin/env bash
# Daily backup of the reading app's SQLite database (children, sessions, gaze samples).
# Uses SQLite's online backup API inside the running container, so the copy is consistent
# even while the app writes. Keeps the newest 14 copies. The existing backup_db.sh only covers MariaDB.
#
# Install (once, as the ubuntu user):
#   mkdir -p /opt/dahim-reading/backups
#   (crontab -l 2>/dev/null; echo '10 4 * * * /opt/dahim-reading/src/eye-tracker/deploy/oracle-shared-nginx/backup-reading-db.sh >> /opt/dahim-reading/backups/backup.log 2>&1') | crontab -
set -eu
DEST=/opt/dahim-reading/backups
KEEP=14
STAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$DEST"

docker exec dahim-reading node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/db/app.db', { fileMustExist: true });
db.backup('/tmp/app-backup.db').then(() => {
  const chk = new Database('/tmp/app-backup.db', { fileMustExist: true }).pragma('integrity_check', { simple: true });
  if (chk !== 'ok') { console.error('integrity_check:', chk); process.exit(2); }
  console.log('backup ok');
}).catch((e) => { console.error(e.message); process.exit(1); });
"
docker cp dahim-reading:/tmp/app-backup.db "$DEST/app_${STAMP}.db"
docker exec dahim-reading rm -f /tmp/app-backup.db
chmod 600 "$DEST/app_${STAMP}.db"
# keep only the newest $KEEP
ls -1t "$DEST"/app_*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "$(date -Is) saved $DEST/app_${STAMP}.db ($(du -h "$DEST/app_${STAMP}.db" | cut -f1)), kept $(ls -1 "$DEST"/app_*.db | wc -l)"
