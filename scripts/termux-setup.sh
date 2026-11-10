#!/usr/bin/env bash
# Установка Vision Audio на Android через Termux.
#
#   pkg install -y git
#   git clone <репозиторий> ~/Vision && cd ~/Vision
#   bash scripts/termux-setup.sh
#
# Скрипт идемпотентный: повторный запуск просто догоняет недостающее.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$HOME/vision-data}"
PORT="${PORT:-4000}"
BOOT_DIR="$HOME/.termux/boot"
BOOT_FILE="$BOOT_DIR/vision.sh"

say() { printf '\033[1;33m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✖\033[0m %s\n' "$*" >&2; exit 1; }

if [ -z "${PREFIX:-}" ] || [ "${PREFIX#*com.termux}" = "$PREFIX" ]; then
  die "Этот скрипт рассчитан на Termux. На обычном Linux ставьте ffmpeg и запускайте npm start."
fi

say "Обновляю список пакетов"
pkg update -y >/dev/null 2>&1 || true

say "Ставлю nodejs, ffmpeg и git"
# ffmpeg из Termux — единственный надёжный источник бинарника на Android:
# npm-пакет ffmpeg-static собран под glibc и здесь не запускается
pkg install -y nodejs ffmpeg git >/dev/null

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Нужен Node 22+ (сейчас $(node -v)). Выполните: pkg upgrade nodejs"
say "Node $(node -v), $(ffmpeg -version 2>/dev/null | head -1 | cut -c1-40)…"

cd "$REPO_DIR"

say "Ставлю зависимости (ffmpeg-static может не скачаться — это нормально)"
npm install --no-audit --no-fund

say "Собираю web-интерфейс"
npm run build

say "Готовлю каталог данных: $DATA_DIR"
mkdir -p "$DATA_DIR"

cat > "$BOOT_FILE.tmp" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Vision Audio: автозапуск (Termux:Boot). Правьте смело — файл перезапишется
# только при повторном запуске scripts/termux-setup.sh.
termux-wake-lock >/dev/null 2>&1 || true
cd "$REPO_DIR" || exit 1
export DATA_DIR="$DATA_DIR"
export PORT="$PORT"
export HOST=0.0.0.0
export FFMPEG_PATH="$(command -v ffmpeg)"
exec node services/api/src/server.js >> "\$HOME/vision.log" 2>&1
EOF

mkdir -p "$BOOT_DIR"
[ -f "$BOOT_FILE" ] && cp "$BOOT_FILE" "$BOOT_FILE.bak"
mv "$BOOT_FILE.tmp" "$BOOT_FILE"
chmod +x "$BOOT_FILE"

IP="$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -E '^(192\.168|10\.|172\.)' | head -1 || true)"
IP="${IP:-<ip-телефона>}"

cat <<EOF

Готово. Что дальше:

  1) запустить сейчас:
       cd "$REPO_DIR"
       DATA_DIR="$DATA_DIR" PORT=$PORT HOST=0.0.0.0 FFMPEG_PATH="$(command -v ffmpeg)" npm start

  2) открыть в браузере телефона или компьютера в той же Wi-Fi:
       http://$IP:$PORT      (пароль по умолчанию: vision)

  3) автозапуск после перезагрузки:
       установите Termux:Boot из F-Droid и один раз откройте его
       скрипт уже лежит: $BOOT_FILE

  4) чтобы Android не выгружал сервер:
       termux-wake-lock
       настройки → приложения → Termux → батарея → «Без ограничений»

Доступ из интернета — только через Tailscale/Cloudflare Tunnel, не пробросом порта:
подробности в docs/TERMUX.md.
EOF
