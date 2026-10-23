#!/usr/bin/env bash
# バックアップから復旧する。現在のDBの内容は置き換えられる。
# 使い方: scripts/restore.sh backups/gakusai_YYYYMMDD_HHMMSS.dump
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -eq 1 ] || { echo "usage: $0 <dumpfile>"; exit 1; }
set -a; source .env; set +a
read -r -p "DBを $1 の内容で置き換えます。よろしいですか？ (yes/no) " ans
[ "$ans" = "yes" ] || exit 1
docker compose stop api web
docker compose exec -T db pg_restore -U "${POSTGRES_USER:-gakusai}" -d "${POSTGRES_DB:-gakusai}" --clean --if-exists --no-owner < "$1"
docker compose start api web
echo "restored from $1"
