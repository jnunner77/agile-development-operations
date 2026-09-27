#!/usr/bin/env bash
# Copy the app's data directory (database, snapshots, sign-in accounts) out of the Docker
# volume into a dated archive on the host, keeping the newest $KEEP archives.
# Usage: deploy/backup.sh [destination-dir]   (run from the repository root, e.g. from cron)
set -euo pipefail

cd "$(dirname "$0")/.."
DEST="${1:-$HOME/boards-backups}"
KEEP="${KEEP:-14}"
mkdir -p "$DEST"

file="$DEST/boards-$(date -u +%Y%m%d-%H%M%S).tar.gz"
docker compose exec -T app tar czf - -C /data . > "$file.partial"
mv "$file.partial" "$file"
echo "Wrote $file ($(du -h "$file" | cut -f1))"

# Prune old archives (newest first, skip the first $KEEP).
ls -1t "$DEST"/boards-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm --
