# Runbook: запуск, деплой, бэкапы

## 1. Локальный запуск

```bash
npm install
npm run build        # web → apps/web/dist
npm start            # API + статика, http://0.0.0.0:4000
```

Проверка: `curl -s localhost:4000/api/health` → `{"ok":true,...}`.

## 2. Docker

```bash
docker build -t vision-audio .
docker run -d --name vision \
  -p 4000:4000 \
  -e VISION_PASSWORD='свой-пароль' \
  -e VISION_SECRET="$(openssl rand -hex 32)" \
  -v /srv/vision-data:/app/data \
  --restart unless-stopped \
  vision-audio
```

Данные (`vision.db`, `media/`, `covers/`) лежат в томе `/app/data` — его и бэкапим.

## 3. Reverse proxy (TLS)

Caddy — самый короткий путь:

```
music.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4000
}
```

Проверить после включения HTTPS: вход, загрузка, seek в треке, обложки.

## 4. Бэкап и восстановление

```bash
# бэкап (WAL-safe, без остановки сервиса)
./scripts/backup.sh /srv/backups

# восстановление
systemctl stop vision
cp /srv/backups/vision-2026-11-09/vision.db data/vision.db
rsync -a /srv/backups/vision-2026-11-09/media/ data/media/
systemctl start vision
curl -s localhost:4000/api/health
```

Правило: **раз в месяц** восстановить бэкап в отдельную папку и открыть 2–3 трека.
Бэкап, который не проверяли, бэкапом не считается.

## 5. Мониторинг

- `GET /api/health` → `ok`, число треков, свободное место, версия. Проверять раз в минуту.
- Алерты: диск < 15 %, `/api/health` недоступен 2 минуты, рост 5xx.
- Логи — stdout (JSON при `NODE_ENV=production`), ротация на стороне Docker/journald.

## 6. Типовые проблемы

| Симптом | Причина | Решение |
|---------|---------|---------|
| Трек не играет, в Network 401 | токен не передан в `?token=` для `<audio>` | обновите страницу (токен протух) или войдите заново |
| 415 при загрузке | файл не аудио или битые magic bytes | проверьте файл, конвертируйте в mp3/wav |
| 413 | файл > 500 МБ | поднимите `MAX_UPLOAD` в `services/api/src/server.js` |
| Пустая волна | браузер не смог декодировать (flac в Safari) | peaks = null, рисуется псевдо-волна; конвертируйте в mp3 |
| Seek возвращает 200, а не 206 | reverse proxy буферизует ответ | отключите буферизацию для `/api/tracks/*/stream` |
| `SQLite is experimental` в логах | предупреждение Node 22 | безвредно; можно скрыть `--no-warnings` |

## 7. Обновление версии

```bash
git pull
npm ci
npm run build
npm test
docker build -t vision-audio . && docker rm -f vision && docker run ...   # или systemctl restart vision
curl -s localhost:4000/api/health
```

Миграции БД идемпотентны (`CREATE TABLE IF NOT EXISTS`), откат — через восстановление бэкапа.
