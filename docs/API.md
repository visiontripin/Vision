# API v1

Базовый URL: `http://<host>:4000`. Все ответы — JSON, кроме стриминга и обложек.
Авторизация: `Authorization: Bearer <token>` (кроме `/api/health` и `/api/auth/login`).
Ошибки: `{ "error": { "code": "string", "message": "string" } }` + соответствующий HTTP-статус.

## Auth

### POST /api/auth/login
```json
{ "password": "vision" }
```
→ `200 { "token": "...", "expiresAt": "2026-12-09T00:00:00.000Z" }`
→ `401 unauthorized` · `429 rate_limited`

### GET /api/me
→ `200 { "ok": true, "role": "owner" }`

## Tracks

### GET /api/tracks
Query: `q` (поиск по title/artist/album/genre), `genre`, `liked=1`, `sort=recent|title|plays|duration`, `limit` (по умолчанию 500).
→ `200 Track[]` — без поля `peaks` (оно в `GET /api/tracks/:id`).

### POST /api/tracks
Query: `title`, `artist`, `album`, `genre`, `description`, `peaks` (JSON-строка, до 8 КБ).
Body: сырые байты аудио. `Content-Type` — реальный тип файла.
→ `201 Track` · `400 invalid_audio` · `413 too_large` (лимит 500 МБ) · `415 unsupported_type`

### GET /api/tracks/:id
→ `200 Track` (включая `peaks`)

### PATCH /api/tracks/:id
Body JSON: любое из `title, artist, album, genre, description, liked`.
→ `200 Track`

### DELETE /api/tracks/:id
Удаляет файл, обложку, связи с плейлистами. → `204`

### GET /api/tracks/:id/stream
Range-запросы → `206` + `Content-Range`; без Range → `200`.
Заголовки: `Accept-Ranges: bytes`, `Content-Type`, `Content-Length`, `Cache-Control: private, max-age=3600`.

### PUT /api/tracks/:id/cover
Body: изображение (jpeg/png/webp, ≤ 8 МБ). → `204`

### GET /api/tracks/:id/cover
→ `200` изображение + `ETag`; `404` если обложки нет.

### POST /api/tracks/:id/play
Инкремент счётчика. → `204`

## Playlists

### GET /api/playlists
→ `200 Playlist[]` (`id, name, description, createdAt, trackCount, duration`)

### POST /api/playlists
```json
{ "name": "Вечер", "description": "…" }
```
→ `201 Playlist`

### PATCH /api/playlists/:id → `200 Playlist`
### DELETE /api/playlists/:id → `204`

### GET /api/playlists/:id/tracks → `200 Track[]`
### POST /api/playlists/:id/tracks `{ "trackId": "..." }` → `204`
### DELETE /api/playlists/:id/tracks/:trackId → `204`

## Stats

### GET /api/stats
```json
{ "tracks": 42, "playlists": 5, "liked": 12, "plays": 310,
  "duration": 91234, "diskFreeMb": 18234, "version": "1.0.0" }
```

## System

### GET /api/health
→ `200 { "ok": true, "tracks": 42, "diskFreeMb": 18234, "version": "1.0.0" }`

## Модель Track

```ts
type Track = {
  id: string; title: string; artist: string; album: string | null;
  genre: string | null; description: string | null;
  mime: string; size: number; duration: number;   // секунды
  peaks: number[] | null; cover: boolean;
  plays: number; liked: boolean; createdAt: string;
};
```
