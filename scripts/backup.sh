#!/usr/bin/env bash
# DBバックアップ（カスタム形式）。cron 例: */30 * * * * cd /path/to/repo && scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
mkdir -p backups
file="backups/gakusai_$(date +%Y%m%d_%H%M%S).dump"
docker compose exec -T db pg_dump -U "${POSTGRES_USER:-gakusai}" -d "${POSTGRES_DB:-gakusai}" -Fc > "$file"
echo "backup: $file ($(du -h "$file" | cut -f1))"
# 古いバックアップを削除（7日以上前）
find backups -name 'gakusai_*.dump' -mtime +7 -delete
