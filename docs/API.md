# API v0.25.0

Базовый URL: `http://<host>:4000`. Ответы — JSON, кроме стриминга, обложек и `/metrics`.

Версионированный префикс — `/api/v1/*`; это тот же контракт, что `/api/*` (алиас,
оставлен для обратной совместимости web-клиента и скриптов). Машинное описание:
`GET /api/v1/openapi.json` (OpenAPI 3.1, отдаётся без токена).
Авторизация: `Authorization: Bearer <token>` — везде, кроме `/api/health`, `/api/auth/login`
и подписанных медиа-ссылок (у них своя HMAC-подпись в query).
Ошибки: `{ "error": { "code": "string", "message": "string" } }` + HTTP-статус.
Каждый ответ содержит `X-Request-Id`, тот же идентификатор пишется в структурный лог.

## Приватные ссылки (Фаза 6)

Ссылка открывается без пароля и отдаёт гостю **только** трек или плейлист, на который
она выдана. Токен показывается один раз: в базе лежит `sha256(token)`, поэтому
восстановить адрес нельзя — только перевыпустить. Модель и компромиссы — ADR 0007.

### POST /api/shares
```json
{ "targetKind": "track", "targetId": "0b4d…", "title": "для Димы",
  "ttl": "7d", "maxPlays": 5 }
```
`targetKind`: `track` | `playlist`. `ttl`: `30m`, `12h`, `7d`, `forever` или число мс;
по умолчанию `SHARE_DEFAULT_TTL_MS` (7 дней), максимум год. `maxPlays` — лимит открытий
страницы (`null` — без лимита).

→ `201`
```json
{ "id": "…", "targetKind": "track", "targetId": "0b4d…", "title": "для Димы",
  "expiresAt": "2026-11-17T20:17:21.487Z", "maxPlays": 5, "plays": 0,
  "revokedAt": null, "lastSeenAt": null,
  "token": "4qPK_wyw7gQkG7n5pTyqCesDM3wXfO4r16Yl9MjWrNE",
  "url": "https://audio.example.com/s/4qPK…", "path": "/s/4qPK…", "active": true }
```
Токен — единственный раз, когда сервер его показывает. `404 target_not_found`,
`400 invalid_kind/invalid_target`.

### GET /api/shares?targetKind=&targetId=&includeRevoked=1
Список ссылок владельца без токенов, с `stats`:
`{ hits: { open, stream, download }, visitors, lastHitAt }` и `active`.

### GET /api/shares/:id → `200 Share`
### PATCH /api/shares/:id
`{ "title"?: string|null, "ttl"?: string|null, "maxPlays"?: number|null }` — продлить,
переименовать, снять лимит. `ttl: null` — бессрочно; `maxPlays: 0` или `null` — без лимита
(отсутствие поля значение не меняет). → `200 Share`
### DELETE /api/shares/:id → `204`
Отзыв (мгновенный). `?purge=1` — удалить запись вместе с журналом открытий.
### POST /api/shares/:id/rotate → `200` с новым `token`/`url`
Старый адрес сразу отвечает `410 rotated` (не `404`: человек должен понять, что ссылку
перевыпустили, а не что она потерялась).

### Комментарии к секунде (E3) — `docs/adr/0008-timecode-comments.md`

Комментарий живёт в ленте **конкретной ссылки и конкретного трека**: у одной и
той же песни в разных ссылках разные треды. Владелец видит всё, гость — только
ленту присланной ссылки.

`GET /api/shares/:id/comments?trackId=` → `200`
```json
{ "comments": [ { "id": "…", "trackId": "0b4d…", "at": 42.5,
                  "author": "Дима", "body": "вот тут вступает бас",
                  "createdAt": "2026-11-10T20:17:21.487Z", "deletedAt": null } ],
  "total": 1 }
```
Владелец получает и мягко удалённые (`deletedAt`), `total` считает только живые.

`POST /api/shares/:id/comments` (владелец) / `POST /s/:token/comments` (гость JSON)
```json
{ "trackId": "0b4d…", "at": 42.5, "author": "Дима", "body": "вот тут вступает бас" }
```
→ `201 ShareComment`. Правила: `at` клампится в `0..duration`, `body` ≤ 600 символов,
`author` ≤ 40 (по умолчанию «Гость»), HTML экранируется при рендере, не больше
8 комментариев в минуту с одного адреса (`429 too_many`). Ошибки:
`400 invalid_track/empty_body`, `403 track_not_in_share`, `404` — ссылки нет.

`DELETE /api/shares/:id/comments?commentId=` (владелец — любой комментарий) и
`DELETE /s/:token/comments/:commentId` (гость — только свой, по хешу адреса) →
`200 { id, deleted }`. Мягкое удаление: строка остаётся, текст гостям не отдаётся.

Форма без JavaScript: `POST /s/:token/comments` с
`application/x-www-form-urlencoded` (`trackId`, `at`, `author`, `body`) → `303` на
`/s/:token#track-<id>`; `_method=delete&commentId=…` удаляет свой комментарий.

### Гостевые маршруты (без токена и без сессии)
| Маршрут | Ответ |
|---|---|
| `GET /s/:token` | HTML-страница: плеер, список треков плейлиста, «Скачать», OG-теги. `noindex`, CSP `default-src 'none'` |
| `GET /s/:token/stream/:trackId` | Аудио с Range: `200/206`, `HEAD`, `ETag`. Нет локального файла → `302` на живой сид, нет сидов → `409 no_source` |
| `GET /s/:token/download/:trackId` | Файл с `Content-Disposition: attachment`, либо `302` на сид |
| `GET /s/:token/cover/:trackId` | Обложка (для OG-карточки) |
| `GET /s/:token/comments?trackId=` | Лента комментариев к секундам (JSON) |
| `POST /s/:token/comments` | Комментарий (JSON или форма), `DELETE /s/:token/comments/:commentId` — свой |

`403 forbidden` — трек не входит в ссылку (для ссылки на плейлист проверяется состав).
`410` + человеческий текст — `revoked`, `rotated`, `expired`, `exhausted`. `404` — токена нет.
Открытия страницы инкрементируют `plays`; `stream`/`download` пишутся только в журнал,
поэтому браузер с десятком Range-запросов не съедает лимит.

### Встраивание (E4): `/embed/:token` и oEmbed

Встраиваемый виджет — та же гостевая ссылка в компактном виде: одна дорожка
(трек) или плейлист с нативным `<audio>` и кнопкой «Открыть в Vision Audio».
Без JavaScript, без бандла, без API-запросов: работает в блоге, Notion, Telegram.

| Маршрут | Ответ |
|---|---|
| `GET /embed/:token` | HTML без `X-Frame-Options`, `frame-ancestors *` — встраивается в `<iframe>` |
| `GET /api/oembed?url=<ссылка>&format=json&maxwidth=&maxheight=` | oEmbed-описание (JSON по умолчанию, `format=xml` — XML) |
| `GET /embed/:token?theme=light` | Светлая тема виджета (по умолчанию тёмная) |

`url` в oEmbed — любая из наших ссылок: `/s/:token`, `/embed/:token`, с хвостовым
слэшем и без, `http`/`https`. Чужие адреса отклоняются: `400 invalid_url`, чтобы
oEmbed-прокси не превратился в открытый редирект. Неактивная ссылка (отозвана,
истекла, лимит открытий) → `404 not_found`, битый параметр `format` → `400 invalid_format`.

Ответ oEmbed (поля по спецификации 1.0 + наши):

```json
{
  "version": "1.0",
  "type": "rich",
  "provider_name": "Vision Audio",
  "provider_url": "https://audio.example.com",
  "title": "Ночной микс",
  "author_name": "…",
  "thumbnail_url": "https://audio.example.com/s/<token>/cover/<trackId>",
  "thumbnail_width": 512,
  "thumbnail_height": 512,
  "html": "<iframe src=\"https://audio.example.com/embed/<token>\" width=\"480\" height=\"180\" …></iframe>",
  "width": 480,
  "height": 180,
  "vision": { "kind": "playlist", "tracks": 7, "duration": 1840 }
}
```

Размеры: `maxwidth`/`maxheight` (40…960) подгоняют `width`/`height` с сохранением
пропорций; по умолчанию 480×180 для трека и 480×320 для плейлиста.

Виджет отдаёт `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
media-src 'self' https: http:; img-src 'self' data: https:; frame-ancestors *` и
`Referrer-Policy: no-referrer`. Прослушивания внутри виджета идут тем же маршрутом
`/s/:token/stream/:id`, поэтому учитываются в статистике ссылки как обычно;
открытия самого виджета `plays` **не** увеличивают — иначе одна вставка в блог
сжигала бы лимит открытий.

### Метрики
`vision_share_created_total{kind}`, `vision_share_open_total{kind}`,
`vision_embed_open_total{kind}`,
`vision_share_revoked_total`, `vision_share_rotated_total`,
`vision_share_comment_total`.

### Безопасность гостевой страницы
`Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`,
CSP `default-src 'none'` + `style-src 'unsafe-inline'`, `script-src 'unsafe-inline'`
(только наш скрипт перемотки по таймкоду), `form-action 'self'` (форма комментария),
`media-src`/`img-src` — свои адреса и адреса сидов.

## Аудит действий (G10)

Задача — ответить на вопрос «кто удалил трек и кто открывал ссылку», не заводя
полноценный SIEM. Журнал пишется в БД (переживает рестарт и попадает в бэкап) и
читается владельцем лентой.

### Модель

- Таблица `audit_log` (миграция `010-audit-log`): `at`, `actor` (`owner` | `guest` | `system`),
  `action` (см. справочник), `target_kind`/`target_id`, `share_id`, `ip_hash`,
  `details` (JSON, ≤ 2 КБ) и `request_id` (совпадает с `X-Request-Id` ответа и строкой лога).
- **Без PII**: адрес хранится как `sha256(VISION_SECRET + ip)` — тот же хеш, что в `share_hits`,
  поэтому «гость 3f9c… открыл ссылку и слушал трек» сопоставимо, а сам адрес восстановить нельзя.
- **Без секретов**: токен ссылки в журнал не попадает никогда, только `share_id`.
- **Ретеншен**: `AUDIT_RETENTION_DAYS` (по умолчанию 180) — при старте и раз в сутки
  старые записи удаляются. `AUDIT_ENABLED=0` отключает запись целиком (журнал читается).

### Действия

| `action` | `actor` | Когда пишется |
|---|---|---|
| `track.upload` / `track.update` / `track.delete` | owner | загрузка, правка метаданных, удаление (в `details` — заголовок) |
| `playlist.create` / `playlist.update` / `playlist.delete` | owner | плейлисты |
| `share.create` / `share.revoke` / `share.rotate` / `share.delete` | owner | жизненный цикл ссылок |
| `comment.add` / `comment.delete` | guest / owner | комментарии к секундам |
| `share.open` / `share.stream` / `share.download` | guest | визит по ссылке (агрегируются: см. ниже) |
| `auth.login` / `auth.fail` | owner / system | вход и неудачная попытка (без пароля в `details`) |
| `migration.apply` / `server.start` | system | старт и миграции — «что менялось на этой неделе» |

Гостевые визиты **схлопываются**: повторное открытие той же ссылки с тем же `ip_hash`
в течение 10 минут не создаёт новую запись (в `details.repeat` растёт счётчик). Иначе
обновление страницы забивало бы журнал и он перестал бы отвечать на свой вопрос.

### Эндпоинты

| Маршрут | Ответ |
|---|---|
| `GET /api/audit?limit=100&offset=0&action=&actor=&shareId=&since=&until=` | `{ entries: AuditEntry[], total, limit, offset }`, новые сверху |
| `GET /api/audit/actions` | справочник действий и их русские подписи (для UI панели) |
| `GET /api/audit/summary?days=1` | сводка за период: `{ since, total, byActor, actions }` — для панели |
| `DELETE /api/audit?keepDays=180` | ручная чистка, `{ removed }` |

`AuditEntry`: `{ id, at, actor, action, label, targetKind, targetId, shareId, ipHash,
requestId, details }`; `label` — готовая подпись на русском («удалён трек „Ночь“»).
Требуется токен владельца; гость на `/api/audit` получает `401`.

## Вход по ссылке и share target (F1/F5, v0.18.0)

Здесь нет новых эндпоинтов API: это правила разбора **входящего адреса**, одинаковые для
веб-приложения, установленной PWA и Android-сборки. Контракт описывает их, потому что
ошибка в разборе даёт «пустой экран» вместо трека, а ссылки живут вне нашего кода
(мессенджеры, заметки, чужие приложения).

### Схема deep links `visionaudio://`

| Ссылка | Смысл |
|---|---|
| `visionaudio://track/<id>` | открыть библиотеку и подсветить/включить трек |
| `visionaudio://track/<id>?t=90` | то же, с позиции 90 с (клампится в длительность) |
| `visionaudio://play/<id>` | открыть трек **и сразу начать воспроизведение** |
| `visionaudio://play/<id>?t=90` | воспроизведение с 90 с |
| `visionaudio://playlist/<id>` | открыть плейлист |
| `visionaudio://playlist/<id>?play=1` | открыть плейлист и включить первый трек |
| `visionaudio://share` | открыть диалог загрузки (используется share target) |

`id` — 32 символа `[a-f0-9]`. Всё остальное считается битой ссылкой: приложение показывает
«Ссылка не распознана» и открывает библиотеку. Неизвестный трек/плейлист — «Трек не найден»
(в библиотеке он мог быть удалён) и те же безопасные действия. Схема регистронезависима,
`t` принимает только неотрицательное число секунд (`t=1e9` клампится).

### Веб-адреса (работают и в браузере, и в PWA)

| Адрес | Поведение |
|---|---|
| `/#/track/<id>` | библиотека + воспроизведение трека |
| `/#/track/<id>/90` | то же с 90 с (альтернатива `?t=`) |
| `/#/playlist/<id>` | страница плейлиста |
| `/share` (share target) | приём `files`/`url`/`text` из системного меню «Поделиться» |

`#/track/…` разбирается при загрузке и при `hashchange`, поэтому ссылку можно прислать
в чат как обычный URL: сервер отдаёт SPA, клиент сам открывает трек.

### Share target (PWA, Android)

`manifest.webmanifest`:

```json
"share_target": {
  "action": "/share",
  "method": "GET",
  "enctype": "application/x-www-form-urlencoded",
  "params": { "title": "title", "text": "text", "url": "url" }
}
```

`GET` (а не `POST`): файл размером до 500 МБ через форму не пройдёт, а аудио в Android
чаще делят **ссылкой** на файл. Поэтому страница `/share` принимает `url`/`text`,
проверяет, что это аудио-адрес, и предлагает загрузку с уже подставленными полями —
**без автоматической отправки**: пользователь подтверждает.

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
Три режима по `Content-Type`:
- `audio/*`, `application/octet-stream` — загрузка файла (тело запроса), сервер сам
  становится `origin`-сидом. Метаданные — в query: `?title=&artist=&album=&genre=&duration=&peaks=`.
- `multipart/form-data` — **то же самое, но файл приходит одной частью** (v0.25.0, H4).
  В React Native отдать файл с диска, не читая его в память, можно только так, поэтому
  сервер принимает оба вида и дальше работает с одним потоком байтов. Берётся первая
  часть с файлом, остальные пропускаются; `Content-Type` части и имя файла — подсказки,
  формат всё равно определяется по magic bytes. Ответы, лимиты и дедупликация те же.
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

## Резервные копии (D5, v0.24.0)

Задача не «сделать архив», а «знать, что из него можно восстановиться». Поэтому копия
здесь — две операции, и вторая обязательна: снимок живой базы (`VACUUM INTO`, без
остановки сервера) плюс `media/` и `covers/`, затем проверка снимка.

### GET /api/backups → `200 BackupStatus`

```json
{
  "dir": "/srv/vision/backups",
  "count": 3,
  "totalBytes": 481203904,
  "last": { "name": "vision-2026-11-11_0300", "bytes": 160401301, "createdAt": "2026-11-11T03:00:12Z" },
  "ageDays": 0.4,
  "keep": 14,
  "level": "ok",
  "hint": null,
  "backups": [{ "name": "vision-2026-11-11_0300", "bytes": 160401301, "createdAt": "2026-11-11T03:00:12Z" }],
  "schedule": { "hours": 24, "running": true, "lastRun": null }
}
```

- `level: "warn"` и `hint`, если копий нет вовсе или последняя старше 7 дней — «бэкап
  молча перестал делаться» худший из отказов, его надо видеть, а не выяснять.
- `schedule` — автобэкап по таймеру процесса: cron есть не на всех платформах
  (Windows, Android/Termux). `BACKUP_EVERY_HOURS=0` выключает (на машине, где копию
  снимает cron, иначе она делается дважды).

### POST /api/backups → `200` — создать копию и проверить её

```json
{
  "ok": true,
  "name": "vision-2026-11-11_1200",
  "archive": "/srv/vision/backups/vision-2026-11-11_1200.tar.gz",
  "bytes": 160401301,
  "createdAt": "2026-11-11T12:00:04Z",
  "verification": { "ok": true, "problems": [], "counts": { "tracks": 412 }, "checkedFiles": 412, "missingFiles": [] },
  "pruned": ["vision-2026-10-28_0300.tar.gz"]
}
```

- `ok: false` при красной проверке — **не** ошибка запроса: архив создан, и об этом
  надо сказать данными. Архив не удаляется: разбираться нужен сам файл.
- Внутри архива: `vision.db`, `media/`, `covers/`, `manifest.json` (когда снят, сколько
  треков, что показала проверка) — статус переживает перезапуск без отдельной таблицы.
- Ротация: 14 последних копий (`KEEP_ARCHIVES`), имена вида `vision-YYYY-MM-DD_HHMM`.

### POST /api/backups/verify → `200` — проверить восстановление из архива

`{ "name": "vision-2026-11-11_1200" }` (без `name` — последняя копия). Архив
распаковывается во временный каталог, открывается как база и проверяется.
Возвращает `BackupVerification`: `ok`, `problems[]`, `counts{}`, `checkedFiles`,
`missingFiles[]`, `archive`, `checkedAt`.

| Проверка | Почему именно она |
|---|---|
| `PRAGMA integrity_check` | битая страница SQLite не видна по размеру файла |
| число треков в архиве ↔ живая библиотека | архив может быть снят до последней загрузки |
| файл есть для каждого трека (`media/`) | самая частая поломка: медиа удалили руками, база осталась |
| `.tar.gz` распаковывается | архив мог побиться при копировании на другой диск |

- Имя принимается только вида `vision-2026-11-11_1200`: `../` в параметре — чтение
  чужого файла, поэтому `400 invalid_name`. `409 no_backups`, если копий нет.
- Только владелец: `401` без токена. Оба действия пишутся в журнал
  (`backup.create`, `backup.verify`).
- Вне приложения то же самое делают `scripts/backup.sh` (cron, проверка встроена) и
  `scripts/verify-backup.mjs <архив>` (проверить скачанный архив на другой машине;
  код выхода 1 — восстанавливаться не из чего). Процедура — `docs/RUNBOOK.md` §4.

## Дашборд владельца (D1, v0.23.0)

«Что слушают и когда» — по своим прослушиваниям и по гостевым ссылкам. Это статистика
**прослушиваний**, а не аналитика по людям: сырых адресов нет, город по отпечатку не
восстанавливается.

### GET /api/dashboard?days=30&tz=60 → `200 Dashboard`

```json
{
  "since": "2026-10-12T11:14:00Z",
  "until": "2026-11-11T11:14:00Z",
  "days": 30,
  "tz": 60,
  "totals": { "plays": 42, "completed": 17, "tracks": 23, "listeners": 3, "sharedPlays": 11 },
  "sources": { "owner": 31, "share": 11 },
  "byDay": [{ "day": "2026-11-11", "plays": 4, "completed": 1, "shared": 1 }],
  "topTracks": [{ "id": "…", "title": "Slow Tide", "artist": "Vision Labs", "deleted": false, "plays": 9, "completed": 3 }],
  "listeners": [{ "id": "67bb4ce6", "plays": 12, "tracks": 5, "firstSeen": "…", "lastSeen": "…" }],
  "hint": null
}
```

Правила, которые видно в ответе:

| Правило | Зачем |
|---|---|
| `play` пишется не чаще раза в 30 минут на трек | повтор одного трека не накручивает график: три тика плеера — одно прослушивание |
| `complete` — отдельная метрика | «дослушали» полезнее, чем «включили», и не дедуплицируется |
| `byDay` заполнен **всеми** днями окна, включая нулевые | график не «склеивает» понедельник и пятницу, если в середине ничего не играло |
| `tz` (минуты) задаёт границы дня | «вчера» у человека в UTC+1 — не то же самое, что «вчера» по UTC |
| `sources.owner` vs `sources.share` | «3 моих, 20 по ссылкам» и «23 прослушивания» — разные ответы |
| `topTracks[].deleted` | удаление трека не стирает историю: в топе будет «трек удалён», но прослушивания останутся |
| `listeners[].id` — первые 8 символов `sha256(secret + ip)` | «слушают из одного места или из десяти» без хранения адресов |
| `days` 1…365, мусор → 30 | окно ограничено, чтобы запрос не считал всю историю |

- Только владелец: `401` без токена, `405` на не-GET. `Cache-Control: no-store`.
- Пустой журнал — не ошибка: нули, заполненные дни и `hint` («Прослушиваний пока нет…»).
- События пишутся из двух мест: `POST /api/tracks/:id/listen` (своё прослушивание)
  и `GET /s/:token/stream/:id` (гость по ссылке). Скачивание прослушиванием **не**
  считается.
- Таблица `listen_events` (миграция `012-listen-events`) — лента событий, а не
  состояние: `listens` хранит «где я сейчас», и для «сколько слушали во вторник» его
  недостаточно.
- В интерфейсе: раздел **«Дашборд»** в вебе (`#/dashboard`) и вкладка
  **«Прослушивания»** в панели (Windows/Android/`/admin`).

## «Для вас»: подборки по истории (J3, v0.22.0)

Не рекомендации «как у стриминга» (для них нужны чужие вкусы и эмбеддинги), а честный
ответ на вопрос «что включить сейчас» из собственной библиотеки: продолжить начатое,
вернуться в любимый жанр, вспомнить забытое.

### GET /api/personal?limit=12&seed=20768 → `200 PersonalFeed`

```json
{
  "greeting": "Добрый вечер",
  "generatedAt": "2026-11-11T18:02:00Z",
  "seed": 20768,
  "libraryTracks": 214,
  "hint": null,
  "sections": [
    {
      "key": "continue",
      "title": "Продолжить слушать",
      "reason": "вы остановились на середине",
      "tracks": [{ "id": "…", "title": "…", "sources": { } }]
    }
  ]
}
```

| Секция | Что попадает | Условие |
|---|---|---|
| `continue` | начатые треки | прогресс 5…95 % |
| `top-genre` | «Любимый жанр: Ambient» | жанр с наибольшим весом (прослушивания + лайк + факт прослушивания); свежепрослушанное — в конце списка |
| `forgotten` | «Забытое» | не слушали 30+ дней или никогда; свежие загрузки сюда не попадают |
| `fresh` | «Новое в библиотеке» | добавлено за последние 14 дней |
| `liked-mix` | «Из любимого» | лайки, перемешаны |

- Секций может быть 0–5; пустая история — не ошибка: `sections: []` и `hint`
  («Послушайте пару треков…», «Библиотека пуста…»).
- `seed` фиксирует перемешивание: подборка не перетасовывается при каждом обновлении
  страницы, но меняется раз в день (по умолчанию seed = номер дня).
- `limit` — размер каждой секции (1…50, по умолчанию 12).
- Только владелец: `401` без токена. В локальном режиме (GitHub Pages) истории нет,
  и веб говорит об этом прямо, а не показывает пустую ленту.
- Все расчёты — по своей библиотеке (до 2000 треков), без внешних сервисов: подборки
  работают на домашнем сервере без интернета.

## Умные плейлисты (C7, v0.21.0)

Плейлист, который хранит **правила**, а не треки: состав пересчитывается при каждом
открытии, поэтому новый трек с нужным жанром попадает в него сам.

### GET /api/smart-playlists → `200 SmartPlaylist[]`
### POST /api/smart-playlists `{ "name": "Вечер", "description": "…", "rules": { … } }` → `201 SmartPlaylist`
### GET /api/smart-playlists/:id → `200 SmartPlaylist`
### PATCH /api/smart-playlists/:id `{ "name"?, "description"?, "rules"? }` → `200 SmartPlaylist`
### DELETE /api/smart-playlists/:id → `204`
### GET /api/smart-playlists/:id/tracks → `200 Track[]` + `X-Total-Count` (все совпадения, не только выданные)

`SmartPlaylist` = `id, name, description, rules, smart: true, trackCount, summary,
createdAt, updatedAt`. `trackCount` — сколько треков подходит **сейчас** (а не длина
сохранённого списка), `summary` — подписи правил по-русски («жанр = Ambient и
длительность ≥ 300»), чтобы клиенту не нужен был свой словарь.

**Правила**

```json
{
  "match": "all",
  "rules": [
    { "field": "genre", "op": "is", "value": "Ambient" },
    { "field": "duration", "op": "gte", "value": 300 },
    { "field": "notPlayedDays", "op": "gte", "value": 30 }
  ],
  "sort": "plays",
  "limit": 40
}
```

| Поле | Операторы | Смысл |
|---|---|---|
| `genre`, `artist`, `album` | `is`, `contains`, `empty`, `any` | жанр/исполнитель/альбом; `any` — «заполнено» |
| `title` | `is`, `contains` | название трека |
| `liked` | `is` (`true`/`false`) | лайк |
| `year` | `gte`, `lte`, `eq` | год добавления в библиотеку (не год выпуска) |
| `plays`, `duration` | `gte`, `lte`, `eq` | прослушивания, секунды |
| `addedDays` | `lte` | добавлен не позже N дней назад |
| `notPlayedDays` | `gte`, `lte` | не слушали N дней; «никогда» считается как 1 000 000 дней |

`match`: `all` (И, по умолчанию) или `any` (ИЛИ). `sort`: `recent`, `oldest`, `title`,
`artist`, `plays`, `duration`, `random`, `field:<поле>` (без учёта регистра).
`limit`: 1…500, по умолчанию 100 — **часть правила**: «Топ-40» без него перестаёт быть
топ-40.

**Ошибки правил** — `400` с кодом `invalid_rules`, `invalid_rule`, `unknown_field`,
`unknown_op`, `invalid_value`, `too_many_rules` и текстом, где именно ошибка
(«Правило №2: оператор «gte» не подходит для поля «genre»»). Если правила в базе
испорчены (например, руками поправили JSON), `GET …/tracks` отвечает `422 invalid_rules`
— это лучше, чем `500`.

**Безопасность.** `field` и `op` сверяются с закрытым списком, а значения уходят в SQL
**только параметрами** — правило вида `{"value": "Ambient'; DROP TABLE tracks; --"}`
становится просто несуществующим жанром. Покрыто тестами (`services/api/test/smart.test.js`,
в том числе проверка, что таблица `tracks` после такой попытки на месте).

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
| `SHARE_DEFAULT_TTL_MS` | `604800000` (7 дней) | срок жизни ссылки по умолчанию |
| `PUBLIC_URL` | из заголовков запроса | публичный адрес для ссылок и OG-тегов (нужен за прокси) |

## Версионирование

- `/api/v1/*` — стабильный контракт (алиас `/api/*`, они идентичны).
- `GET /api/v1/openapi.json` — схема OpenAPI 3.1, собирается из кода
  (`services/api/src/openapi.js`), поэтому не расходится с реализацией.
- Версия приложения — в `/api/health`, `/api/me` и `info.version` схемы.
- Ломающие изменения — только через `/api/v2`; в v1 допускаются новые поля.
