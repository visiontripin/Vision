# 0021. Сначала завершить серверный стек, затем развивать приложения

**Дата:** 2026-11-12
**Статус:** принято владельцем — доработать полный серверный контур Ф1–Ф3 до новых app-фич
**Роли:** PO, TL, BE, OPS, SEC, QA

## Контекст

Roadmap v2 уже описывает Postgres/pgvector, object storage, очереди, ingest/moderation,
events/recsys и radio/voice services, но задачи Ф1–Ф3 смешивают API/backend и интерфейсы.
Владелец установил порядок: сначала закончить серверный стек, затем пилить приложения.

## Решение

До Stack Ready gate основной разработкой являются **серверные компоненты Ф1–Ф3**:
identity/authorization, каталог и права, Postgres/pgvector и миграции, S3-compatible storage,
очередь и ingest, moderation/takedown APIs, события и рекомендации, radio scheduler,
voice/TTS service и API-контракты. Изменения клиентского приложения разрешены только для
совместимости, тестирования, smoke и исправления блокирующих дефектов — не для новых
продуктовых экранов или клиентских возможностей.

`apps/web`, `apps/mobile`, `apps/desktop` и `apps/console` сохраняются. Их разработку,
UI-полировку, новую навигацию, client sequencer и новые app-релизы не начинать до приёмки
Stack Ready gate. Серверные API и события должны быть реализованы и проверены независимо
от того, существует ли уже экран, который их вызывает.

## Порядок серверной работы

1. **Основа данных и доступа (Ф1):** users/roles/ownership, Postgres schema и миграции,
   совместимость с текущим SQLite local-mode, quotas, API authz и contract/security tests.
2. **Медиа и ingest (Ф1):** S3 abstraction, signed object URLs, Redis queue, idempotent
   worker lifecycle, transcode, fingerprint adapter, quarantine, moderation/takedown.
3. **События и рекомендации (Ф2):** event schema/dedup, privacy-safe ingestion, embeddings
   в pgvector, taste profile, retrieval/ranking/diversity и offline evaluation.
4. **Радио и voice (Ф3):** server-side schedule/segments, business rules, TTS abstraction,
   cache/cost accounting и integration tests. Клиентский playback sequencer отложен.
5. **Операционная готовность:** CI integration matrix, migrations/backup/restore, logs,
   metrics, health checks, deployment/runbooks и security review.

В mixed tasks сначала принимаются backend-контракт, модель данных и тесты. UI/client-часть
выносится в отдельную задачу после Stack Ready; исходные номера roadmap сохраняются.

## Stack Ready gate

Перед началом новых app-фич должны быть проверяемо выполнены все пункты:

- все необходимые API F1–F3 описаны в OpenAPI и имеют contract, permission и negative tests;
- Postgres migrations проходят с чистой и upgrade-базы; SQLite local-mode остаётся
  совместимым; backup/restore и план rollback проверены на копии данных;
- storage adapter проходит тесты с локальным S3-compatible backend и гарантирует
  приватность quarantine, подписанные URL, удаление/takedown и cache invalidation;
- очередь/worker проверены на retry, duplicate delivery, idempotency, dead-letter и
  безопасное восстановление после перезапуска;
- ingest/moderation pipeline по умолчанию закрытый: нет публикации до решения;
  права на публичный UGC, takedown и ownership enforced на сервере;
- events/recsys имеют deterministic fixtures, privacy rules и измеримую offline evaluation;
- radio scheduler/voice API имеют acceptance tests, fake provider для CI и учёт стоимости;
  live-mix и client playback не подменяют серверный контракт;
- полный server integration smoke работает в CI; staging/deploy, observability, alarms и
  tested restore/runbooks доступны операторам.

Владелец принимает gate по результатам тестов и staging review. Наличие модулей, mock-
ответов или одних схем OpenAPI не считается завершением стека.

## Ограничения и внешние решения

- До выбора региона/бюджета/провайдера не фиксировать production vendor; использовать
  интерфейсы и локальные test adapters. Для fingerprint и TTS также сначала оформить
  provider/cost/license decision.
- Внешнее юридическое заключение, открытый ADR-0015 о репликации и фактические согласия
  бета-участников остаются самостоятельными блокерами публичного запуска. Технический
  Stack Ready не разрешает публичные UGC-загрузки, peer-seeding, рекламу или монетизацию.
- Решение не удаляет существующий клиентский код и не отменяет отдельный нерешённый
  конфликт по Windows Vision Server (ADR-0016/0020).

## Последствия

- F1–F3 выполняются backend-first; UI и клиентские фичи явно отделяются от серверных задач.
- Фазы/сроки могут сдвинуться относительно старой параллельной оценки; приложения не
  объявляются готовыми до прохождения отдельного gate.
- Существующие тесты и сборки клиентов продолжают работать в CI как regression checks.
