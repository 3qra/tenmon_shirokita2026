#!/usr/bin/env bash
# ダミー初期データを投入する（部門が1件もないときだけ）。価格・日付・定員はすべて仮の値。
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose run --rm api seed
