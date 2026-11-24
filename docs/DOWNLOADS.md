# Загрузки Vision Audio

[Все GitHub Releases](https://github.com/visiontripin/Vision/releases). Новая Vision Audio v2 платформа ещё не выпущена; существующие артефакты — клиент/плеер, а не публичный UGC-каталог.

## Web demo

- [Локальная web-версия](https://visiontripin.github.io/Vision/) — данные хранятся в браузере, сервер не нужен.

## Android — существующий плеер-клиент

- [Последние доступные APK и контрольные суммы](https://github.com/visiontripin/Vision/releases/latest)
- APK — клиент внешнего API и локальной библиотеки; Node/API-сервера в нём нет.
- Android development отложен по roadmap до Ф5. Ручной workflow default-only builds artifact; Release появляется лишь при явном `release: true` или owner-created `android-v*` tag после отдельного решения владельца.

## Windows / Linux — прежние desktop-сборки

Уже выпущенные версии не удаляются, но новые desktop builds/releases заморожены по ADR-0016 до подтверждения PMF. Старые `.msi`, `.exe`, `.deb` и `.AppImage` — архивные; поддержка не гарантируется.

## Windows Vision Server

**Проверенного Windows Vision Server релиза нет.** Installer в этой Arena-ветке не проверен на Windows; автоматическая публикация выключена. Не скачивать/не устанавливать код этой ветки как релиз. Отдельное требование владельца к Windows-службе и администраторскому установщику остаётся открытым и конфликтует с временной заморозкой console — см. `docs/HOME-SERVER-WINDOWS.md`. Старый `console-v0.1.1` — клиентская панель, не сервер.

Архивная заметка: [`HOME-SERVER-WINDOWS.md`](HOME-SERVER-WINDOWS.md). Она не является инструкцией к установке.

## Статус продукта

Текущий код — приватный одно-владельческий плеер/API. Public uploads, каталог, модерация, рекомендации, персональное радио и реклама пока не доступны. Для разработки и задач см. `docs/ROADMAP-v2.md` и `docs/RUNBOOK.md`.
