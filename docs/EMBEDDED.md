# Сервер внутри приложения (вариант A) и общая библиотека (вариант D)

Два режима работы, которые дополняют друг друга:

| | Что это | Когда работает |
|---|---|---|
| **A. Сервер на телефоне** | Node-рантайм + HTTP-сервер внутри APK | всегда, пока приложение в памяти |
| **D. Общая библиотека** | реестр на вашем сервере Vision | в любой сети: Wi-Fi, мобильный интернет, гости |

D не выключается, когда работает A. Иначе получилось бы ровно то, от чего уходили:
одна сеть работает, другая нет.

## Зачем сервер в телефоне, если есть реестр

- **Полный API на устройстве** — библиотека, обложки, статистика, `/api/health`
  без интернета и без внешнего сервера.
- **Диагностика на месте** — тестер запросов работает на телефоне, без компьютера
  и `adb`.
- **Задел на «раздать другим в своей сети»** — тот же сервер слушает `0.0.0.0`
  по явному разрешению (`--public`), но по умолчанию только петлю.

Чего A **не** решает: доступ снаружи. За NAT оператора до телефона не достучаться,
адрес меняется, система усыпляет приложение. Именно поэтому общая библиотека идёт
через реестр (см. `docs/SYNC.md`).

## Как устроено

```
┌──────────────────────────── APK (Android) ────────────────────────────┐
│                                                                       │
│  React Native (Hermes)                                                │
│    App.tsx ── startEmbeddedServer() ── NativeModules.VisionNode       │
│    экраны: MainScreen → SettingsScreen → ServerStatusScreen → Tester   │
│                                   │ JNI                               │
│                                   ▼                                   │
│  libvisionnode.so  ── node::Start(argv) ──►  libnode.so (Node 24)     │
│                                   │                                   │
│                     bootstrap.mjs (assets → filesDir)                 │
│                       └ HTTP на 127.0.0.1:4000                        │
│                            /api/health  /api/files  /files/…          │
│                            /api/shutdown                              │
└───────────────────────────────────────────────────────────────────────┘
```

Файлы:

| Путь | Что делает |
|---|---|
| `apps/mobile/nodejs/embedded/bootstrap.mjs` | точка входа в Node: HTTP-сервер, `state.json`, обработка падений |
| `apps/mobile/nodejs/android/vision-node-jni.cpp` | JNI: `node::Start` в потоке, stdout/stderr → logcat |
| `apps/mobile/nodejs/android/java/app/vision/audio/node/*.kt` | `VisionNode` для JS, foreground-сервис, распаковка `bootstrap.mjs` |
| `apps/mobile/src/runtime.ts` | JS-обёртка: запуск, остановка, чтение `state.json` |
| `apps/mobile/src/lib/embedded-server.ts` | чистая логика: порты, состояния, тексты |
| `apps/mobile/src/screens/ServerStatusScreen.tsx` | экран «Сервер на телефоне» |
| `apps/mobile/src/screens/TesterScreen.tsx` | встроенный тестер API |
| `apps/mobile/src/lib/tester.ts` | набор проверок тестера (чистая логика) |
| `scripts/fetch-nodejs-mobile.mjs` | скачивает рантайм (≈90 МБ) |
| `scripts/android-embed-node.mjs` | вживляет всё в prebuild-проект |
| `scripts/android-tester-app.mjs` | переключает `app.json` в режим VisionTester |

## Почему Node 24, а не npm-пакет

`nodejs-mobile-react-native` в npm — это Node 18. Нашему серверу нужен
`node:sqlite` (появился в Node 22.5, в 24 — release candidate). Поэтому берём
сборку [RockinChaos/nodejs-mobile](https://github.com/RockinChaos/nodejs-mobile)
v24.22.3 с 16 КБ страницами памяти (требование Android 15+), а мост пишем сами —
нам не нужен протокол сообщений из npm-пакета, только `node::Start` и HTTP.

Версия и URL — в `apps/mobile/nodejs/android/node-version.json`, одна точка правды
для CI и локальной сборки.

## Сборка

```bash
cd apps/mobile
npx expo prebuild -p android --no-install
node ../../scripts/fetch-nodejs-mobile.mjs     # один раз, ≈90 МБ (кэшируется в CI)
node ../../scripts/android-prepare.mjs         # версия и подпись
node ../../scripts/android-embed-node.mjs      # рантайм, мост, сервис, bootstrap
node ../../scripts/android-embed-node.mjs --check   # проверка, что всё на месте
cd android && ./gradlew assembleRelease
```

В CI это делает workflow **Android APK** (input `embedded`, по умолчанию `true`).
Если `libnode` не скачался, сборка не падает: скрипт предупреждает, CMake не
подключается, и APK выходит без рантайма — кнопка «Запустить сервер» честно
скажет «нет рантайма». Разница видна в логе и в проверке APK.

## Тестовый APK (VisionTester)

Отдельная сборка для проверки на телефоне: **другой `applicationId`**
(`app.vision.audio.tester`), поэтому ставится рядом с обычным приложением и не
трогает вашу библиотеку и вход.

```
Actions → Android APK → Run workflow → «Собрать отдельный тестовый APK» ✅
```

Внутри: экран «Сервер на телефоне» (состояние, запуск, остановка, версия Node),
тестер API (адрес + шесть проверок), отчёт, которым можно поделиться.

## API встроенного сервера

Полный контракт — в `docs/API.md`. Отличия от домашнего сервера:

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/api/health` | `{ok, embedded: true, mode, runtime, version, platform, uptimeSec, files}` — открыт без токена |
| GET | `/api/files` | `{ok, files: [{name, size, mime}]}` |
| PUT | `/api/files/library/<имя>` | `201 {ok, name, size, mime}` — тело-поток, только внутрь `library/`, лимит 500 МБ |
| DELETE | `/api/files/library/<имя>` | `200 {ok, name}` |
| GET/HEAD | `/files/<имя>` | файл, `Range` → `206`, за пределами каталога — `404` |
| POST | `/api/shutdown` | `{ok, stop: true}`, затем процесс завершается и пишет `phase: stopped` |

`state.json` (в каталоге данных) — единственный честный источник состояния:

```json
{ "ok": true, "phase": "running", "port": 4000, "url": "http://127.0.0.1:4000",
  "runtime": "v24.22.3", "mode": "diagnostic", "error": null, "at": 1794470876726 }
```

## Правила, которые нельзя ломать

1. **Только петля по умолчанию.** `127.0.0.1`, не `0.0.0.0`: сервер не должен
   торчать в сеть без явного решения.
2. **`state.json` важнее JNI.** `startServer` вернул адрес — это ещё не значит, что
   сервер работает. Состояние читается из файла.
3. **Падение не должно быть молчаливым.** `uncaughtException` и
   `unhandledRejection` пишут `phase: failed` с причиной.
4. **`EADDRINUSE` — единственная причина пробовать другой порт.** Остальные
   ошибки повторять бессмысленно (`failureAction` в `embedded-server.ts`).
5. **`--data` внутри `filesDir`.** Библиотека переживает обновление APK.
6. **Teardown.** Остановка идёт через `POST /api/shutdown`, а не убийством потока:
   иначе `state.json` не обновится.

## Ограничения

- **Android only.** На iOS нужен свой фреймворк и другие правила фоновой работы;
  в этой итерации iOS работает как локальный плеер + реестр.
- **Сервер живёт, пока приложение в памяти.** foreground-сервис продлевает жизнь,
  но Android всё равно может остановить процесс. Музыка при этом не прерывается —
  играет системный плеер.
- **`ffmpeg` в APK нет.** Транскодирование недоступно; MP3/M4A/FLAC играются как есть.
- **Полный API пока не упакован.** `bootstrap.mjs` рассчитан на то, что рядом
  появится `server.mjs` (тогда `mode: "full"`); сейчас работает диагностический
  режим: `/api/health`, файлы, Range, загрузка, удаление.
