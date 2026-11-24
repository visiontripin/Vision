# Vision Audio

[![CI](https://github.com/visiontripin/Vision/actions/workflows/ci.yml/badge.svg)](https://github.com/visiontripin/Vision/actions/workflows/ci.yml)
[![Demo](https://img.shields.io/badge/demo-visiontripin.github.io%2FVision-ff5a1f?style=flat-square)](https://visiontripin.github.io/Vision/)

![Vision Audio — «Моя волна», независимая музыка и персональный эфир](docs/assets/social-preview.png)

**Независимая музыка. Персональная волна.**

Мы создаём пространство, где слушатели открывают новых независимых артистов, а музыка складывается в персональный эфир «Моя волна».

## Идея

- **Открытия** — находить музыку за пределами привычного каталога.
- **Персональный эфир** — слушать собственную волну, а не собирать очередь вручную.
- **Доверие** — делиться музыкой только с подтверждёнными правами и понятными правилами.

## Что уже есть

- **Web-плеер** — библиотека, волновой плеер, плейлисты, лайки, приватные ссылки; работает офлайн через IndexedDB (GitHub Pages, без сервера).
- **API** — Node 22 + SQLite: стриминг, транскодинг, FTS, метрики, OpenAPI.
- **Клиенты** — Android/iOS (Expo), Windows/Linux (Tauri), панель Vision Server.
- **Платформа v2** — backend-first контур (PostgreSQL + pgvector, Redis, S3, очередь, moderation/rights, радио): существенно реализован, гейты приёмки открыты — `docs/ROADMAP-v2.md`.

## Статус

Vision Audio v2 находится в разработке. Публичная платформа, персональное радио и загрузка музыки пока не запущены. Сейчас нет открытой беты; мы не принимаем музыкальные файлы и не набираем участников. Где остановились и что дальше — [`docs/DEVELOPMENT-ROADMAP.md`](docs/DEVELOPMENT-ROADMAP.md).

## Демоверсия

- 🎧 **Локально, без сборки:** [`index.html`](index.html) — работающее демо плеера в одном файле (генерирует аудио в браузере, ничего не отправляет на сервер).
- 🎤 **Презентация проекта:** [`main.html`](main.html).
- 🌐 **Онлайн:** [ранняя демоверсия на GitHub Pages](https://visiontripin.github.io/Vision/) — существующий прототип личной библиотеки, а не Vision Audio v2 и не демоверсия будущего радио.

## Документация

Полный каталог — [`docs/INDEX.md`](docs/INDEX.md). С чего начать:

| Зачем | Документ |
|---|---|
| Внести изменения в код | [`CONTRIBUTING.md`](CONTRIBUTING.md) — ветки, PR, гейты, правила документации |
| Понять, куда движемся | [`docs/ROADMAP-v2.md`](docs/ROADMAP-v2.md), [`docs/DEVELOPMENT-ROADMAP.md`](docs/DEVELOPMENT-ROADMAP.md) |
| Поднять и проверить локально | [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) |
| Роли, RACI и промпты агентов | [`docs/ROLES.md`](docs/ROLES.md) |
| Архитектура и API | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/API.md`](docs/API.md) |
| Безопасность и канал уязвимостей | [`SECURITY.md`](SECURITY.md) |

## Быстрый старт для разработки

```bash
npm ci
npm run test:all         # все тесты: API, клиенты, скрипты
npm run typecheck:api && npm run check:api-types
npm run build            # сборка web
```

Подробности и локальные контуры — [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md); правила работы — [`CONTRIBUTING.md`](CONTRIBUTING.md).
