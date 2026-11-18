# Локальный технический контур v2 на Windows

**Статус:** инструкция для разработки/локального smoke-test; это не пользовательская установка, публичный staging или готовая бета.
**Выбранный владельцем сценарий:** платформа независимой музыки v2 на домашнем Windows-ПК. Docker Desktop с WSL2 можно установить.
**Проверки:** GitHub Actions [run #43806758735](https://github.com/visiontripin/Vision/actions/runs/43806758735) прошёл API/web/Android checks, health/OpenAPI smoke, authenticated MinIO readiness через `mc ready local` с CI credentials и интеграции на PostgreSQL 16 + pgvector, Redis и S3-compatible MinIO. Локальный Docker Engine, целевой Windows-ПК и backup/restore на нём ещё не проверены.

## Важно: что этот контур делает и чего не делает

Compose запускает изолированные PostgreSQL 16 с pgvector, Redis, приватное S3-совместимое хранилище MinIO, ранний v2 API и worker. API доступен на самом ПК через `http://127.0.0.1:4400`; PostgreSQL и Redis не публикуют порты на хост, S3 доступен только на `127.0.0.1:9001`. Регистрация и загрузки выключены, реальные учётные записи/участники не создаются. Контейнер MinIO берётся из `ghcr.io/coollabsio/minio` и закреплён на релизе `RELEASE.2025-10-15T17-29-55Z`, собранном из исходников MinIO; это dev/test-зависимость, не утверждённое production-хранилище.

Это **не сайт для беты**: `apps/web` пока остаётся личным плеером и не подключён к v2 API; полноценного каталога с пользовательскими треками нет. На этом этапе можно проверить запуск platform services, миграций, worker, OpenAPI/health и пустого каталога. Не отправляйте артистам ссылки и не загружайте чужую музыку. Для локальных API-тестов используйте только синтетические данные.

Этот контур не возобновляет замороженный `apps/console` / Windows-службу из ADR-0016/0020 и не меняет workflow релизов. Не запускайте для этой проверки `npm start`: это отдельный legacy SQLite-сервер личной библиотеки.

## Требования

- Windows 10/11 x64 с включённой аппаратной виртуализацией.
- Docker Desktop для Windows с WSL2 backend и Linux containers; после установки проверьте в новом PowerShell: `docker compose version`.
- Node.js 22.5+ и npm (для репозитория рекомендован Node 22 LTS); проверьте `node --version` и `npm --version`.
- Свободное место для Docker-образов и named volumes PostgreSQL, Redis и MinIO. Данные остаются на диске после остановки контейнеров.

Установку Docker Desktop выполняет владелец на своём ПК. Репозиторий не запускает установщик и не меняет Windows Firewall.

## Запуск

Из PowerShell в корне клона репозитория:

```powershell
npm ci
npm run platform:local:init
npm run platform:local:up
```

`init` один раз создаёт `.env.platform.local` с криптографически случайными секретами базы, подписи, Redis и S3. Файл добавлен в `.gitignore`; он не должен попадать в Git, архивы обратной связи или скриншоты. Команда не перезаписывает существующие секреты.

`up` поднимает PostgreSQL, Redis и закрытое S3-хранилище, собирает ранний API-контейнер, применяет миграции и запускает API вместе с worker. Первое скачивание образов/сборка могут занять время. После успеха проверьте:

```powershell
Invoke-RestMethod http://127.0.0.1:4400/api/v2/health
Invoke-RestMethod http://127.0.0.1:4400/api/v2/catalog
```

Ожидаемо: `health.ok` и `health.schemaReady` равны `true`, `health.migration` совпадает с `health.requiredMigration` (`008_playback_sessions.sql`), каталог пустой. Документ API: `http://127.0.0.1:4400/api/v2/openapi.json`.

## Управление

```powershell
npm run platform:local:status
npm run platform:local:logs     # Ctrl+C прекращает просмотр логов
npm run platform:local:migrate  # применить/проверить новые миграции
npm run platform:local:backup -- backups/platform-v2/before-local-test  # choose a new unused name for each snapshot
npm run platform:local:down     # остановить контейнеры, данные сохранить
```

`backup` приостанавливает API и worker, создаёт локальный проверяемый bundle PostgreSQL/MinIO/Redis и затем возвращает ранее работавшие API/worker. Пример использует `backups/platform-v2/before-local-test`; команда не перезаписывает существующую копию, поэтому для повторов выберите новое уникальное имя. Каталог содержит приватные медиа и состояние очередей: не отправляйте его в Git или публичные хранилища. Пример восстановления после выбора и проверки конкретной копии:

```powershell
npm run platform:local:restore -- backups/platform-v2/backup-2026-11-12T120000Z --confirm
npm run platform:local:up
```

Restore создаёт pre-restore safety backup и намеренно оставляет API/worker остановленными, пока не выполнен `up`. Это локальная процедура; owner-run restore/rollback на целевом Windows-ПК всё ещё требуется.

`down` сохраняет named volumes `platform-pgdata`, `platform-redisdata` и `platform-miniodata`. Не добавляйте `-v` к `docker compose down`, если не хотите безвозвратно удалить локальные тестовые данные. `.env.platform.local` остаётся после остановки, чтобы тот же signing key продолжал работать при следующем запуске.

## Сетевые и продуктовые ограничения

- API опубликован только на loopback (`127.0.0.1:4400`), S3 endpoint — только на `127.0.0.1:9001`; PostgreSQL и Redis доступны лишь внутри Docker-сети. Не меняйте привязки на `0.0.0.0`, не открывайте порты в Windows Firewall и не делайте port-forward на роутере. `/metrics` требует сгенерированный bearer token из `.env.platform.local`; endpoint не публикуйте, токен не вставляйте в URL и не копируйте в логи/обращения.
- Регистрация закрыта (`PLATFORM_REGISTRATION_ENABLED=0`). Не включайте её для домашней сети: у раннего API ещё нет приглашений/email-подтверждения и rate limits.
- Регистрация и загрузки отключены; runtime не является пользовательским ingest-процессом. Реального fingerprint-провайдера и v2 UI нет, `not_configured` не означает `clear`. Несмотря на зелёную CI-интеграцию, этот рецепт на Windows, backup/restore, security review и Stack Ready gate ещё не проверен.
- Публичная бета, внешний набор участников и пользовательские загрузки остаются заблокированы legal/privacy/rights/moderation/operations гейтами из [`BETA-PLAN.md`](BETA-PLAN.md).

Останавливайте контур через `npm run platform:local:down`, когда закончили. Если возникла проблема, передавайте только текст ошибки из логов; не прикладывайте `.env.platform.local`, токены, адреса электронной почты или содержимое пользовательских файлов.
