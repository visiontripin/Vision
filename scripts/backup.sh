#!/usr/bin/env bash
# Бэкап Vision Audio: SQLite (консистентный снимок) + медиа и обложки + проверка.
# Использование: ./scripts/backup.sh [каталог-назначения=/srv/backups]
#
# Тот же бэкап делает сервер сам (`POST /api/backups`, BACKUP_EVERY_HOURS):
# здесь — путь для cron, когда сервер останавливать нельзя и приложение не нужно.
# Отличие от «просто скопировать папку»: снимок базы делается через VACUUM INTO
# (не ловит середину транзакции) и после сборки архив проверяется — распаковка,
# integrity_check и сверка треков с медиа. Бэкап без проверки — это надежда.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${DATA_DIR:-$ROOT/data}"
TARGET="${1:-${BACKUP_DIR:-/srv/backups}}"
STAMP="$(date +%Y-%m-%d_%H%M)"
DEST="$TARGET/vision-$STAMP"
ARCHIVE="$DEST.tar.gz"
KEEP="${BACKUP_KEEP:-14}"

if [[ ! -f "$DATA/vision.db" ]]; then
  echo "Нет базы в $DATA — сначала запустите сервис и загрузите треки." >&2
  exit 1
fi

mkdir -p "$TARGET"

# 1. Снимок базы. VACUUM INTO (Node 22) консистентен на живой базе: копирование
#    файла может поймать недописанную транзакцию, а сервер останавливать нельзя.
echo "→ снимаю базу (VACUUM INTO, без остановки сервера)"
node -e '
const { DatabaseSync } = require("node:sqlite");
const [src, dst] = process.argv.slice(1);
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '"'"'${dst.replaceAll("'"'"'", "'"'"''"'"'")}'"'"'`);
db.close();
' "$DATA/vision.db" "$DEST.db"

mkdir -p "$DEST"
mv "$DEST.db" "$DEST/vision.db"

# 2. Медиа и обложки: без них архив восстанавливается в библиотеку без звука.
echo "→ копирую медиа"
for folder in media covers; do
  [[ -d "$DATA/$folder" ]] || continue
  mkdir -p "$DEST/$folder"
  cp -R "$DATA/$folder/." "$DEST/$folder/" 2>/dev/null || cp -R "$DATA/$folder" "$DEST/"
done

# 3. Проверка. Ровно то, что сломает восстановление: целостность SQLite,
#    число треков и наличие файлов. Красная проверка не удаляет архив —
#    разбираться нужен сам файл.
echo "→ проверяю снимок"
node -e '
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const [dir, liveDir] = process.argv.slice(1);
const db = new DatabaseSync(path.join(dir, "vision.db"), { readOnly: true });
const problems = [];
const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
if (integrity !== "ok") problems.push(`integrity_check: ${integrity}`);
const tracks = db.prepare("SELECT COUNT(*) AS n FROM tracks").get().n;
const rows = db.prepare("SELECT id, checksum, ext FROM tracks WHERE ext IS NOT NULL").all();
const missing = rows.filter((row) => {
  const names = [`${row.id}.${row.ext}`];
  if (row.checksum) names.push(`${row.checksum}.${row.ext}`);
  return !names.some((name) => fs.existsSync(path.join(dir, "media", name)));
});
if (missing.length) problems.push(`нет файлов для ${missing.length} треков`);
const manifest = {
  createdAt: new Date().toISOString(),
  tracks,
  ok: problems.length === 0,
  problems,
};
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
db.close();
if (problems.length) {
  console.error("✗ проверка не прошла: " + problems.join("; "));
  process.exit(2);
}
console.log(`✓ проверка прошла: треков ${tracks}, файлов ${rows.length - missing.length}`);
' "$DEST" "$DATA"

echo "→ упаковываю"
# Кладём содержимое в корень архива, а не вложенным каталогом: так распаковка
# одной командой даёт vision.db/media/covers, как и у серверного бэкапа.
tar -czf "$ARCHIVE" -C "$DEST" .
rm -rf "$DEST"

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo "✓ бэкап готов: $ARCHIVE ($SIZE)"
echo "  проверка восстановления: tar -xzf $ARCHIVE -C /tmp/check && \\"
echo "    node ./scripts/verify-backup.mjs /tmp/check"
echo "  (или POST /api/backups/verify с именем vision-$STAMP)"

# оставляем KEEP последних архивов
ls -1t "$TARGET"/vision-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
