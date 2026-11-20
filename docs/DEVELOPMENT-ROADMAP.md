# Дорожная карта разработки Vision Audio v2

**Срез:** 2026-11-12
**Целевой продукт:** платформа независимой музыки v2, а не личная библиотека.
**Первая тестовая среда:** Windows 10/11, локальный Docker Desktop + WSL2.
**Статус:** серверный backend-контур Ф1–Ф3 существенно реализован и прошёл исторические hosted CI-интеграции на PostgreSQL/Redis/S3; follow-up добавил local backup/restore CLI и runbook, SQLite inventory и importer (dry-run/apply, SHA-256-идемпотентность, automated-тесты), synthetic full-pipeline E2E, базовые API metrics/logs, turnkey rehearsal runbook (`docs/PLATFORM-REHEARSAL.md`) и пример alert-правил (`deploy/observability/prometheus-alerts.example.yml`). Stack Ready и готовность к бете не приняты: Docker/Windows restore rehearsal, реальные PG16/Redis/MinIO pipeline checks и внешние legal/owner gates открыты. Подробное evidence-разделение — в [`ROADMAP-v2.md`](ROADMAP-v2.md), operational-рецепты — в [`PLATFORM-OPERATIONS.md`](PLATFORM-OPERATIONS.md), ограничения набора — в [`BETA-PLAN.md`](BETA-PLAN.md).

## Точка остановки и процент

> **Готовность к закрытой бете: 0%.** Общий процент выполнения не пересчитан после backend-first прохода ADR-0021: прежние оценки 16% / 29% устарели и не должны использоваться как текущие.

Серверные контракты Ф1–Ф3 реализованы существенно дальше, чем показывали прежние проценты: account/owner APIs, квоты, приватное S3-хранилище, queue/worker/ingest, moderation/rights endpoints, privacy-minimal events, детерминированные рекомендации/offline evaluation, radio APIs и voice/TTS cost path существуют и проходят автоматические проверки. GitHub CI также проверяет PostgreSQL 16 + pgvector, Redis/BullMQ, S3-compatible storage, API smoke и Android TypeScript.

**Это не означает приёмку:** локальный Docker/Windows-контур и backup/restore CLI добавлены, но не выполнены на ПК владельца; новый E2E — synthetic PGlite/fake-storage, не реальный PostgreSQL 16 + Redis + MinIO rehearsal. Нет реального fingerprint/TTS поставщика, подключённого сайта, полного пользовательского E2E, завершённого legal/privacy процесса, production-операций и утверждённого Go решения. Регистрация/загрузки выключены в локальном контуре; UGC непубличен. Техническая реализация не разрешает запуск.

## Состояние фаз

| Фаза | Текущий статус | Где остановились |
|---|---|---|
| **Ф0 — стабилизация и pivot** | Частично завершена | Направление v2 и продуктовые документы зафиксированы. Открыты legal/privacy review, решение по правам на UGC и продуктовый go/no-go. |
| **Ф1 — мультипользовательская платформа** | Backend реализован частично и CI-интегрирован; фаза не принята | Есть PostgreSQL migrations 001–008, account/owner APIs, quotas/uploads, private S3, outbox/BullMQ/worker/ingest, moderation/rights APIs и catalog API. Добавлены local PG/MinIO/Redis backup/restore-команды, SQLite inventory и importer, synthetic full-pipeline E2E, rehearsal runbook и пример observability alert-правил. Открыты owner-run Windows recovery rehearsal (runbook §A/B), importer rehearsal/cutover (§E), live Redis verification и policy/load review (§C), observability wiring (§D), anti-fraud, real fingerprint, legal process, v2 UI, production observability и приёмка владельцем. |
| **Ф2 — вкус и рекомендации** | Backend foundations реализованы, продуктовые KPI не приняты | Есть privacy-minimal events, deterministic recommendations и offline evaluator; pgvector schema/vector scoring подключены. Нет pipeline генерации embeddings и taste profiles, оценки на контрольных профилях и cold-start/product UI. |
| **Ф3 — «Моя волна» и радио** | Backend foundations реализованы, пользовательский эфир не принят | Есть private radio sessions/schedule/feedback и provider-neutral voice/TTS cache/cost APIs. Нет реального TTS поставщика, клиентского sequencer/player, редакционного runtime и проверенной эфирной аналитики. |
| **Ф4 — промо, монетизация и лейбл** | Не начиналась | Заблокирована правовым решением и требованиями маркировки/биллинга. |
| **Ф5 — масштабирование и рост** | Не начиналась | Зависит от готовых и принятых Ф1–Ф3 и подтверждённой ценности продукта. |

### Текущее покрытие Ф1 и оставшиеся условия

- **Identity/ownership:** owner-scoped account/token APIs и проверки владения есть; email confirmation/invitations, OAuth/passkey и 2FA отсутствуют.
- **Postgres/Recovery:** отдельный pool и migrations 001–008; hosted run [#43851825546](https://github.com/visiontripin/Vision/actions/runs/43851825546) прошёл на PostgreSQL 16 + pgvector, включая upgrade 001–007 → 008 с историческими дубликатами `play_30s`, проверку persisted playback ingestion/revocation и health с требуемой версией. Сейчас добавлены local PG/MinIO/Redis backup/restore CLI, manifest/hash checks и recovery recipes, но Docker в текущем workspace отсутствует; restore rehearsal на Windows/PG16 и перенос SQLite-данных не выполнены; read-only inventory и importer (`scripts/platform-sqlite-import.mjs`) существуют, но importer не отрепетирован на одноразовом PG16/MinIO и не имеет cutover approval.
- **Storage/upload/ingest:** есть quota reservation, private S3 adapter, signed media URLs, outbox/BullMQ/DLQ, idempotent quarantine ingest и transcode; CI интеграция с Redis и S3-compatible MinIO прошла. Локальные uploads выключены, CDN/lifecycle/production provider не утверждены.
- **Fingerprint/moderation/rights:** provider-neutral fail-closed adapter и moderation/rights/takedown APIs есть; реального fingerprint поставщика, moderator UI, legal-approved policies и назначенного владельца жалоб нет. `not_configured` не означает `clear`.
- **Artist/catalog:** backend profile/catalog APIs есть; site v2 и публичный контент отсутствуют.
- **Tests/operations:** `npm run test:all` прошёл на текущей ветке (API 273 pass/6 integration skips, local 145 pass, scripts 35 pass), вместе с `typecheck:api` и `check:api-types`; добавлены synthetic HTTP pipeline E2E, operational metrics/log/health и PGlite-тесты importer'а. Production observability/alarms, runbook owner review, Docker backup/restore rehearsal и Windows real-service end-to-end не пройдены — turnkey-шаги есть в `docs/PLATFORM-REHEARSAL.md`.

Схема данных и зелёный CI не закрывают фазовый acceptance gate: каждый блок должен пройти оставшиеся продуктовые, юридические и operational-проверки.

## Ближайший порядок работ

1. **Проверить локальный Windows-контур на ПК владельца.** По [`BETA-WINDOWS-LOCAL.md`](BETA-WINDOWS-LOCAL.md) запустить PostgreSQL 16 + pgvector, Redis, private S3, миграции 001–008, API и worker; проверить повторный запуск, loopback-only ports, backup/restore и процедуру восстановления. Это backend smoke, не сайт.
2. **Закрыть операционные пробелы Ф1 по `docs/PLATFORM-REHEARSAL.md`:** backup/restore/rollback rehearsal (§A/B), live Redis verification и policy/load review rate-limit (§C), SQLite importer rehearsal на одноразовом контуре и отдельный cutover gate (§E), observability wiring и incident drill (§D), подпись владельца (§F); назначить владельцев alerting/runbook review, отдельную anti-fraud работу и выбрать production storage; тестовые MinIO image/endpoint не считать production решением.
3. **Закрыть права и moderation operations:** legal-approved terms, human complaint/takedown/appeal ownership, SLA и тест end-to-end изолированного ingest → moderation → rights-aware decision. До этого не открывать внешние регистрации/загрузки и не публиковать пользовательские треки.
4. **Дополнить Ф2:** embeddings/pgvector retrieval и offline metrics на контрольных профилях; сохранить privacy-minimal events и не выдавать `not_configured` fingerprint за чистый результат.
5. **Дополнить Ф3:** radio transport/player, editorial runtime, playback/event analytics и выбранный TTS provider/cost limits — только после отдельного решения владельца.
6. **Пройти Stack Ready gate (ADR-0021):** выполнить `docs/PLATFORM-REHEARSAL.md` на машине владельца (rehearsal B–E, подпись F), перенести результаты в `docs/PLATFORM-OPERATIONS.md` §5; проверить API/security, реальные PG миграции и recovery, storage/takedown, queue retry/idempotency/DLQ, ingest/moderation, recsys/radio integration, CI smoke, production observability/alerts и runbook owner review; gate требует явной приёмки владельцем.
7. **После принятия gate подключать v2 UI:** listener-каталог/прослушивание, artist onboarding/submission/status, moderation UI и radio/recsys; E2E только на разрешённом синтетическом/тестовом контенте. Затем собрать client `.exe` для v2 по [`ADR-0022`](adr/0022-v2-windows-alpha-installers.md).
8. **Закрытая внутренняя alpha на одном сервере и клиентских ПК:** подготовить server setup `.exe`, выбрать LAN/VPN, проверить TLS и client-to-storage flow, затем пройти сценарии артиста/слушателя через client `.exe`. Упаковка и проверка на Windows — после Stack Ready; подробный план — [`INTERNAL-ALPHA-PLAN.md`](INTERNAL-ALPHA-PLAN.md). Это не внешняя бета.
9. **Позже — внешняя закрытая бета:** только после legal/privacy/consent review, процесса жалоб, операционных тестов и отдельного Go решения; текущая когорта — 0.
10. **Ф4–Ф5:** промо/монетизация/лейбл и масштабирование — после подтверждённой ценности и правового/финансового дизайна.

Календарные даты не назначены: остаются owner-run Windows, юридическая консультация, операционная приёмка и решения по production-провайдерам.

## Beta go/no-go

Перед внешними участниками должны одновременно выполняться все условия:

- [ ] письменная legal/privacy проверка, выбранная юрисдикция и утверждённые условия;
- [ ] владелец жалоб, takedown/appeal-процесс и безопасный приватный канал feedback;
- [ ] сайт подключён к v2 API, а регистрация и доступ ограничены приглашёнными;
- [ ] upload → quarantine → moderation → publication → catalog протестирован; неподтверждённый контент остаётся закрытым;
- [ ] PostgreSQL, storage, очереди, backups/restore и Windows runbook проверены на целевом контуре;
- [ ] security/permission/IDOR/E2E smoke пройден, секреты и данные участников не попадают в Git;
- [ ] участники дали актуальное согласие, их количество зафиксировано без хранения PII в репозитории.

До закрытия этих пунктов: **не объявлять бету готовой, не приглашать внешнюю когорту, не выставлять API в интернет и не принимать пользовательскую музыку.**

## Состояние ветки и уборка

Работа продолжается только в активной ветке `arena/3e05af70-vision`; `main` не изменялся, другие ветки не создавались и не переключались. При восстановлении checkout локальный `HEAD` был выровнен с remote через `git reset --mixed`, сохранив изменения рабочей копии. `git clean` и удаление remote refs не выполнялись.

README остаётся презентацией продукта; технические детали собраны в Markdown-документации. Актуальное состояние ветки, backend checkpoint и открытые гейты описаны в [`ROADMAP-v2.md`](ROADMAP-v2.md) и [`BETA-PLAN.md`](BETA-PLAN.md).
