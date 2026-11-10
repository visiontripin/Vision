# Vision Audio

[![Demo](https://img.shields.io/badge/demo-visiontripin.github.io%2FVision-ff5a1f?style=flat-square)](https://visiontripin.github.io/Vision/)
[![CI](https://github.com/visiontripin/Vision/actions/workflows/ci.yml/badge.svg)](https://github.com/visiontripin/Vision/actions/workflows/ci.yml)

Личный аналог веб-версии SoundCloud: загрузка своих треков, библиотека, волновой плеер,
плейлисты и лайки. Один владелец, приватность по умолчанию. Дальше — приложения под
**Android, iOS, Windows, Linux** на том же API.

```
🤖 роли и процесс  →  docs/ROLES.md      (RACI + системные промпты для агентов)
📦 продукт         →  docs/PRODUCT.md    (scope, сценарии, критерии приёмки)
🏗  архитектура     →  docs/ARCHITECTURE.md
🔌 контракт API    →  docs/API.md
🎧 про контент      →  docs/CONTENT.md
🗺  план            →  docs/IMPROVEMENTS.md  (улучшения, оптимизации, дорожная карта v2)
🔍 разбор рынка     →  docs/research/SOUNDCLOUD-TEARDOWN.md
🚀 эксплуатация     →  docs/RUNBOOK.md
```

## Смотреть без сервера (GitHub Pages)

Web-версия умеет работать **полностью в браузере**: библиотека, обложки-заглушки,
плейлисты и лайки хранятся в IndexedDB, аудиофайлы — там же. Сервер не нужен,
данные не покидают устройство.

- 🌐 **Демо:** https://visiontripin.github.io/Vision/ — открывается сразу, пароля нет,
  загруженные треки сохраняются в вашем браузере (другой браузер = другая библиотека).
- Сборка для статики: `npm run build:pages` → `apps/web/dist-pages`
  (переменные `VITE_LOCAL_MODE=1`, `BASE_PATH=/Vision/`).
- Сайт собирается и публикуется workflow **Deploy web (GitHub Pages)** при каждом
  пуше в `main`. Если Pages отключён в настройках репозитория, тот же бандл лежит
  в артефактах этого workflow (`vision-web-static`): скачайте, распакуйте и
  откройте `index.html` — сервер не нужен.

| Режим | Хранение | Запуск |
|-------|----------|--------|
| Self-hosted | SQLite + файлы на сервере, доступ с любых устройств | `npm start` |
| Локальный (Pages) | IndexedDB браузера, без сервера | `npm run build:pages` |

## Статус

| Платформа | Технология | Состояние |
|-----------|-----------|-----------|
| Web | React 19 + TS + Vite | ✅ MVP работает: вход, загрузка с волной, библиотека, поиск, плеер, плейлисты, лайки, статистика. Есть локальный режим (IndexedDB) для GitHub Pages |
| API | Node 22 (`node:http` + `node:sqlite`) | ✅ v0.6.0: FTS5, подписанные медиа-URL, теги/обложки, дедуп, миграции, `/metrics`, OpenAPI, закладки SoundCloud, транскодинг opus/aac + HLS |
| Android / iOS | React Native (Expo) | 🟡 каркас + вход/библиотека/плеер, нужны сборки и фоновое аудио |
| Windows / Linux | Tauri 2 | 🟡 каркас + медиа-клавиши, нужна сборка на целевых ОС |

## Быстрый старт

```bash
npm install
npm run build            # собирает web в apps/web/dist
npm start                # API + статика на http://localhost:4000
```

Откройте http://localhost:4000 — пароль по умолчанию **`vision`**
(переопределяется `VISION_PASSWORD`).

Демо-библиотека (5 сгенерированных треков, плейлист и лайк):

```bash
node scripts/seed-demo.mjs
```

Разработка с горячей перезагрузкой (два терминала):

```bash
npm run dev:api          # API на :4000
npm run dev              # Vite на :5173, проксирует /api
```

Тесты API:

```bash
npm test                 # 16 контрактных тестов API: auth, upload+теги, дедуп, FTS, media, range, history, metrics, v1/OpenAPI
npm run test:local       # 3 теста локального режима (IndexedDB через fake-indexeddb)
npm run test:all         # всё вместе
```

## Структура

```
apps/web          SPA: библиотека, плеер, загрузка (React + Vite)
apps/mobile       Expo-приложение Android/iOS (React Native)
apps/desktop      Tauri 2 оболочка Windows/Linux
packages/shared   общие типы + HTTP-клиент + утилиты (используются всеми клиентами)
services/api      API, SQLite, стриминг, загрузка
docs/             роли, продукт, архитектура, API, roadmap, runbook, ADR
scripts/          seed-demo, backup
data/             runtime: медиа, обложки, БД (в git не попадает)
```

## Возможности web-версии

- **Загрузка**: drag&drop (в окно или в модалку), несколько файлов, прогресс по каждому,
  название/исполнитель из имени файла, жанр и альбом для всех сразу, лимит 500 МБ.
- **Массовый импорт**: папка целиком, ZIP (свой парсер + `DecompressionStream`) и
  список ссылок SoundCloud из `.txt/.csv` — см. `docs/CONTENT.md`.
- **Волна**: считается в браузере через Web Audio API (RMS → 320 пиков + сглаживание),
  поэтому waveform есть сразу.
- **Аудио 2.0**: сервер в фоне перекодирует загруженное в opus 96k / aac 128k с
  нормализацией −14 LUFS и режет HLS по 6 с. Клиент сам выбирает кодек по `canPlayType()`
  и прогревает следующий трек (первые 256 КБ в HTTP-кэш). **Без ffmpeg** всё работает
  как раньше — отдаётся оригинал (см. `docs/RUNBOOK.md`, раздел 5.2).
- **Плеер**: один аудио-элемент, seek по волне, громкость, shuffle, повтор (офф/все/один),
  очередь с удалением, медиа-клавиши браузера (Media Session), восстановление позиции
  после перезагрузки, горячие клавиши: `Space`, `←/→` (±5 с), `Shift+←/→`, `M`.
- **Библиотека**: поиск, фильтр по жанрам, сортировка, лайки, счётчики прослушиваний.
- **Плейлисты**: создание из меню трека и из раздела, «Слушать всё», удаление треков.
- **Доступность**: управление с клавиатуры, ARIA для плеера и волны, контраст AA, адаптив до 360 px.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|------------|--------------|-----------|
| `PORT` | `4000` | порт API |
| `HOST` | `0.0.0.0` | интерфейс |
| `VISION_PASSWORD` | `vision` | пароль владельца |
| `VISION_SECRET` | HMAC от пароля | ключ подписи токенов и медиа-ссылок (задайте свой в продакшене) |
| `MEDIA_URL_TTL_MS` | `1800000` | срок жизни подписанных ссылок на поток и обложку |
| `METRICS_TOKEN` | — | если задан, `/metrics` требует Bearer |
| `FFMPEG_PATH` | — | путь к ffmpeg (иначе `ffmpeg-static` из npm, затем `PATH`) |
| `TRANSCODE` | `1` | `0` — не транскодировать (только оригиналы) |
| `HLS_ENABLED` | `1` | `0` — без HLS-нарезки |
| `TRANSCODE_BACKFILL` | `0` | `1` — догнать старые треки при старте |
| `DATA_DIR` | `./data` | медиа, обложки, SQLite |
| `DB_FILE` | `$DATA_DIR/vision.db` | путь к БД |

## Заметки по безопасности

- Токен — HMAC-SHA256, живёт 30 дней, передаётся только в `Authorization: Bearer`;
  для `<audio>`/`<img>` (они не умеют заголовки) выдаются короткоживущие
  подписанные ссылки `GET /api/media?ids=` (HMAC + TTL, по умолчанию 30 минут).
  Токен в URL не попадает — в v0.2.0 `?token=` удалён.
- Загрузка проверяется по magic bytes, а не по расширению; имена файлов на диске — UUID.
- `path.resolve` + проверка префикса исключают path traversal в статике.
- Rate limit на вход: 10 попыток / 5 минут на IP.
- Перед публикацией в интернет: HTTPS через reverse proxy, свой `VISION_SECRET`,
  бэкапы и ограничение доступа по VPN — см. `docs/RUNBOOK.md`.

## Лицензия

Личный проект, использование на своё усмотрение.
