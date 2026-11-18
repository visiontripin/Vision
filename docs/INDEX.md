# Документация Vision Audio

README в корне — короткая презентация продукта. Здесь собраны продуктовые решения, инженерные инструкции и рабочие записи проекта. Техническая документация хранится в Markdown.

## Продукт и план

- [`PRODUCT.md`](PRODUCT.md) — видение, персоны, продуктовые границы и защитные правила.
- [`ROADMAP-v2.md`](ROADMAP-v2.md) — основной scope, фазы, контракты и критерии приёмки.
- [`DEVELOPMENT-ROADMAP.md`](DEVELOPMENT-ROADMAP.md) — точка остановки, оценка прогресса и следующий план.
- [`RADIO-GRID.md`](RADIO-GRID.md) — бумажная сетка будущего радио.
- [`research/SOUNDCLOUD-TEARDOWN.md`](research/SOUNDCLOUD-TEARDOWN.md) — исследовательский разбор продукта.

## Разработка, архитектура и эксплуатация

- [`DEVELOPMENT.md`](DEVELOPMENT.md) — установка зависимостей, проверки и локальная безопасность.
- [`ARCHITECTURE.md`](ARCHITECTURE.md), [`API.md`](API.md) — текущая архитектура и API-контракты.
- [`RUNBOOK.md`](RUNBOOK.md) — операции, окружение, миграции и резервное копирование.
- [`BETA-WINDOWS-LOCAL.md`](BETA-WINDOWS-LOCAL.md) — ограниченный loopback-only контур v2 для локальной проверки на Windows.
- [`PLATFORM-OPERATIONS.md`](PLATFORM-OPERATIONS.md) — backup/restore/rollback, SQLite migration/reconciliation и локальные сигналы наблюдаемости для v2.
- [`INTERNAL-ALPHA-PLAN.md`](INTERNAL-ALPHA-PLAN.md) — поэтапный план внутренней технической alpha на одном сервере; Stack Ready и сетевой доступ пока не приняты.
- [`DISTRIBUTED.md`](DISTRIBUTED.md), [`SYNC.md`](SYNC.md), [`CONTENT.md`](CONTENT.md) — legacy-архитектура и описание прежних клиентских сценариев; не инструкции по сетевому запуску.
- [`IMPROVEMENTS.md`](IMPROVEMENTS.md) — legacy-бэклог существующего плеера; не roadmap платформы v2.
- [`adr/`](adr/) — журнал архитектурных решений.

## Клиенты и поставка

- [`ANDROID.md`](ANDROID.md), [`DESKTOP.md`](DESKTOP.md) — статус и архивные инструкции по клиентам; новые публикации требуют отдельного решения.
- [`TERMUX.md`](TERMUX.md) — архивный статус; прежние сетевые инструкции отозваны.
- [`RELEASES.md`](RELEASES.md), [`DOWNLOADS.md`](DOWNLOADS.md) — статус и правила публикации артефактов.
- [`HOME-SERVER-WINDOWS.md`](HOME-SERVER-WINDOWS.md) — архивный, непроверенный эксперимент Windows Vision Server и его открытые решения.
- [`REPO-METADATA.md`](REPO-METADATA.md) — состояние метаданных и лицензии репозитория.

## Бета, права и приватность

- [`BETA-PLAN.md`](BETA-PLAN.md), [`BETA-CONSENT-TEMPLATE.md`](BETA-CONSENT-TEMPLATE.md), [`BETA-FEEDBACK-FORM.md`](BETA-FEEDBACK-FORM.md) — черновики; не приглашение и не юридически утверждённые формы.
- [`legal/CONSULTATION-BRIEF.md`](legal/CONSULTATION-BRIEF.md) — вопросы для юридической консультации.

## Журнал и исторические материалы

- [`WORKSPACE-RECOVERY-LOG.md`](WORKSPACE-RECOVERY-LOG.md) — сохранённое состояние активной рабочей ветки и журнал направления работ.
- [`BRANCH-CLEANUP-AUDIT.md`](BRANCH-CLEANUP-AUDIT.md) — аудит remote refs; сам по себе не разрешает их удаление.
- [`ROADMAP.md`](ROADMAP.md) — исторический план v1; не использовать как актуальный backlog.
