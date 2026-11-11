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
⬇️ релизы           →  docs/RELEASES.md  (web, Windows, APK — куда и как)
🔗 прямые ссылки     →  docs/DOWNLOADS.md (APK, MSI, EXE — сразу файл)
```

## Прямые ссылки на скачивание

Файлы начинают качаться сразу, без страниц-прослоек. Полный список с размерами и
проверкой целостности — `docs/DOWNLOADS.md`.

**Android**

- Плеер Vision Audio 0.6.0 (последняя версия): https://github.com/visiontripin/Vision/releases/download/android-v0.6.0/VisionAudio-latest.apk
- Плеер 0.6.0 (фиксированная версия): https://github.com/visiontripin/Vision/releases/download/android-v0.6.0/VisionAudio-0.6.0-android.apk
- SHA-256 APK: https://github.com/visiontripin/Vision/releases/download/android-v0.6.0/VisionAudio-0.6.0-android.apk.sha256
- Админка / запуск сервера (подписан): https://github.com/visiontripin/Vision/releases/download/console-v0.1.1/VisionServer-latest.apk

**Windows**

- Плеер 0.3.0 — `.msi`: https://github.com/visiontripin/Vision/releases/download/desktop-v0.3.0/Vision.Audio_0.3.0_x64_en-US.msi
- Плеер 0.3.0 — `.exe`: https://github.com/visiontripin/Vision/releases/download/desktop-v0.3.0/Vision.Audio_0.3.0_x64-setup.exe
- Сервер + админка 0.1.1 — `.msi`: https://github.com/visiontripin/Vision/releases/download/console-v0.1.1/Vision.Server_0.1.1_x64_en-US.msi
- Сервер + админка 0.1.1 — `.exe`: https://github.com/visiontripin/Vision/releases/download/console-v0.1.1/Vision.Server_0.1.1_x64-setup.exe

**Linux**

- Плеер 0.3.0 — AppImage: https://github.com/visiontripin/Vision/releases/download/desktop-v0.3.0/Vision.Audio_0.3.0_amd64.AppImage
- Плеер 0.3.0 — `.deb`: https://github.com/visiontripin/Vision/releases/download/desktop-v0.3.0/Vision.Audio_0.3.0_amd64.deb

**Web** — https://visiontripin.github.io/Vision/

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
| Распределённый | метаданные на сервере, файлы на устройствах (Termux/ПК) | `STORAGE_MODE=metadata`, см. `docs/DISTRIBUTED.md` |

## Статус

| Платформа | Технология | Состояние |
|-----------|-----------|-----------|
| Web | React 19 + TS + Vite | ✅ PWA: вход, загрузка с волной, библиотека, поиск, плеер (+ полный экран «Сейчас играет» с волной-скраббером), плейлисты, лайки, статистика, приватные ссылки (раздел «Ссылки») и комментарии к секундам под ними. Есть локальный режим (IndexedDB) для GitHub Pages |
| API | Node 22 (`node:http` + `node:sqlite`) | ✅ v0.14.0: FTS5, подписанные медиа-URL, теги/обложки, дедуп, миграции, `/metrics`, OpenAPI, закладки SoundCloud, транскодинг opus/aac + HLS, **трекер реплик** (`blobs`/`blob_seeds`, `/seed`, репликация), **приватные ссылки** (`/s/:token`), **комментарии к секундам** (`/s/:token/comments`) |
| Android (сервер) | Termux + Node 22 + ffmpeg | ✅ v0.6.1: экономный профиль, автозапуск, доступ через Tailscale — `docs/TERMUX.md` |
| Android / iOS (приложение) | React Native (Expo 54) | ✅ v0.4.0: вход с любым адресом сервера, библиотека, плейлисты, плеер с фоном, офлайн-копии по `sha256`, пометка «нет источника», копия = реплика в трекере; **готовый APK в CI** — `docs/ANDROID.md`. Экран блокировки — dev build |
| Windows / Android (панель) | Tauri 2 + React | ✅ v0.1.0: **Vision Server** — отдельное приложение для запуска/эксплуатации: подключение к серверу, диагностика (диск, миграции, ffmpeg, файлы без источника), ссылки (перевыпуск/отзыв), библиотека; та же панель отдаётся сервером по `/admin` — `apps/console/README.md` |
| Windows / Linux (плеер) | Tauri 2 | ✅ v0.3.0: трей с управлением плеером, сворачивание в трей, глобальные медиа-клавиши, CI-сборка `.deb`/`.AppImage`/`.msi`/`.exe` и автообновление по `latest.json` — `docs/DESKTOP.md` |
| Хранилище | трекер реплик + сиды | ✅ v0.10.1: файлы живут на устройствах, сервер — реестр; `/api/tracks/:id/download`, `/seed/:hash`, репликация с проверкой SHA-256, экран «Источники файла» с ручным управлением копиями; офлайн-копии адресуются `sha256` — `docs/DISTRIBUTED.md` |

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
npm test                 # 170 контрактных тестов API: auth, upload+теги, дедуп, FTS, media, range,
                         # history, metrics, v1/OpenAPI, трекер реплик, приватные ссылки,
                         # комментарии к секундам, панель /admin, oEmbed и /embed-виджет, журнал,
                         # SPA-маршруты /share и хэш-ссылки, умные плейлисты по правилам,
                         # подборки «Для вас» по истории прослушиваний, дашборд
                         # прослушиваний
npm run test:local       # 103 клиентских теста: локальный режим (IndexedDB), zip, офлайн-кэш,
                         # геометрия волны и очередь в мобильном приложении, диагностика панели,
                         # код встраивания, время в журнале, разбор deep links и share target,
                         # разбор версий и манифеста обновлений, кэш библиотеки,
                         # перевод правил умного плейлиста в черновик формы
npm run test:scripts     # 9 тестов скриптов: latest.json и включение подписи обновлений
npm run test:all         # всё вместе
```

## Структура

```
apps/web          SPA: библиотека, плеер, загрузка (React + Vite)
apps/mobile       Expo-приложение Android/iOS (React Native)
apps/desktop      Tauri 2 оболочка Windows/Linux (плеер)
apps/console      Tauri 2: Vision Server — запуск и админка (Windows + Android), отдаётся по /admin
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

## Мобильное приложение

`apps/mobile` — Expo-клиент: вход с адресом домашнего сервера (Wi-Fi/Tailscale),
библиотека с поиском, плейлисты, плеер с фоновым воспроизведением и скачиванием
треков/плейлистов на устройство.

```bash
cd apps/mobile && npm install && npx expo start   # Expo Go на телефоне
```

**Готовый APK** (CI, без Expo-аккаунта) — Actions → «Android APK» → Run workflow;
файл появляется в релизе `android-v<версия>` (и постоянная ссылка `VisionAudio-latest.apk`):

```
https://github.com/visiontripin/Vision/releases/latest/download/VisionAudio-latest.apk
```

Подробности, подпись и установка — `docs/ANDROID.md`, ограничения — `apps/mobile/README.md`.

**Готовые приложения для Linux и Windows** (Tauri, тот же интерфейс плюс трей и медиа-клавиши) —
релиз `desktop-v<версия>`: `.deb`/`.AppImage` и `.msi`/`.exe`. Собирается в CI
(`.github/workflows/desktop.yml`), подробности — `docs/DESKTOP.md`. С версии 0.3.0 приложение
само проверяет обновления (`latest.json` в релизе) и ставит их по кнопке:

```
https://github.com/visiontripin/Vision/releases/tag/desktop-v0.3.0
```

План распределённого хранения (сервер без файлов, сиды на устройствах) — `docs/DISTRIBUTED.md`.

## Распределённое хранение: трекер и сиды

Аудио не обязано лежать на сервере. Файл адресуется по `sha256`, а сервер держит
реестр реплик: кто прямо сейчас может его отдать.

```bash
# узел A — загружает и раздаёт (Termux дома, ПК)
DATA_DIR=~/vision-a DEVICE_ID=node-a PUBLIC_URL=http://192.168.1.10:4000 npm start
# узел B — только метаданные, качает с живых сидов
DATA_DIR=~/vision-b STORAGE_MODE=metadata DEVICE_ID=node-b npm start
```

- `GET /api/tracks/:id/download` — 302 на живое устройство или `409 no_source`;
- `GET /seed/<sha256>?exp&sig` — отдача файла с устройства (Range, ETag, HEAD);
- `POST /api/blobs/<sha256>/replicate` — забрать файл с сида, сверить хеш, раздавать самому;
- в интерфейсе: «нет источника» у недоступного трека и число устройств с копией.

Подробности, схема данных и настройки — `docs/DISTRIBUTED.md`.

## Приватные ссылки

Отправить другу один трек или плейлист можно, не открывая библиотеку: ссылка живёт
заданный срок, отзывается одной кнопкой и открывается без пароля.

- Меню трека → **«Поделиться ссылкой»**, страница плейлиста → **«Ссылка»**,
  все ссылки и их статистика — раздел **«Ссылки»**.
- `POST /api/shares` выдаёт токен **один раз** (в базе только `sha256`), гость открывает
  `/s/<token>`: страница с плеером, кнопка «Скачать», OG-карточка в мессенджере.
- Ссылка на плейлист отдаёт только его треки; чужой трек — `403`. Отзыв/перевыпуск/истечение —
  `410` с человеческим текстом. Статистика открытий видна только владельцу, IP гостей
  хранятся как хеши.
- В локальном режиме (GitHub Pages) ссылки не работают — там нет сервера, который откроется
  у друга. Подробности — `docs/API.md` и `docs/adr/0007-private-links.md`.

## Офлайн и установка как приложение

Web-версия — PWA: её можно поставить на домашний экран, а треки — скачать на
устройство.

- В меню трека **«Скачать офлайн»** — копия в Cache Storage, прогресс, метка в списке.
- Плеер сам играет копию: без сети, без запросов и без трафика.
- Лимит кэша (512 МБ по умолчанию) с вытеснением старых копий, настройка и очистка —
  в «Статистике».
- Оболочка кэшируется service worker'ом, а **список библиотеки** — снимком в
  `localStorage` (`apps/web/src/library-cache.ts`): если сервер недоступен, вместо
  пустого экрана показывается сохранённая библиотека и честный баннер «нет связи —
  показана копия, сохранена 2 часа назад». Снимок привязан к адресу API (после
  переключения на другой сервер чужие треки не показываются), а если библиотека не
  влезает в ~5 МБ, сохраняется часть с пометкой «первые N из M треков».
- В офлайне правки только читаются: лайк или переименование не копятся в очередь —
  сервер о них не узнает, и обещать «синхронизируем потом» было бы обманом.

Кэш браузера работает только на **HTTPS или localhost**. Для доступа с телефона
к домашнему серверу это означает Tailscale/Cloudflare Tunnel (`docs/TERMUX.md` §5).

## Сервер на телефоне (Termux)

Домашний сервер можно держать на Android — телефон в роли мини-ПК:

```bash
pkg install -y git
git clone https://github.com/visiontripin/Vision.git ~/Vision && cd ~/Vision
bash scripts/termux-setup.sh
```

Скрипт ставит `nodejs`/`ffmpeg`, собирает web, создаёт автозапуск через Termux:Boot
и печатает адрес для браузера. На Android сервис сам включает экономный режим:
только opus, без HLS, 2 потока ffmpeg. Доступ извне — через Tailscale или
Cloudflare Tunnel, не пробросом порта. Полная инструкция: **`docs/TERMUX.md`**.

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
| `TRANSCODE_CODECS` | `opus,aac` (`opus` на Android) | какие варианты готовить |
| `HLS_ENABLED` | `1` (`0` на Android) | HLS-нарезка |
| `FFMPEG_THREADS` | — (`2` на Android) | потоки ffmpeg, `0` — на усмотрение ffmpeg |
| `DATA_DIR` | `./data` | медиа, обложки, SQLite |
| `DB_FILE` | `$DATA_DIR/vision.db` | путь к БД |
| `STORAGE_MODE` | `local` | `metadata` — не хранить аудио, только адреса сидов |
| `SEED_ENABLED` | `1` | `0` — узел ничего не раздаёт (`/seed` → 403) |
| `SEED_DIR` | `$DATA_DIR/seed` | каталог раздаваемых блобов `<sha256>.<ext>` |
| `DEVICE_ID` | `origin` | имя устройства в реестре реплик (`termux`, `laptop`) |
| `PUBLIC_URL` | — | публичный адрес узла для других устройств (Tailscale, туннель) |
| `SEED_TTL_MS` | `180000` | сколько живёт heartbeat раздающего сида |
| `REPLICA_TTL_MS` | `30 дней` | сколько живёт запись о копии без раздачи |
| `EXTRA_ORIGINS` | — | через запятую: адреса соседних узлов для CSP (`media-src`) |

Лимит офлайн-кэша живёт на клиенте (`localStorage: vision.offline.limitMb`),
по умолчанию 512 МБ.

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
