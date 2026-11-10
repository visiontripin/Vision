# API v0.2.0

Базовый URL: `http://<host>:4000`. Ответы — JSON, кроме стриминга, обложек и `/metrics`.
Авторизация: `Authorization: Bearer <token>` — везде, кроме `/api/health`, `/api/auth/login`
и подписанных медиа-ссылок (у них своя HMAC-подпись в query).
Ошибки: `{ "error": { "code": "string", "message": "string" } }` + HTTP-статус.
Каждый ответ содержит `X-Request-Id`, тот же идентификатор пишется в структурный лог.

## Медиа и подписи

`<audio>` и `<img>` не умеют присылать заголовок `Authorization`, поэтому токен
в URL **не передаётся** (это утечка в логи и Referer). Вместо него сервер выдаёт
короткоживущую HMAC-подпись.

### GET /api/media?ids=id1,id2
До 200 идентификаторов. → `200`
```json
{
  "ttlMs": 1800000,
  "items": {
    "0b4d…": {
      "stream": "/api/tracks/0b4d…/stream?exp=1794300931213&sig=SEBSK1wX…",
      "cover": "/api/tracks/0b4d…/cover?exp=1794300931213&sig=…",
      "expiresAt": "2026-11-10T08:55:31.213Z"
    }
  }
}
```
TTL задаётся `MEDIA_URL_TTL_MS` (по умолчанию 30 минут). Подпись считается как
`HMAC-SHA256(secret, "<trackId>:<stream|cover>:<exp>")` в base64url и проверяется
через `timingSafeEqual`; просроченная или изменённая подпись → `401`.

## Auth

### POST /api/auth/login
```json
{ "password": "vision" }
```
→ `200 { "token": "…", "expiresAt": "2026-12-09T…" }` · `401 unauthorized` · `429 rate_limited`

### GET /api/me
→ `200 { "ok": true, "role": "owner", "version": "0.2.0" }`

## Tracks

### GET /api/tracks
Query: `q`, `genre`, `liked=1`, `sort`, `limit` (1–2000, по умолчанию 50), `offset`.
`sort`: `recent` (по умолчанию) · `oldest` · `title` · `plays` · `duration` · `relevance`
(осмысленно только вместе с `q`).

Поиск — SQLite FTS5 (`unicode61 remove_diacritics 2`) по `title/artist/album/genre/description`,
префиксный: последнее слово запроса ищется как `слово*`, так что «midn» уже находит «Midnight».
Спецсимволы FTS экранируются, пустой запрос превращается в обычный список.

→ `200 Track[]` + заголовки `X-Total-Count`, `X-Limit`, `X-Offset`.
В списке нет `peaks` (экономим трафик), всё остальное совпадает с
`GET /api/tracks/:id`.

### POST /api/tracks
Query: `title`, `artist`, `album`, `genre`, `description`, `duration`, `filename`,
`peaks` (JSON-строка, до 16 КБ).
Body: сырые байты аудио.

Сервер определяет формат по magic bytes (MP3/ID3, FLAC, WAV, Ogg/Opus, M4A/MP4),
читает теги (ID3v2.3/2.4, Vorbis comments, WAV INFO, MP4 ilst, ID3v1) и вытаскивает
обложку (APIC/PICTURE/covr, ≤ 5 МБ). Теги из файла приоритетнее «служебного»
названия вроде `track` или имени файла — но заполненные вручную поля не перетираются.
Считается SHA-256 всего файла.

→ `201 Track` · `409 duplicate` (в теле `existing`) · `413 too_large` (лимит 500 МБ)
· `415 unsupported_type` · `400 invalid_audio`

### GET /api/tracks/:id → `200 Track` (с `peaks`)

### PATCH /api/tracks/:id
JSON: `title, artist, album, genre, description, liked`. Поисковый индекс
обновляется в той же транзакции. → `200 Track`

### DELETE /api/tracks/:id
Удаляет файл, обложку, связи с плейлистами и историю (каскад). → `204`

### GET /api/tracks/:id/stream
Требует `exp`/`sig` **или** Bearer-токен.
Range-запросы → `206` + `Content-Range`; без Range → `200`; невозможный диапазон → `416`.
Заголовки: `Accept-Ranges: bytes`, `ETag`, `Cache-Control: private, max-age=3600`.
`If-None-Match` → `304`.

### PUT /api/tracks/:id/cover
Body: изображение (jpeg/png/webp, ≤ 8 МБ). → `204`

### GET /api/tracks/:id/cover
Требует `exp`/`sig` или Bearer. → `200` изображение + `ETag`; `404 no_cover`.

### POST /api/tracks/:id/play → `204` (инкремент счётчика)

### POST /api/tracks/:id/listen
```json
{ "position": 42.5, "duration": 180, "completed": false }
```
Пишет позицию для «Продолжить слушать». `completed` вычисляется сервером, если
`position / duration > 0.9`. → `204`

## История

### GET /api/history?limit=12
→ `200 [{ "track": Track, "position": 42.5, "duration": 180, "completed": false,
"plays": 3, "listenedAt": "2026-11-10T08:20:00.000Z" }]`

### DELETE /api/history → `204`

## Playlists

### GET /api/playlists → `200 Playlist[]` (`id, name, description, createdAt, trackCount, duration`)
### POST /api/playlists `{ "name": "Вечер", "description": "…" }` → `201 Playlist`
### PATCH /api/playlists/:id → `200 Playlist`
### DELETE /api/playlists/:id → `204`
### GET /api/playlists/:id/tracks → `200 Track[]`
### POST /api/playlists/:id/tracks `{ "trackId": "…" }` → `204`
### DELETE /api/playlists/:id/tracks/:trackId → `204`

## Stats

### GET /api/stats
```json
{ "tracks": 42, "playlists": 5, "liked": 12, "plays": 310,
  "duration": 91234, "bytes": 734003200, "diskFreeMb": 18234,
  "version": "0.2.0", "genres": [{ "genre": "Ambient", "count": 7 }],
  "migrations": { "applied": ["001-base", "…"], "pending": 0 } }
```

## System

### GET /api/health
→ `200 { "ok": true, "tracks": 42, "diskFreeMb": 18234, "version": "0.2.0",
"migrations": { "applied": [...], "pending": 0 } }`

### GET /metrics
Формат Prometheus (text exposition 0.0.4): `vision_tracks_total`, `vision_plays_total`,
`vision_storage_bytes`, `vision_disk_free_bytes`, `vision_uptime_seconds`,
счётчики `vision_http_requests_total{method,route,status}`, `vision_auth_*`,
`vision_upload_*`, `vision_stream_partial_total` и гистограмма
`vision_http_request_duration_seconds{route}`.
Если задан `METRICS_TOKEN`, нужен `Authorization: Bearer <METRICS_TOKEN>`.

## Переменные окружения

| Переменная | По умолчанию | Смысл |
| --- | --- | --- |
| `PORT` / `HOST` | `4000` / `0.0.0.0` | адрес API |
| `DATA_DIR` | `./data` | каталог БД и медиа |
| `DB_FILE` | `$DATA_DIR/vision.db` | путь к файлу SQLite |
| `VISION_PASSWORD` | `vision` | пароль владельца (сменить в проде!) |
| `VISION_SECRET` | производный от пароля | ключ HMAC для токенов и медиа-подписей |
| `MEDIA_URL_TTL_MS` | `1800000` | срок жизни подписанных ссылок |
| `METRICS_TOKEN` | — | закрыть `/metrics` |
| `WEB_DIST` | `apps/web/dist` | статика веб-клиента |
| `LOG_FORMAT` | `json` при `NODE_ENV=production` | структурные логи |

## Версионирование

Пока API живёт под `/api/*` и версионируется заголовком в `/api/health`.
`/api/v1` и OpenAPI-схема — в плане Фазы 1 (остаток), см. `docs/IMPROVEMENTS.md`.
