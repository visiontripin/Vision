# Vision Audio на Android (Termux)

Домашний сервер на телефоне: библиотека, транскодинг в opus, доступ по Wi-Fi и через
Tailscale. Телефон для этого годится: сервер — это Node без нативных зависимостей,
а ffmpeg ставится из репозитория Termux.

> Проверено на уровне кода и тестов (резолв ffmpeg, отсутствие ffmpeg, 2 потока,
> сборка web). На живом устройстве прогоняйте `npm test` — если что-то не сойдётся,
> раздел «Если что-то пошло не так» ниже закрывает типовые случаи.

## 1. Что нужно

- Android 8+ и **Termux из F-Droid** (версия из Google Play устарела и не обновляется).
- 2 ГБ свободного места и хотя бы 2 ГБ RAM (транскодинг — самая тяжёлая операция).
- Телефон и компьютер в одной Wi-Fi сети (или Tailscale, см. §5).

## 2. Установка

```bash
pkg install -y git
git clone https://github.com/visiontripin/Vision.git ~/Vision
cd ~/Vision
bash scripts/termux-setup.sh
```

Скрипт поставит `nodejs`, `ffmpeg`, `git`, соберёт web-интерфейс, создаст
`~/vision-data` и подготовит автозапуск. Он идемпотентный — повторный запуск
безопасен.

Запуск:

```bash
cd ~/Vision
DATA_DIR=$HOME/vision-data PORT=4000 HOST=0.0.0.0 \
  FFMPEG_PATH="$(command -v ffmpeg)" npm start
```

Открыть в браузере: `http://<ip-телефона>:4000`, пароль по умолчанию `vision`.
IP смотрится так: `ifconfig 2>/dev/null | grep 'inet '`.

**Сразу смените пароль и секрет:**

```bash
export VISION_PASSWORD='длинный-пароль'
export VISION_SECRET="$(openssl rand -hex 32)"
```

Секрет лучше зафиксировать в `~/.termux/boot/vision.sh` (или в `~/.bashrc`), иначе
после рестарта он пересчитается из пароля и все ранее выданные ссылки/токены
станут недействительными.

## 3. Что меняется на телефоне по сравнению с сервером

`process.platform` в Termux — `android`, поэтому сервис сам включает «экономный»
режим (всё переопределяется переменными):

| Поведение | На обычном сервере | На Android/Termux |
| --- | --- | --- |
| Кодеки | opus + aac | только opus |
| HLS-нарезка | включена | выключена |
| Потоки ffmpeg | сколько даст сам | 2 (`FFMPEG_THREADS`) |

Так транскодинг не съедает батарею и не греет корпус. Хотите как на сервере —
задайте `TRANSCODE_CODECS=opus,aac HLS_ENABLED=1 FFMPEG_THREADS=4`. Слабый телефон —
`TRANSCODE=0` (сервис будет отдавать оригиналы, всё остальное работает).

Если ffmpeg в Termux не установлен, сервис не падает: `/api/health` покажет
`ffmpeg.available: false`, плеер играет оригиналы. После `pkg install ffmpeg`
достаточно перезапуска, а старые треки догонятся с `TRANSCODE_BACKFILL=1`.

## 4. Автозапуск и чтобы Android не убивал процесс

1. Установите **Termux:Boot** из F-Droid и откройте его один раз (иначе Android
   не даст право на автозапуск).
2. `scripts/termux-setup.sh` уже положил `~/.termux/boot/vision.sh` с
   `termux-wake-lock` и запуском сервера. Лог: `~/vision.log`.
3. Настройки → Приложения → Termux → Батарея → **«Без ограничений»**.
   На Xiaomi/Samsung дополнительно отключите «экономию энергии» для Termux.
4. Проверка: `termux-wake-lock` и уведомление «Termux is running» должны висеть.

## 5. Доступ извне дома

Пробрасывать порт 4000 в интернет **не надо**: у сервиса один пароль и нет TLS.
Два нормальных варианта:

**Tailscale (рекомендую)** — приватная сеть, HTTPS-сертификат, ничего не открыто наружу:

```bash
pkg install -y tailscale
tailscaled &            # или запускайте из boot-скрипта
tailscale up
tailscale serve --bg 4000    # https://<имя-устройства>.<tailnet>.ts.net
```

**Cloudflare Tunnel** — если нужен публичный HTTPS-адрес:

```bash
pkg install -y cloudflared
cloudflared tunnel --url http://localhost:4000
```

В обоих случаях клиент открывает HTTPS-адрес, а API находится на том же origin —
CORS и mixed content не мешают.

Мобильное приложение Expo: `EXPO_PUBLIC_API_URL=https://<адрес-туннеля>` (или
`http://<ip>:4000` в домашней сети).

## 6. Обновление

```bash
cd ~/Vision
git pull --ff-only
npm install --no-audit --no-fund
npm run build
# перезапустить сервер (Ctrl+C и снова npm start, либо перезагрузить телефон)
```

Миграции применяются автоматически при старте (в логе `[db] applied migration …`).

## 7. Если что-то пошло не так

| Симптом | Причина | Что делать |
| --- | --- | --- |
| `В этой сборке Node нет встроенного модуля node:sqlite` | старый/самодельный Node | `pkg upgrade nodejs`; в Termux нужен официальный пакет Node 22.5+ |
| `npm install` падает на `ffmpeg-static` | пакет тянет glibc-бинарник с GitHub | ошибка безвредна (зависимость опциональная); на Android ffmpeg берётся из `pkg install ffmpeg` |
| `/api/health` → `ffmpeg.available: false`, хотя `ffmpeg -v` работает | PATH не тот (например, сервер запущен из cron/boot) | в boot-скрипте явно `FFMPEG_PATH="$(command -v ffmpeg)"` — setup-скрипт так и делает |
| Процесс умирает через несколько минут | Android выгружает фон | `termux-wake-lock`, «Без ограничений» в настройках батареи, Termux:Boot |
| `EACCES`/`rename` при загрузке | `DATA_DIR` на `/sdcard` | данные только в `$HOME` (`~/vision-data`) |
| `EADDRINUSE` | сервер уже запущен | закрыть прошлый или `PORT=4100 npm start` |
| Транскодинг греет телефон / жрёт батарею | opus + HLS на слабом SoC | `TRANSCODE=0` или `HLS_ENABLED=0`, `FFMPEG_THREADS=1` |
| `npm run build` не встаёт (esbuild) | редкая сборка Termux | соберите на компьютере и скопируйте (`см. ниже`) |
| Страница открывается, но пусто | web-интерфейс не собран | `npm run build` (в `apps/web/dist` должен появиться `index.html`) |

### Сборка на компьютере, запуск на телефоне

Серверу в рантайме не нужны npm-зависимости, поэтому достаточно перенести три вещи:

```bash
# на компьютере
npm run build
rsync -a --delete services apps/web/dist scripts package.json \
  phone:~/Vision/          # ssh из Termux: pkg install openssh, sshd

# на телефоне
cd ~/Vision && DATA_DIR=$HOME/vision-data npm start
```

## 8. Бэкап

```bash
# на телефоне: база + медиа
tar czf ~/vision-backup-$(date +%F).tar.gz -C ~ vision-data
```

Скопируйте архив на компьютер (`scp`) — телефон всё-таки мобильное устройство.
Восстановление: распаковать в `~/` и запустить сервер.

## 9. Сид и трекер реплик

Телефон в роли сервера — ещё и **сид**: он раздаёт свои файлы другим устройствам,
а трекер знает, у кого что лежит (модель — `docs/DISTRIBUTED.md`).

`scripts/termux-setup.sh` уже прописывает в автозапуск:

```bash
export DEVICE_ID=termux         # имя устройства в реестре
export SEED_ENABLED=1           # раздавать файлы через /seed/<sha256>
# export PUBLIC_URL=https://my-termux.tailnet-xxxx.ts.net   # если доступ извне
```

Что это включает:

- файл, загруженный на телефон, получает адрес `sha256` и регистрируется как
  `origin`-сид (heartbeat раз в минуту, TTL 3 минуты);
- `GET /seed/<sha256>?exp&sig` отдаёт файл с Range/ETag — тем же HTTP-слоем, что и
  стриминг, никакого нового протокола;
- если задан `PUBLIC_URL` (Tailscale/Cloudflare), этот адрес попадает в реестр,
  и другие устройства качают напрямую с телефона; без него сид виден, но скачать
  с него можно только по локальному адресу;
- `POST /api/blobs/<sha256>/replicate` забирает редкий трек с другого устройства в
  `~/$DATA_DIR/seed/` и дальше раздаёт его сам — полезно, если «оригинал» обычно спит.

Режим без файлов (только каталог) — для слабого телефона:

```bash
STORAGE_MODE=metadata DEVICE_ID=termux-meta npm start   # принимает только метаданные
```

Проверка:

```bash
curl -s localhost:4000/api/health | grep -o '"tracker":{[^}]*}'
curl -s -H "Authorization: Bearer $TOKEN" localhost:4000/api/seeds
```

Диск: `~/$DATA_DIR/seed/` разрастается только тем, что вы реплицировали вручную.
Файлы ничего не «качают в фоне» — репликация всегда явная команда или кнопка.
