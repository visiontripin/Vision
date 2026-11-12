# Прямые ссылки на скачивание

Все ссылки — на файлы из GitHub Releases. Никаких сокращателей и промежуточных страниц:
клик по ссылке сразу начинает загрузку файла.

> Актуальные версии: **Android 0.8.0**, **Windows-плеер 0.3.0**, **Windows и Android: сервер + админка 0.1.1**,
> **Linux 0.3.0**. Web открывается без установки: https://visiontripin.github.io/Vision/

## Android

| Что | Ссылка | Размер |
|---|---|---|
| **Плеер Vision Audio** (всегда последняя версия) | https://github.com/visiontripin/Vision/releases/download/android-v0.8.0/VisionAudio-latest.apk | 57.7 МБ |
| Плеер Vision Audio 0.8.0 (фиксированная версия) | https://github.com/visiontripin/Vision/releases/download/android-v0.8.0/VisionAudio-0.8.0-android.apk | 57.7 МБ |
| Контрольная сумма APK | https://github.com/visiontripin/Vision/releases/download/android-v0.8.0/VisionAudio-0.8.0-android.apk.sha256 | 96 Б |
| **Админка / запуск сервера** (APK, подписан — ставится) | https://github.com/visiontripin/Vision/releases/download/console-v0.1.1/VisionServer-latest.apk | 36 МБ |
| Админка — фиксированная версия | https://github.com/visiontripin/Vision/releases/download/console-v0.1.1/VisionServer-0.1.1-android.apk | 36 МБ |
| Контрольная сумма APK админки | https://github.com/visiontripin/Vision/releases/download/console-v0.1.1/VisionServer-0.1.1-android.apk.sha256 | 97 Б |

`VisionAudio-latest.apk` — прямая ссылка без версии в имени: её можно сохранить и
переиспользовать, она всегда ведёт на свежую сборку.

## Windows

| Что | Ссылка | Размер |
|---|---|---|
| **Плеер Vision Audio 0.3.0 — установщик (.msi)** | https://github.com/visiontripin/Vision/releases/download/desktop-v0.3.0/Vision.Audio_0.3.0_x64_en-US.msi | 4.6 МБ |
| Плеер Vision Audio 0.3.0 — установщик (.exe) | https://github.com/visiontripin/Vision/releases/download/desktop-v0.3.0/Vision.Audio_0.3.0_x64-setup.exe | 3.2 МБ |
| **Сервер + админка 0.1.1 — установщик (.msi)** | https://github.com/visiontripin/Vision/releases/download/console-v0.1.1/Vision.Server_0.1.1_x64_en-US.msi | 2.9 МБ |
| Сервер + админка 0.1.1 — установщик (.exe) | https://github.com/visiontripin/Vision/releases/download/console-v0.1.1/Vision.Server_0.1.1_x64-setup.exe | 1.9 МБ |

`.msi` и `.exe` — два формата одного и того же приложения: MSI удобнее для тихой
установки и групповых политик, EXE (NSIS) — обычный «далее-далее-готово».

## Linux

| Что | Ссылка | Размер |
|---|---|---|
| Плеер 0.3.0 — AppImage (без установки) | https://github.com/visiontripin/Vision/releases/download/desktop-v0.3.0/Vision.Audio_0.3.0_amd64.AppImage | 83.5 МБ |
| Плеер 0.3.0 — .deb (Debian/Ubuntu) | https://github.com/visiontripin/Vision/releases/download/desktop-v0.3.0/Vision.Audio_0.3.0_amd64.deb | 5.1 МБ |

AppImage: `chmod +x Vision.Audio_0.3.0_amd64.AppImage && ./Vision.Audio_0.3.0_amd64.AppImage`.

## Web

| Что | Ссылка |
|---|---|
| Приложение в браузере (локальный режим, данные в браузере) | https://visiontripin.github.io/Vision/ |
| Админка на своём сервере | `http://<адрес-сервера>:4000/admin` |

## Проверка целостности APK

```bash
curl -LO https://github.com/visiontripin/Vision/releases/download/android-v0.8.0/VisionAudio-0.8.0-android.apk
curl -LO https://github.com/visiontripin/Vision/releases/download/android-v0.8.0/VisionAudio-0.8.0-android.apk.sha256
sha256sum -c VisionAudio-0.6.0-android.apk.sha256
```

## Установка

- **Android**: скачать APK → «Установить из этого источника». Новая сборка ставится
  поверх старой, вход и скачанные треки сохраняются. В приложении указать адрес
  сервера, например `http://192.168.1.10:4000`.
- **Windows**: запустить `.msi` или `-setup.exe`. Установщик не подписан сертификатом —
  SmartScreen предупредит один раз («Подробнее» → «Выполнить в любом случае»).
- **Сервер**: приложение «Vision Server» поднимает API и панель, либо разверните сервер
  по `docs/RUNBOOK.md` и откройте `/admin` в браузере.

## Ссылки на страницы релизов

- Все релизы: https://github.com/visiontripin/Vision/releases
- Android 0.8.0: https://github.com/visiontripin/Vision/releases/tag/android-v0.8.0
- Windows-плеер + Linux 0.3.0: https://github.com/visiontripin/Vision/releases/tag/desktop-v0.3.0
- Сервер + админка 0.1.1: https://github.com/visiontripin/Vision/releases/tag/console-v0.1.1
