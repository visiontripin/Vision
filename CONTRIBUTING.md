# Участие в разработке Vision Audio

Практическая инструкция для человека или агента: как вносить изменения, чтобы
репозиторий оставался рабочим, а CI — зелёным. Продуктовые роли и RACI — в
[`docs/ROLES.md`](docs/ROLES.md); проверенные приёмы работы в песочнице — в
[`docs/AGENT-PLAYBOOK.md`](docs/AGENT-PLAYBOOK.md); полный каталог документов —
в [`docs/INDEX.md`](docs/INDEX.md).

## Два контура кода

| Контур | Где | Статус |
|---|---|---|
| **Legacy-плеер** (текущий) | `apps/web`, `services/api/src/*` (не `platform/`) | Работает, публикуется на Pages; поддерживается, но не целевой продукт |
| **Платформа v2** | `services/api/src/platform/*`, миграции 001–008, `compose.platform.local.yml` | Целевой продукт (ADR-0021, backend-first); публичный UGC запрещён до гейтов |

Изменения одного контура не должны ломать проверки другого: `npm run test:all`
покрывает оба.

## Ветки и pull request

- `main` — только через PR, только после зелёных гейтов ниже.
- Рабочие ветки — `arena/*` (песочница) или короткие feature-ветки от `main`.
- Один PR — одна задача ([`docs/ROLES.md`](docs/ROLES.md), §4 протокол передачи).
- Не force-push в общие ветки; публикация в `main` — merge-коммитом или squash
  по решению ревьюера.
- Историю уже закрытых веток не переписывать: аудиты и журналы
  (`docs/BRANCH-CLEANUP-AUDIT.md`, `docs/WORKSPACE-RECOVERY-LOG.md`) ссылаются на SHA.

## Коммиты

Conventional Commits с областью: `feat`, `fix`, `docs`, `test`, `ci`, `chore`
(примеры истории: `docs: add Agent Playbook…`, `feat: secure platform playback
sessions…`). Тема — что изменилось, а не «правки».

## Гейты перед push и перед merge

```bash
npm ci
npm run test:all         # API-контракт + клиентские тесты + скрипты
npm run typecheck:api    # tsc для services/api
npm run check:api-types  # сгенерированные типы == OpenAPI
npm run build            # сборка web
```

CI (`.github/workflows/ci.yml`) повторяет эти же шаги плюс `tsc --noEmit` для
`apps/mobile` и платформенную интеграцию (PostgreSQL 16 + Redis + MinIO).
Деплой Pages (`pages.yml`) идёт только с `main`. Пока Docker/Windows-репетиции
не пройдены, зелёный CI ≠ готовность беты — см.
[`docs/DEVELOPMENT-ROADMAP.md`](docs/DEVELOPMENT-ROADMAP.md).

## Документация — часть задачи

- Контракт API — сначала [`docs/API.md`](docs/API.md), затем код; после правки —
  `npm run generate:api-types` и `npm run check:api-types`.
- Архитектурное решение — ADR в [`docs/adr/`](docs/adr/) (`NNNN-краткое-имя.md`).
- Новый или переименованный документ — строка в [`docs/INDEX.md`](docs/INDEX.md)
  (правило ledger из AGENT-PLAYBOOK §5).
- План — [`docs/ROADMAP-v2.md`](docs/ROADMAP-v2.md) и
  [`docs/DEVELOPMENT-ROADMAP.md`](docs/DEVELOPMENT-ROADMAP.md);
  `docs/ROADMAP.md` — история, не обновлять как актуальный backlog.
- README в корне — презентация продукта, не техническая инструкция
  (см. «Указания владельца» в `docs/WORKSPACE-RECOVERY-LOG.md`).
- Документы — по-русски, коротко, без воды; статусы гейтов не помечать
  выполненными за владельца.

## Секреты и данные

- В Git не попадают: `.env*`, токены, пароли, сертификаты (кроме tracked
  `apps/mobile/vision-release.p12` — не удалять без решения владельца),
  пользовательские аудиофайлы, PII участников.
- Подробнее — [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md), раздел «Секреты и
  артефакты»; правила эксплуатации — [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
- Публичные demo/страницы — только без приватных и чужих материалов.

## Структура репозитория

```
apps/web          SPA-плеер (React + Vite) — legacy-контур и Pages-демо
apps/mobile       Expo-клиент Android/iOS
apps/desktop      Tauri 2 плеер Windows/Linux (заморожен, ADR-0016)
apps/console      Vision Server / панель (эксперимент, workflow заморожен)
packages/shared   общие типы и HTTP-клиент
services/api      API: legacy-ядро + platform/ (v2: PostgreSQL, очередь, radio)
scripts/          seed, бэкап, платформенные CLI (local, sqlite-import, openapi)
docs/             INDEX.md — вход в документацию; adr/ — решения
deploy/           примеры эксплуатации (observability)
```

## Полезные команды

```bash
npm run dev            # Vite :5173, проксирует /api
npm run dev:api        # legacy API :4000 (только localhost, см. DEVELOPMENT.md)
npm run seed           # демо-библиотека в локальную SQLite
npm run platform:local:status   # состояние локального контура v2
node scripts/platform-local.mjs --help
```

Контур v2 локально поднимается только по сценарию
[`docs/BETA-WINDOWS-LOCAL.md`](docs/BETA-WINDOWS-LOCAL.md) (loopback-only).
