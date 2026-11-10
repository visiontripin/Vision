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

- `GET /api/health` → `ok`, число треков, свободное место, версия и статус миграций
  (`migrations.pending` должен быть `0`).
- `GET /metrics` — Prometheus-формат. Пример scrape-конфига:

```yaml
scrape_configs:
  - job_name: vision
    static_configs:
      - targets: ['music.example.com']
    metrics_path: /metrics
    authorization:
      credentials: '<METRICS_TOKEN>'
```

Что смотреть в первую очередь:

| Метрика | Смысл | Повод реагировать |
| --- | --- | --- |
| `vision_http_request_duration_seconds` | p95 по маршрутам | > 0.5 s на `/api/tracks` |
| `vision_http_requests_total{status=~"5.."}` | ошибки | любой устойчивый рост |
| `vision_upload_duplicates_total` | дедуп сработал | норм, если растёт вместе с загрузками |
| `vision_stream_partial_total` / `_full_total` | seek vs целые файлы | рост `_full` — клиент ломает Range |
| `vision_disk_free_bytes` | место | < 15 % диска |
| `vision_auth_failures_total` | подбор пароля | > 5 за 5 минут (дальше включается rate limit) |

- Логи — stdout (JSON при `NODE_ENV=production`), каждый запрос содержит `id`
  (он же `X-Request-Id` в ответе), `method`, `path`, `status`, `ms`.
- Алерты: диск < 15 %, `/api/health` недоступен 2 минуты, рост 5xx,
  `migrations.pending > 0` после обновления.

## 5.1 Подписанные медиа-ссылки

`<audio>`/`<img>` не шлют `Authorization`, поэтому сервер выдаёт HMAC-ссылки
с TTL (`MEDIA_URL_TTL_MS`, по умолчанию 30 минут) через `GET /api/media?ids=`.

- Если после сна ноутбука трек «отвалился» с 401 — это ожидаемо, клиент
  перезапрашивает ссылку (в веб-клиенте есть автоповтор).
- Держите `MEDIA_URL_TTL_MS` коротким (10–60 минут): ссылка попадает в логи
  прокси и историю браузера.
- `VISION_SECRET` должен быть стабильным: при его смене все выданные ссылки и
  токены входа становятся недействительными (это ещё и способ «разлогинить всё»).

## 6. Типовые проблемы

| Симптом | Причина | Решение |
|---------|---------|---------|
| Трек не играет, в Network 401 на `/stream?exp=…&sig=…` | истекла подпись или сменился `VISION_SECRET` | обновите страницу; в API ссылки перезапрашиваются автоматически |
| 409 при загрузке `duplicate` | этот файл уже в библиотеке (SHA-256) | откройте существующий трек из ответа |
| Поиск ничего не находит | FTS-индекс рассинхронизирован (ручные правки БД) | `npm run start` применяет миграции; пересборка индекса — удалить `tracks_fts` и запустить сервис |
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

Миграции БД идемпотентны (`CREATE TABLE IF NOT EXISTS`) и применяются при старте
по порядку номеров; учтённые версии лежат в таблице `schema_version`, статус виден
в `/api/health`. Откат — только восстановлением бэкапа (миграции не «откатываются»).

Перед обновлением всегда:

```bash
./scripts/backup.sh /srv/backups      # база (WAL-safe) + media/ + covers/
npm ci && npm run build && npm test   # 14 контрактных тестов API + 3 теста local-режима
```
