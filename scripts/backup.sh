#!/usr/bin/env bash
# Бэкап Vision Audio: SQLite (WAL-safe) + медиа и обложки.
# Использование: ./scripts/backup.sh [каталог-назначения=/srv/backups]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${DATA_DIR:-$ROOT/data}"
TARGET="${1:-/srv/backups}"
STAMP="$(date +%Y-%m-%d_%H%M)"
DEST="$TARGET/vision-$STAMP"

if [[ ! -f "$DATA/vision.db" ]]; then
  echo "Нет базы в $DATA — сначала запустите сервис и загрузите треки." >&2
  exit 1
fi

mkdir -p "$DEST"
echo "→ копирую базу (WAL-safe)"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATA/vision.db" ".backup '$DEST/vision.db'"
else
  # резервный путь: контрольная точка WAL + копирование
  node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1]).exec('PRAGMA wal_checkpoint(TRUNCATE)')" "$DATA/vision.db"
  cp "$DATA/vision.db" "$DEST/vision.db"
fi

echo "→ копирую медиа"
rsync -a "$DATA/media" "$DEST/" 2>/dev/null || cp -R "$DATA/media" "$DEST/media"
if [[ -d "$DATA/covers" ]]; then
  rsync -a "$DATA/covers" "$DEST/" 2>/dev/null || cp -R "$DATA/covers" "$DEST/covers"
fi

echo "→ упаковываю"
tar -czf "$DEST.tar.gz" -C "$TARGET" "vision-$STAMP"
rm -rf "$DEST"

SIZE="$(du -h "$DEST.tar.gz" | cut -f1)"
echo "✓ бэкап готов: $DEST.tar.gz ($SIZE)"
echo "  проверка: tar -tzf $DEST.tar.gz | head"

# оставляем 14 последних архивов
ls -1t "$TARGET"/vision-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
