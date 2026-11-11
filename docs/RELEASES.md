# Релизы: web, Windows, Android

Три готовых канала поставки из одного репозитория. Ничего не собирается «руками
разработчика»: каждый артефакт рождается в GitHub Actions и лежит по постоянному адресу.

| Что | Где взять | Как обновляется |
|---|---|---|
| **Web** | https://visiontripin.github.io/Vision/ | автоматически при merge в `main` |
| **Android APK** | `releases/latest/download/VisionAudio-latest.apk` | тег `android-v<версия>` |
| **Windows: плеер** | `releases/latest` → `Vision.Audio_<версия>_x64_en-US.msi` / `-setup.exe` | тег `desktop-v<версия>` |
| **Windows: запуск сервера и админка** | `releases/latest` → `Vision.Server_<версия>_x64_en-US.msi` / `-setup.exe`, `VisionServer-latest.apk` (Android) | тег `console-v<версия>` |
| **Linux: плеер** | `.deb` / `.AppImage` в релизе `desktop-v*` | тег `desktop-v<версия>` |
| **Панель в браузере** | `http://<сервер>:4000/admin` | вместе с сервером |

## Web (GitHub Pages)

- Воркфлоу `.github/workflows/pages.yml`: push в `main` → `npm run build:pages`
  (`VITE_LOCAL_MODE=1`, `BASE_PATH=/Vision/`) → GitHub Pages.
- Сборка **локальная**: данные живут в браузере (IndexedDB), сервер не нужен. Именно
  поэтому Pages-версия — это «плеер-витрина», а не полноценный сервер.
- Проверка после деплоя: открыть сайт, включить режим полёта и перезагрузить —
  оболочка и треки должны открыться из кэша (I5, `docs/DESKTOP.md`).
- Если Pages не обновился: `gh run list --workflow=pages.yml` и `gh api
  repos/:owner/:repo/pages/builds`.

## Android APK

Подробности — `docs/ANDROID.md`. Коротко: `git tag android-v<expo.version>` из
`apps/mobile/app.json`, воркфлоу собирает подписанный universal-APK, проверяет его
(`apksigner`, `aapt2`, наличие JS-бандла) и кладёт в релиз три файла:
`VisionAudio-<версия>-android.apk`, `.sha256` и `VisionAudio-latest.apk`.

```bash
git tag android-v0.6.0 && git push origin android-v0.6.0
gh release view android-v0.6.0 --json assets -q '.assets[].name'
```

## Windows

Два разных приложения — не перепутать:

- **Плеер** (`desktop-v*`, `apps/desktop`): интерфейс библиотеки, трей, медиа-клавиши,
  автообновление через `latest.json`.
- **Сервер и админка** (`console-v*`, `apps/console`): единственное приложение, которое
  само запускает API и открывает панель; в том же релизе лежит APK-оболочка для Android.
  Требует установленного сервера Vision или поднимает его локально (см.
  `apps/console/README.md`).

Оба подписаны, если в секретах есть `WINDOWS_CERTIFICATE`; без сертификата установщик
остаётся неподписанным и SmartScreen предупредит — это честнее самоподписанного.

## Порядок выпуска версии

1. Обновить версии: корень/web/shared (`0.x.0`), `apps/mobile` (`0.y.0` + `app.json`),
   `apps/console`/`apps/desktop` — если менялся их код. `npm install --package-lock-only`.
2. `CHANGELOG.md`, `docs/IMPROVEMENTS.md`, `docs/API.md`, `docs/ROADMAP.md`.
3. Гейты: `npm test`, `npm run test:local`, `npm run test:scripts`, три сборки, `tsc`.
4. Merge PR в `main` → Pages уезжает сам.
5. Теги **на merge-коммит** (не на ветку):

```bash
MERGE=$(git rev-parse origin/main)
git tag android-v0.6.0 $MERGE && git tag desktop-v0.3.0 $MERGE && git tag console-v0.1.1 $MERGE
git push origin refs/tags/android-v0.6.0 refs/tags/desktop-v0.3.0 refs/tags/console-v0.1.1
```

6. Дождаться трёх прогонов и **проверить ассеты, а не только зелёный статус**:

```bash
for t in android-v0.6.0 desktop-v0.3.0 console-v0.1.1; do
  echo "== $t"; gh release view "$t" --json assets -q '.assets[] | "\(.name)\t\(.size)"'
done
```

7. Если релиз упал после `gh release create` (ассеты уже частично загружены),
   тег можно переставить на исправленный коммит: `git tag -f <tag> <commit>` и
   `git push --force origin refs/tags/<tag>` — повторный прогон обновит файлы
   (`--clobber`), сам релиз не пересоздаётся.

## Грабли, на которые уже наступали

| Симптом | Причина | Решение |
|---|---|---|
| релиз «failure», ассетов нет | `gh release upload` с шаблоном, который не совпал с файлом | собирать список по факту (`[ -f ]`), публиковать массив |
| в релизе только Windows | упала Linux-джоба раньше Windows | проверить порядок и `continue-on-error` у необязательных джоб |
| APK старой версии | тег поставили на ветку, а не на merge-коммит | тег на `origin/main` |
| Pages показывает старую сборку | деплой не запускался: не было push в `main` | merge PR, затем `gh run list --workflow=pages.yml` |
| `versionCode` не растёт | он берётся из `GITHUB_RUN_NUMBER` | новый прогон = новый `versionCode` |
