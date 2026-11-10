# Android APK — сборка, подпись, установка

Готовый установочный файл мобильного приложения собирается в GitHub Actions
(`.github/workflows/android.yml`) — без Expo-аккаунта, EAS и локального Android SDK.

```
Actions → «Android APK» → Run workflow  →  Release android-v0.2.0
https://github.com/visiontripin/Vision/releases/tag/android-v0.2.0
```

## Что делает workflow

| Шаг | Детали |
| --- | --- |
| Node 22 + JDK 17 | `actions/setup-node`, `actions/setup-java` (temurin) |
| `npm ci` | зависимости `apps/mobile` по lockfile |
| `npx tsc --noEmit` | типы не дают собрать заведомо сломанный бандл |
| `npx expo prebuild -p android` | генерирует `apps/mobile/android` (в git не попадает) |
| `node scripts/android-prepare.mjs` | версия, ключ подписи, проверка `usesCleartextTraffic` |
| `./gradlew assembleRelease` | Hermes-бандл + релизный APK |
| upload-artifact | `VisionAudio-<версия>-android.apk` + `.sha256` (90 дней) |
| GitHub Release | `android-v<версия>`, тег на текущий коммит, файлы в ассетах |

Артефакт workflow живёт 90 дней, релиз — бессрочно, поэтому ссылкой можно делиться:

```
https://github.com/visiontripin/Vision/releases/latest/download/VisionAudio-0.2.0-android.apk
```

Повторный запуск с тем же тегом не падает: workflow обновляет ассеты (`--clobber`).

## Подпись

- Ключ: `apps/mobile/vision-release.p12` (PKCS#12, RSA 2048, самоподписанный,
  срок 27 лет), alias `vision`, пароль `vision-audio`.
- Пароль и файл зафиксированы в репозитории намеренно: репозиторий публичный, а
  сборка должна воспроизводиться без доступа к секретам. Это **ключ для личной
  раздачи**, а не для Google Play.
- Смысл постоянного ключа — обновления: новая сборка с тем же `applicationId`
  (`app.vision.audio`) и большим `versionCode` ставится поверх старой и сохраняет
  вход, настройки и скачанные треки. Если подпись сменится, Android потребует
  удалить приложение (потеряются офлайн-копии, но не серверные данные).

Если хочется убрать ключ из репозитория:

```bash
# 1) сгенерировать свой ключ (JKS) и положить в GitHub Secrets
keytool -genkeypair -v -keystore vision-release.jks -storetype JKS \
  -keyalg RSA -keysize 2048 -validity 10000 -alias vision \
  -dname "CN=Vision Audio, O=visiontripin, C=NL"
base64 -w0 vision-release.jks | pbcopy     # или xclip/xsel
# 2) Actions → Settings → Secrets: VISION_KEYSTORE_B64, VISION_KEYSTORE_PASSWORD,
#    VISION_KEY_ALIAS, VISION_KEY_PASSWORD
```

`scripts/android-prepare.mjs` уже читает `VISION_KEYSTORE_PATH`,
`VISION_KEYSTORE_PASSWORD`, `VISION_KEY_ALIAS`, `VISION_KEY_PASSWORD`, поэтому
секретам достаточно декодировать файл в `apps/mobile/vision-release.p12` перед шагом
подписи. `versionCode` берётся из `GITHUB_RUN_NUMBER` (растёт с каждым запуском),
`versionName` — из `apps/mobile/app.json`.

## HTTP до домашнего сервера

Release-сборка Android по умолчанию блокирует `http://`, а домашний сервер в
локальной сети как раз без TLS. Поэтому в `app.json` включён плагин

```json
["expo-build-properties", { "android": { "usesCleartextTraffic": true } }]
```

`scripts/android-prepare.mjs` после `prebuild` проверяет атрибут
`android:usesCleartextTraffic="true"` в `AndroidManifest.xml` и, если плагин его не
добавил, дописывает сам — сборка не уедет в релиз с «мёртвой» сетью.

## Установка на телефон

1. Открыть ссылку релиза на телефоне, скачать `VisionAudio-<версия>-android.apk`
   (Chrome предупредит про «файл может быть опасен» — это обычная подпись
   самоподписанного APK, не из Play Store).
2. В диалоге установки разрешить установку из этого источника
   (Настройки → Приложения → Специальный доступ → Установка неизвестных приложений).
3. Запустить «Vision Audio», ввести адрес сервера:
   - дома: `http://192.168.1.10:4000` (IP телефона/ПК с сервером в Wi-Fi);
   - вне дома: адрес Tailscale `http://100.x.y.z:4000` или HTTPS-туннель;
   - `http://` разрешён (см. раздел выше), HTTPS-туннель тоже подходит.

Пароль по умолчанию — `vision` (или значение `VISION_PASSWORD` на сервере).

Проверка целостности файла (по желанию, на ПК):

```bash
sha256sum -c VisionAudio-0.2.0-android.apk.sha256
```

## Сборка вручную (если нужен локальный APK)

Нужны JDK 17 и Android SDK (или `ANDROID_HOME` от Android Studio):

```bash
cd apps/mobile
npm install
npx expo prebuild --platform android --no-install
node ../../scripts/android-prepare.mjs
cd android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

Локальный клон должен содержать `apps/mobile/vision-release.p12`; если ключа нет —
создать свой PKCS#12 и указать его через `VISION_KEYSTORE_PATH`.

## Ограничения сборки

- **Без Expo-аккаунта**: сборка идёт через `prebuild` + Gradle, EAS не нужен
  (и `EXPO_TOKEN` не требуется).
- `apps/mobile/android` и `ios` — генерируемые каталоги, в git их нет.
- В APK нет системных медиа-кнопок (экран блокировки, Bluetooth) — это ограничение
  `expo-av`, нужен dev build с `react-native-track-player`.
- APK не подписан Google Play и не публикуется в сторах; обновления — вручную с
  той же страницы релизов.
