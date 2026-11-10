# API v0.11.0

Базовый URL: `http://<host>:4000`. Ответы — JSON, кроме стриминга, обложек и `/metrics`.

Версионированный префикс — `/api/v1/*`; это тот же контракт, что `/api/*` (алиас,
оставлен для обратной совместимости web-клиента и скриптов). Машинное описание:
`GET /api/v1/openapi.json` (OpenAPI 3.1, отдаётся без токена).
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
      "stream": "/api/tracks/0b4d…/stream?format=opus&exp=1794300931213&sig=…",
      "streams": {
        "original": "/api/tracks/0b4d…/stream?exp=1794300931213&sig=…",
        "opus": "/api/tracks/0b4d…/stream?format=opus&exp=…&sig=…",
        "aac": "/api/tracks/0b4d…/stream?format=aac&exp=…&sig=…"
      },
      "hls": "/api/tracks/0b4d…/hls.m3u8?exp=1794300931213&sig=…",
      "cover": "/api/tracks/0b4d…/cover?exp=1794300931213&sig=…",
      "expiresAt": "2026-11-10T08:55:31.213Z"
    }
  }
}
```
`streams` содержит только готовые варианты (`original` есть всегда, `opus`/`aac` — после
транскодинга); `hls` — `null`, пока нарезки нет. `stream` — лучший доступный вариант,
клиент всё равно перепроверяет поддержку кодека через `canPlayType()`.
Подпись варианта считается по виду `stream:opus` / `stream:aac`, HLS — по виду `hls`.
TTL задаётся `MEDIA_URL_TTL_MS` (по умолчанию 30 минут). Подпись считается как
`HMAC-SHA256(secret, "<trackId>:<stream|cover>:<exp>")` в base64url и проверяется
через `timingSafeEqual`; просроченная или изменённая подпись → `401`.

## Трекер реплик и сиды

Файлы могут лежать не на сервере, а на устройствах: сервер хранит метаданные,
реестр реплик и выдаёт подписанные ссылки на сидов. Подробная модель —
`docs/DISTRIBUTED.md`.

### GET /api/tracks/:id/download
→ `302 Location: <сид>` на подписанную ссылку `/seed/<hash>?exp&sig` (свой узел или
живое устройство). Если файла сейчас нет ни у кого — `409 no_source`.
С `?json=1` или `Accept: application/json` вместо редиректа возвращается объект:

```json
{ "url": "http://node-a:4000/seed/a2c9…?exp=1794319680&sig=…",
  "local": false, "hash": "a2c9…", "bytes": 7340032, "mime": "audio/mpeg",
  "seed": { "deviceId": "node-a", "kind": "node", "servable": true, "ageMs": 1200 },
  "seeds": [ … ] }
```

### GET /seed/:hash?exp&sig
Отдача файла **этим** устройством: `200/206` (Range, ETag, HEAD), `401` — подпись
неверна, `403` — `SEED_ENABLED=0`, `404 not_here` — файла нет на этом устройстве.
Подпись живёт 30 минут и общая для всех узлов (один `VISION_SECRET`).

### POST /api/blobs
```json
{ "hash": "sha256", "bytes": 7340032, "mime": "audio/mpeg" }
```
→ `201 { blob, seeds }`. Если передан `deviceId`/`kind`/`baseUrl` — сразу создаётся
запись сида.

### GET /api/blobs/:hash → `{ blob, local, seeded, deviceId, seeds, stats }`
`seeded` — файл лежит в каталоге сида **этого** узла (его можно отдать по `/seed/:hash`),
`deviceId` — кто этот узел по мнению трекера.
### DELETE /api/blobs/:hash → `204`

### GET /api/blobs/:hash/seeds
```json
{ "hash": "…", "ttlMs": 180000, "local": true,
  "stats": { "servable": 1, "replicas": 2, "devices": 3, "kinds": { "node": 1, "browser": 2 } },
  "seeds": [ { "deviceId": "node-a", "kind": "node", "baseUrl": "http://…",
               "servable": true, "onlineAt": "…", "ageMs": 900, "url": "http://…/seed/…?exp&sig" } ] }
```

### POST /api/blobs/:hash/seed
Heartbeat устройства: `{ "deviceId": "termux", "kind": "node", "baseUrl": "http://…" }`.
Виды: `origin` (узел, где загрузили файл), `node`, `desktop` — раздают; `mobile` и
`browser` — только «копия есть» (раздавать по HTTP не умеют). Живёт `SEED_TTL_MS`
(3 минуты) для раздающих и 30 дней для реплик.

### DELETE /api/blobs/:hash/seed?deviceId=termux → `204`
### POST /api/blobs/:hash/replicate
Забирает файл с первого живого сида, сверяет `sha256` и начинает раздавать его сам.
→ `200 { ok, bytes, already, from, stats }`, `409 no_source` — брать не у кого.

### DELETE /api/blobs/:hash/replica → `204`
Убирает локальную реплику: файл из `SEED_DIR` и свой сид из реестра
(метрика `vision_blob_replica_removed_total`). Origin-файлы в хранилище и чужие сиды
не трогает; если своей копии нет — `404 not_a_replica`. После этого трек снова
качается с пира.

### GET /api/seeds
```json
{ "mode": "local", "seedEnabled": true, "deviceId": "origin", "publicUrl": null,
  "seedDir": "/data/seed", "ttlMs": 180000, "blobs": 9, "seeds": 3, "replicas": 2,
  "servableBlobs": 9, "localBlobs": 9, "noSource": 0 }
```

### Поля трека, связанные с репликами
`checksum` — sha256 содержимого; `sources` — `{ hash, local, servable, replicas,
devices, kinds }`; `available` — `false`, если файла нет ни локально, ни у живых сидов
(в интерфейсе такой трек помечается «нет источника»).

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
Два режима по `Content-Type`:
- `audio/*`, `application/octet-stream` — загрузка файла (тело запроса), сервер сам
  становится `origin`-сидом. Метаданные — в query: `?title=&artist=&album=&genre=&duration=&peaks=`.
- `application/json` — **только метаданные** (`STORAGE_MODE=metadata`):
  `{ "hash": "sha256", "bytes": 7340032, "mime": "audio/mpeg", "title": "…",
     "artist": "…", "duration": 214, "peaks": [0.1, …],
     "deviceId": "laptop", "kind": "desktop", "baseUrl": "http://192.168.1.20:4000" }`
  → `201` с треком и `sources`; `415 upload_expected`, если сервер в режиме `local`.

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
Требует `exp`/`sig` **или** Bearer-токен. Параметр `format=opus|aac` отдаёт
транскодированный вариант; если его ещё нет (ffmpeg недоступен или трек в очереди),
сервер отдаёт оригинал и ставит заголовок `X-Variant-Fallback: opus`.
Range-запросы → `206` + `Content-Range`; без Range → `200`; невозможный диапазон → `416`.
Заголовки: `Accept-Ranges: bytes`, `ETag`, `Cache-Control: private, max-age=3600`.
`If-None-Match` → `304`.

### GET /api/tracks/:id/hls.m3u8
HLS-плейлист (сегменты по 6 с, AAC 128k, нормализация −14 LUFS). Требует ту же
подпись, что и медиа (вид `hls`). Строки-сегменты переписаны в абсолютные пути с
`exp`/`sig`, поэтому плеер не теряет авторизацию при разрешении относительных URL.
`404 no_hls` — ffmpeg нет или трек ещё не нарезан.

### GET /api/tracks/:id/hls/:segment
Сегмент `seg-000.ts`, `Content-Type: video/mp2t`. Подпись та же, что у плейлиста.

### GET /api/tracks/:id
Кроме полей трека отдаёт `variants`: `[{ kind: "opus" | "aac" | "hls", mime, ext, size, bitrate, createdAt }]`.

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

## Внешние источники (SoundCloud)

Раздел хранит только метаданные и адрес официального встроенного плеера.
Аудио не скачивается и не проксируется — см. `docs/CONTENT.md`.

### GET /api/external?limit=200
→ `200 [{ "id": "…", "source": "soundcloud", "permalink": "https://soundcloud.com/…",
"title": "…", "artist": "…", "artwork": "https://i1.sndcdn.com/…", "embedUrl":
"https://w.soundcloud.com/player/?url=…", "duration": 0, "note": null,
"createdAt": "…" }]`

### POST /api/external
```json
{ "urls": ["https://soundcloud.com/artist/track"] }
```
До 50 ссылок за раз. Разрешены домены `soundcloud.com`, `www.`, `m.`, `on.`;
метаданные берутся с официального oEmbed-эндпоинта.

→ `201 { "added": [{ …ExternalTrack, "created": true }], "failed": [] }`
→ `400` если ни одну ссылку не удалось добавить (`failed[].code`:
`invalid_url`, `unsupported_host`, `not_found`, `embed_unavailable`,
`source_unreachable`, `source_error`), а также при `no_urls` / `too_many_urls`.

Повторный импорт той же ссылки обновляет запись (`created: false`), дублей нет.

### PATCH /api/external/:id
```json
{ "note": "заметка" }
```
→ `200 ExternalTrack`

### DELETE /api/external/:id → `204`

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
→ `200 { "ok": true, "tracks": 42, "diskFreeMb": 18234, "version": "0.6.1",
"migrations": { "applied": [...], "pending": 0 },
"ffmpeg": { "available": true, "version": "ffmpeg version 7.1 …", "path": "/usr/bin/ffmpeg" },
"runtime": { "platform": "linux", "arch": "x64", "node": "v22.20.0", "termux": false },
"transcode": { "enabled": true, "queued": 0, "busy": false, "processed": 12, "failed": 0,
  "lastError": null,
  "settings": { "codecs": ["opus", "aac"], "hls": true, "normalize": true, "threads": null } } }`

`ffmpeg.available: false` — штатное состояние: сервис работает на оригиналах, без вариантов и HLS.
`ffmpeg.path` — какой кандидат реально запустился (`FFMPEG_PATH` → `ffmpeg-static` → `PATH`);
`null` — ни один. `runtime` помогает диагностировать Termux/ARM-сборки.

### GET /metrics
Формат Prometheus (text exposition 0.0.4): `vision_tracks_total`, `vision_plays_total`,
`vision_storage_bytes`, `vision_disk_free_bytes`, `vision_uptime_seconds`,
счётчики `vision_http_requests_total{method,route,status}`, `vision_auth_*`,
`vision_upload_*`, `vision_stream_partial_total`, `vision_transcode_total{result}`
(`opus`/`aac`/`hls`/`error`), `vision_transcode_seconds_total{kind}` и гистограмма
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

- `/api/v1/*` — стабильный контракт (алиас `/api/*`, они идентичны).
- `GET /api/v1/openapi.json` — схема OpenAPI 3.1, собирается из кода
  (`services/api/src/openapi.js`), поэтому не расходится с реализацией.
- Версия приложения — в `/api/health`, `/api/me` и `info.version` схемы.
- Ломающие изменения — только через `/api/v2`; в v1 допускаются новые поля.
