# Архитектура

## 1. Принципы

1. **Один бэкенд, много клиентов.** API — единственный источник правды; типы и HTTP-клиент живут в `packages/shared`.
2. **Стриминг вместо скачивания.** Аудио отдаётся с поддержкой HTTP Range → мгновенный seek на всех платформах.
3. **Минимум зависимостей на сервере.** Node 22 (`node:http`, `node:sqlite`) — меньше поверхность атаки и быстрый деплой.
4. **Файлы — на диске, метаданные — в БД.** Медиа не хранится в базе; путь строится по id, а не по имени файла (path traversal невозможен).
5. **Приватность по умолчанию.** Никаких публичных URL без явного шаринга; авторизация токеном на всех `/api/*`, кроме `/api/auth/*` и `/api/health`.

## 2. Стек по платформам

| Платформа | Технология | Почему |
|-----------|-----------|--------|
| Web | React 19 + TypeScript + Vite | быстрый DX, общий код и типы |
| API | Node 22 + `node:http` + `node:sqlite` | ноль зависимостей, SQLite для одного пользователя |
| Android / iOS | React Native (Expo) | один код на две ОС, нативные модули для фонового аудио |
| Windows / Linux | Tauri 2 (Rust shell + web-бандл) | 5–10 МБ вместо Electron, доступ к трею и медиа-клавишам |
| Хранилище | локальный диск + S3-совместимое (опционально) | личное использование → сервер и есть хранилище |

## 3. Структура репозитория (npm workspaces)

```
Vision/
├─ apps/
│  ├─ web/                 # SPA: библиотека, плеер, загрузка
│  ├─ mobile/              # Expo-приложение Android/iOS (этап 3)
│  └─ desktop/             # Tauri-оболочка Windows/Linux (этап 4)
├─ services/api/           # HTTP API + стриминг + SQLite
├─ packages/shared/        # типы, API-клиент, общие хелперы
├─ docs/                   # ROLES, PRODUCT, ARCHITECTURE, API, ROADMAP, ADR
└─ data/                   # runtime: media/, covers/, vision.db (не в git)
```

## 4. Модель данных

```sql
tracks (
  id TEXT PRIMARY KEY,          -- uuid
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT 'Unknown',
  album TEXT, genre TEXT,
  description TEXT,
  mime TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  duration REAL NOT NULL DEFAULT 0,
  peaks TEXT,                   -- JSON: 200 нормализованных значений 0..1
  cover_mime TEXT,
  plays INTEGER NOT NULL DEFAULT 0,
  liked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)

playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TEXT)
playlist_tracks (playlist_id TEXT, track_id TEXT, position INTEGER,
                 PRIMARY KEY (playlist_id, track_id))

shares (token TEXT PRIMARY KEY, track_id TEXT, expires_at TEXT)  -- этап 4
```

Индексы: `tracks(created_at)`, `tracks(liked)`, `playlist_tracks(playlist_id, position)`.

## 5. Стриминг аудио

- `GET /api/tracks/:id/stream` поддерживает `Range: bytes=start-end` → `206 Partial Content`,
  `Accept-Ranges: bytes`, `Content-Range`, `Cache-Control: private, max-age=3600`.
- Клиент ставит `audio.src` один раз; браузер сам делает Range-запросы для seek.
- Ограничение: один диапазон на запрос (достаточно для `<audio>`; multipart/byteranges не нужен).
- Большие файлы читаются потоком (`fs.createReadStream`), память не растёт.

## 6. Загрузка

1. Клиент читает файл через Web Audio API → длительность + 200 пиков волны.
2. `POST /api/tracks?title=…&artist=…` с сырым аудио в теле (не multipart — проще и быстрее).
3. Сервер: лимит 500 МБ, проверка magic bytes (ID3/RIFF/OggS/ftyp), запись во временный
   файл → атомарный `rename` → запись в БД. При ошибке временный файл удаляется.
4. Обложка: `PUT /api/tracks/:id/cover` (image/*, ≤ 8 МБ), отдаётся с ETag.

## 7. Аутентификация

- `POST /api/auth/login {password}` → `{ token }`, где token = `base64(payload).HMAC-SHA256`.
- Пароль сравнивается с `VISION_PASSWORD` (env, по умолчанию `vision` для локального демо).
- Клиент хранит токен в `localStorage`, отправляет `Authorization: Bearer <token>`.
  Cookies не используются — приложение одинаково работает в iframe/превью и в нативной оболочке.
- Rate limit на `/api/auth/login`: 10 попыток / 5 минут на IP.

## 8. Web-клиент

- Состояние: React-контексты `Auth`, `Library`, `Player` (без внешнего state-менеджера).
- `PlayerProvider` держит единственный `<audio>` элемент, очередь, shuffle/repeat,
  позицию и громкость в `localStorage` (восстановление при перезагрузке).
- Роутинг: hash-роутер (без зависимостей): `#/`, `#/liked`, `#/playlists/:id`, `#/stats`.
- Стили: CSS-переменные-токены, тёмная тема, orange-акцент; компоненты лежат в `src/components`.
- Клиентские пики: `AudioContext.decodeAudioData` → RMS по блокам → 200 значений.
- Комментарии к секундам рисуются в модалке ссылки (`components/ShareModal.tsx`):
  лента выбранной ссылки, добавление от имени владельца, удаление. Гостевая версия —
  SSR в `shares.js`, без бандла.
- Полный экран плеера — `src/components/NowPlaying.tsx` (слой `z-index: 65`, состояние только
  из `usePlayer`). Волна рисуется на `<canvas>` (`Waveform` в `ui.tsx`), перемотка —
  `pointerdown/move` + `setPointerCapture`, подсказка времени — параметр `timeAt`.

## 8.1 Панель администрирования (`apps/console`)

- Отдельное приложение: Vite + React, оболочка Tauri 2 → окно Windows (`.msi`/`.exe`)
  и APK Android (`docs/adr/0009-server-console.md`).
- Тот же бандл сервер отдаёт по `/admin` (`serveConsole` в `server.js`): отдельная
  статика, `noindex`, SPA-фолбэк, `503` с инструкцией, если не собрана.
- Права Tauri — `core:default` и собственная команда `platform()`; ни `shell`, ни `fs`.
- Чистая логика (`src/lib.ts`: `diagnose`, `diskState`, `humanBytes`, `expiry`, `ago`)
  под тестами; интерфейс только показывает её результат.

## 8.2 Встраивание (E4): `/embed/:token` и `/api/oembed`

- `services/api/src/embed.js` — чистые функции (`parseShareUrl`, `embedSize`, `embedMeta`,
  `renderEmbedWidget`, `oembedPayload`, `oembedXml`) и CSS рядом (`embed.css` → `/embed/widget.css`).
- Виджет не ходит в API: `<audio src="/s/:token/stream/:id">` использует гостевые маршруты,
  поэтому статистика ссылки остаётся единой. Открытие виджета **не** инкрементирует `plays`
  (вставка в блог не должна сжигать лимит), прослушивание пишется в `share_hits`.
- `frame-ancestors *` без `X-Frame-Options` — иначе встраивание невозможно; всё остальное
  закрыто (`default-src 'none'`, `Referrer-Policy: no-referrer`, `noindex`).
- oEmbed — публичный эндпоинт без авторизации, принимает только свои адреса (`invalid_url`),
  отдаёт `no-store` и `Access-Control-Allow-Origin: *`; `PUBLIC_URL` определяет абсолютные
  адреса в `html`/`thumbnail_url` (за прокси без него они собираются из заголовков запроса).
- Клиент собирает код встраивания из уже выданной ссылки (`embedCode`/`oembedUrl`
  в `@vision/shared`), потому что токен показывается один раз.

## 8.3 Журнал действий (G10)

- `services/api/src/audit.js`: словарь действий (`AUDIT_ACTIONS`), `audit()` (запись),
  `listAudit()` (лента с фильтрами), `auditSummary()`, `pruneAudit()`, `auditIpHash()`.
  Таблица `audit_log` — миграция `010`.
- `audit()` вызывается из обработчиков (`server.js`) в точке успеха действия, а не из
  middleware: журнал описывает то, что произошло, а не то, что запросили. Исключение —
  гость на `/s/*`, где событие и есть запрос (`share.open/stream/download`).
- Запись никогда не роняет запрос: ошибка БД уходит в лог как `audit write failed`.
  Схлопывание (`share.open` за 10 минут от того же `ip_hash`) — `UPDATE details.repeat`,
  поэтому журнал не превращается в список обновлений страницы.
- `request_id` = `X-Request-Id` ответа: строка журнала сопоставима с логом и с ответом,
  который видел клиент. Читается только владельцем (`/api/audit/*`).

## 8.4 Вход по ссылке и share target (F1/F5)

- Разбор входящих адресов — чистые модули: `apps/web/src/deep-link.ts`
  (`parseDeepLink`, `parseShareTarget`, `canNativeShare`) и
  `apps/mobile/src/lib/deeplink.ts` (`parseIncoming`, `parseSharedIntent`).
  Никакого React внутри: ссылки приходят из чужих приложений, и «пустой экран»
  отлаживать дороже всего.
- Схема `visionaudio://` и веб-хэш `#/track/<id>` разбираются одной функцией:
  схема приводится к http-адресу через подставную базу (`new URL` с нестандартной
  схемой делает первый сегмент хостом и теряет путь — это был реальный дефект).
- Веб: маршрут `#/track/<id>(/<секунды>)` включает трек один раз на ссылку
  (`openedLink` в `App.tsx`), иначе любой перерендер возвращал бы позицию в начало.
- Share target: `manifest.webmanifest` → `/share` (GET). Страница
  `ShareTargetPage.tsx` показывает, что пришло, и загружает только по нажатию —
  автоматическая загрузка по чужой ссылке была бы способом залить что угодно.
- Android: `intentFilters` (`VIEW` + `visionaudio`, `SEND` + `audio/*`/`text/plain`),
  `DeepLinkHandler` обрабатывает и холодный старт, и ссылку в открытом приложении.
- Сервер новых эндпоинтов не получил: `/share` отдаётся обычным SPA-фолбэком
  (проверяется `services/api/test/spa.test.js`).

## 9. Нативные приложения

- **Mobile**: Expo + `expo-av` (или `react-native-track-player` для фона), `expo-file-system`
  для офлайн-кэша, `expo-notifications` для медиа-контролов. Общий клиент — `@vision/shared`.
- **Mobile, полный плеер**: `src/screens/NowPlaying.tsx` (модалка на весь экран) + волна
  `src/components/Waveform.tsx` на `PanResponder` (без сторонних слайдеров). Геометрия
  волны — чистая `src/lib/wave.ts` под `node --test`: усреднение пиков, раскладка столбцов,
  «проигран ли столбец», автоскролл, формат времени.
- **Desktop**: Tauri 2, `frontendDist` указывает на `apps/web/dist`; плагины: `global-shortcut`,
  `tray-icon`, `updater`. Capabilities — минимальные (окно, события, hotkeys, updater).
  Трей и «свернуть в трей» — в `src-tauri/src/main.rs`, связь с плеером — `apps/web/src/desktop.ts`
  (события `media:*` наружу, `player_state` внутрь), см. `docs/DESKTOP.md`.

## 10. Наблюдаемость и эксплуатация

- `GET /api/health` → `{ ok, tracks, diskFreeMb, version }` для мониторинга и CI-смоука.
- Логи — JSON-строки в stdout, без имён файлов пользователя и токенов.
- Бэкап: `sqlite3 .backup` + `rsync data/media` (скрипт `scripts/backup.sh`), проверка восстановления — месяц.
- Деплой: один процесс API + статика web; опционально Caddy/Nginx с TLS.
- Приватные ссылки (`/s/<token>`) — отдельный публичный контур: гостевой запрос не
  проходит через `authorized()`, но не может выйти за пределы одной цели
  (`docs/adr/0007-private-links.md`).

## 11. ADR (заведены)

| # | Решение |
|---|---------|
| 0001 | SQLite вместо Postgres: один пользователь, нулевое администрирование |
| 0002 | Bearer-токен вместо cookie-сессий: iframe-превью и нативные оболочки |
| 0003 | Сырое тело запроса для загрузки вместо multipart: меньше кода, потоковая запись |
| 0004 | React Native + Tauri вместо «веб-обёрток»: один TypeScript-стек, нативные интеграции |
| 0005 | Пики волны считает клиент: нет ffmpeg на сервере, waveform появляется сразу |
| 0006 | Локальный режим (IndexedDB) для статического хостинга: сайт без сервера |
| 0007 | Приватные ссылки: случайный токен в пути + `sha256` в БД, SSR-страница с OG |
