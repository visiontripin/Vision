# Vision v2 — репетиция Stack Ready на ПК владельца (runbook)

**Статус:** готовая к исполнению инструкция для владельца (turnkey-пакет). Ничто здесь не принято, пока владелец не выполнит шаги и не зафиксирует результаты в [`PLATFORM-OPERATIONS.md`](PLATFORM-OPERATIONS.md) §5 и [`ROADMAP-v2.md`](ROADMAP-v2.md) §17.4. Техническая репетиция ≠ юридическое разрешение на публичный UGC.

Закрывает owner-run пробелы ADR-0021: backup/restore/rollback rehearsal, live Redis verification + rate-limit review, production observability wiring, SQLite importer rehearsal. CI evidence (PostgreSQL 16 + pgvector, Redis/BullMQ, MinIO) уже пройдена на ветке; этот runbook дополняет её репетицией на машине владельца.

**Предусловия:** Windows 10/11, Docker Desktop (WSL2 backend) запущен, checkout `main` (работа ветки `arena/3e05af70-vision` интегрирована в `main` 2026-11-24), Node ≥ 22.16 (`node --version`), `npm ci` выполнен, порт 4400/9001 свободны, ≥ 10 ГБ диска, все команды из корня репозитория в PowerShell.

## A. Поднять изолированный локальный контур

```powershell
npm run platform:local:init      # one-time; создаёт .env.platform.local со случайными секретами
npm run platform:local:up
npm run platform:local:migrate
npm run platform:local:status    # database/redis/storage healthy; API на 127.0.0.1:4400
Invoke-RestMethod http://127.0.0.1:4400/api/v2/health | ConvertTo-Json -Depth 5
```

Приёмка A: health отвечает `ready` (не 503), migration name совпадает с `git log -1 --oneline -- services/api/src/platform/migrations`, порты слушаются только на 127.0.0.1.

## B. Rehearsal backup → restore → rollback

```powershell
# 1. Снимок
npm run platform:local:backup -- backups/platform-v2/rehearsal-1
# Ожидается: manifest с SHA-256, счётчики байт/объектов, services остановлены и подняты обратно.

# 2. Зафиксировать эталон (диагностика из PLATFORM-OPERATIONS.md §2, read-only):
#    row counts tracks/upload_intents/media_objects, outbox pending/dead-lettered, число S3-объектов.

# 3. Восстановление (деструктивно для локального состояния; делает pre-restore backup)
npm run platform:local:restore -- backups/platform-v2/rehearsal-1 --confirm
npm run platform:local:up
Invoke-RestMethod http://127.0.0.1:4400/api/v2/health
# Сверить row counts и S3 object count с эталоном из шага 2 — должны совпасть.

# 4. Rollback-репетиция: повторить restore из шага 3 на bundle pre-restore-*, созданный автоматически.
```

Приёмка B (все пункты обязательны): bundle верифицируется (команды не падают); pre-restore bundle создан; после restore миграция/health/row counts/число объектов совпадают с эталоном; rollback на pre-restore bundle тоже успешен; время каждой операции записано (для RTO-обсуждения). Папки `backups/` не коммитить.

## C. Live Redis verification + rate-limit review

### C1. Hosted evidence (быстро)

```powershell
gh run list --branch main --workflow ci.yml --limit 1
```

Открыть run; джоба с PostgreSQL 16 + Redis 7.4 + MinIO должна быть зелёной (интеграционные тесты `platform-postgres|queue|storage.integration.test.js` и Redis-тесты rate-limit). Красный или отменённый run — сначала разобраться, потом репетиция.

### C2. Локальная live-проверка Redis (на машине владельца)

```powershell
# redis-cli внутри compose-сети:
$envFile = Get-Content .env.platform.local
$redisPassword = ($envFile | Select-String '^PLATFORM_REDIS_PASSWORD=').ToString().Split('=',2)[1]
docker compose --env-file .env.platform.local -f compose.platform.local.yml exec redis redis-cli -a $redisPassword PING   # -> PONG

# Node-интеграционные тесты против живого Redis через одноразовый контейнер в compose-сети.
# Сеть: docker network ls | findstr default  (обычно vision_default; подставьте свою)
docker network ls --format '{{.Name}}' | Select-String 'default$'
$net = 'vision_default'
$authSecret = ($envFile | Select-String '^PLATFORM_AUTH_SECRET=').ToString().Split('=',2)[1]
docker run --rm --network $net -v "${PWD}:/app" -w /app `
  -e PLATFORM_REDIS_URL="redis://:$redisPassword@redis:6379/0" `
  -e PLATFORM_AUTH_SECRET=$authSecret `
  node:22.22.3-slim node --test services/api/test/platform-rate-limit.test.js
```

(Требуется включённый file sharing для диска репозитория в Docker Desktop.)

Ожидается: 6/6 pass, ни одного skip; тесты `shared Redis fixed window…` и `HTTP throttling is shared across API instances…` доказывают общий счётчик между инстансами. Затем проверить ключи (значения — только HMAC-дайджесты, сырых IP/email нет):

```powershell
docker compose --env-file .env.platform.local -f compose.platform.local.yml exec redis redis-cli -a $redisPassword --scan --pattern 'vision-platform:rate-limit:v1:*' | Select-Object -First 5
docker compose --env-file .env.platform.local -f compose.platform.local.yml exec redis redis-cli -a $redisPassword PTTL '<один ключ>'
```

### C3. Rate-limit policy/load review (зафиксировать решение владельца)

Политики — `services/api/src/platform/rate-limit.js` (`PLATFORM_RATE_LIMIT_POLICIES`): registerIp 10/ч, registerIdentity 3/ч, loginIp 30/15 мин, loginIdentity 10/15 мин, refreshIp 60/15 мин, publicRead/apiRead/events 120/мин, uploadIp 10/мин, rightsClaim 5/ч, radioSession 10/мин, voiceRender 10/мин, apiWrite 60/мин — общий fixed-window счётчик через Redis, HMAC-ключи, fail-closed (503 `rate_limit_unavailable`), in-memory допустим только в unit-тестах.

Закрыть вопросы: (1) лимиты подходят ли для closed alpha с 10 артистами + 50 слушателями (подсказка: даже 120 req/мин на IP — с запасом; `uploadIp 10/мин` — ок для ручной загрузки); (2) допустим ли всплеск на границе окна fixed-window (до 2× limit за 2 секунды) — если нет, нужен sliding/token bucket отдельной задачей; (3) поведение при недоступном Redis (API отдаёт 503, публичный трафик в alpha запрещён — решается отказом, не обходом); (4) перенести ли лимиты в конфигурацию до production. Результат ревью записать в таблицу F этого документа и перенести в `PLATFORM-OPERATIONS.md` §5 (ledger); код не менять без отдельного решения владельца.

## D. Observability wiring (local rehearsal + production prerequisites)

```powershell
# Токен метрик (≥ 32 байта):
$metricsToken = [Convert]::ToHexString((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
# Дописать/заменить строку PLATFORM_METRICS_TOKEN=<metricsToken> в .env.platform.local, затем:
npm run platform:local:down; npm run platform:local:up
$headers = @{ Authorization = "Bearer $metricsToken" }
Invoke-RestMethod -Headers $headers http://127.0.0.1:4400/metrics | Select-Object -First 12   # 200, Prometheus text
try { Invoke-RestMethod http://127.0.0.1:4400/metrics } catch { $_.Exception.Response.StatusCode }  # 404 без токена
```

Дальше — подготовить production-обвязку (не в этом локальном контуре): Prometheus scrape job `vision-platform-api` с bearer-токеном на token-gated `/metrics` (endpoint не публиковать, токен не класть в URL), правила алертинга `deploy/observability/prometheus-alerts.example.yml` (стартовые пороги, severity page/ticket), retention/access review для JSON-логов и метрик, контакты эскалации, incident drill (остановить `api`, убедиться, что алерт сработал и восстановился). Воркер: Compose health endpoint (`http://worker:4401/health`, порт не публиковать). Outbox/DLQ/expired-intents — только ручные SQL-проверки из PLATFORM-OPERATIONS.md §2 до появления blackbox SQL-экспортёра (известный gap, вписан в пример алертов).

Приёмка D: `/metrics` 200 с токеном / 404 без; скрейп-конфиг и алерт-файл сохранены вне Git в приватном месте оператора (или в private инфра-репозитории); владелец назначил retention, доступ и контакты; drill записан.

## E. SQLite importer rehearsal (только на одноразовом контуре)

Импортёр ходит в PostgreSQL и S3 по service-именам compose-сети (`database`, `storage`), поэтому запускается одноразовым контейнером в той же сети, а не с хоста. Исходный bundle монтируется read-only и не изменяется.

```powershell
# 0. Решение владельца, ЧТО импортируем (default: ничего). Только tracks/blobs/media, приватно.
# 1. Свежий проверенный v1 backup → распаковать в приватную папку (как в PLATFORM-OPERATIONS.md §3.1):
node scripts/verify-backup.mjs <archive>
# 2. Инвентаризация на хосте (read-only, без сети): npm run platform:sqlite:audit -- <bundleDir>

$envFile = Get-Content .env.platform.local
$dbUser = ($envFile | Select-String '^PLATFORM_DB_USER=').ToString().Split('=',2)[1]
$dbName = ($envFile | Select-String '^PLATFORM_DB_NAME=').ToString().Split('=',2)[1]
$dbPassword = ($envFile | Select-String '^PLATFORM_DB_PASSWORD=').ToString().Split('=',2)[1]
$s3KeyId = ($envFile | Select-String '^PLATFORM_S3_ACCESS_KEY_ID=').ToString().Split('=',2)[1]
$s3Secret = ($envFile | Select-String '^PLATFORM_S3_SECRET_ACCESS_KEY=').ToString().Split('=',2)[1]
$authSecret = ($envFile | Select-String '^PLATFORM_AUTH_SECRET=').ToString().Split('=',2)[1]
$net = 'vision_default'   # docker network ls | findstr default — подставьте свою сеть

# 3. Создать целевого owner-пользователя (artist) и quota в одноразовом контуре:
docker compose --env-file .env.platform.local -f compose.platform.local.yml exec database psql -U $dbUser -d $dbName -c "INSERT INTO users (email, display_name, primary_role) VALUES ('import-rehearsal@vision.local', 'Import rehearsal owner', 'artist') RETURNING id;"
# → скопировать uuid из RETURNING; затем (storage_limit_bytes ≥ суммарного объёма импорта, пример 20 ГБ):
docker compose --env-file .env.platform.local -f compose.platform.local.yml exec database psql -U $dbUser -d $dbName -c "INSERT INTO user_quotas (user_id, storage_limit_bytes, monthly_upload_limit) VALUES ('<uuid>', 21474836480, 500);"

# 4. Dry-run (ничего не пишет; требует только существующего owner'а):
docker run --rm --network $net -v "${PWD}:/app" -v "<bundleDir>:/bundle:ro" -w /app `
  -e PLATFORM_DATABASE_URL="postgresql://$dbUser`:$dbPassword@database:5432/$dbName" `
  -e PLATFORM_S3_ENDPOINT=http://storage:9000 -e PLATFORM_S3_BUCKET=vision-media `
  -e PLATFORM_S3_ACCESS_KEY_ID=$s3KeyId -e PLATFORM_S3_SECRET_ACCESS_KEY=$s3Secret `
  -e PLATFORM_AUTH_SECRET=$authSecret `
  node:22.22.3-slim node scripts/platform-sqlite-import.mjs --source /bundle --owner <uuid> --report import-dryrun.json

# 5. Apply (на одноразовом контуре, никакого production):
docker run --rm --network $net -v "${PWD}:/app" -v "<bundleDir>:/bundle:ro" -w /app `
  -e PLATFORM_DATABASE_URL="postgresql://$dbUser`:$dbPassword@database:5432/$dbName" `
  -e PLATFORM_S3_ENDPOINT=http://storage:9000 -e PLATFORM_S3_BUCKET=vision-media `
  -e PLATFORM_S3_ACCESS_KEY_ID=$s3KeyId -e PLATFORM_S3_SECRET_ACCESS_KEY=$s3Secret `
  -e PLATFORM_AUTH_SECRET=$authSecret `
  node:22.22.3-slim node scripts/platform-sqlite-import.mjs --source /bundle --owner <uuid> --apply --report import-apply.json

# 6. Сверка (read-only):
docker compose --env-file .env.platform.local -f compose.platform.local.yml exec database psql -U $dbUser -d $dbName -c "SELECT status, visibility, count(*) FROM tracks WHERE owner_id = '<uuid>' GROUP BY 1,2 ORDER BY 1,2;"
docker compose --env-file .env.platform.local -f compose.platform.local.yml exec database psql -U $dbUser -d $dbName -c "SELECT object_kind, lifecycle_state, count(*) FROM media_objects GROUP BY 1,2;"
# counts в import-apply.json: imported == would_import из dry-run; skipped по disposition разобраны; failed == 0.
# Повторный --apply обязан вернуть already_imported == imported и не создать новых строк tracks.

# 7. Перед любой публикацией — rights acknowledgement + moderation decision на каждый трек (v2 APIs).
```

Импортёр идемпотентен по SHA-256 (повторный запуск не дублирует), ничего не публикует и не одобряет; отчёт — без названий/путей, только sourceId/sha256/disposition. Приёмка E: отчёт dry-run согласован с apply (would_import == imported, failed == 0 либо каждый failed разобран); SHA-256 каждого импортированного файла сверен с отчётом; v1 архив не изменён; tracks остались private/quarantine; reconciliation report подписан владельцем.

## F. Подпись владельца (заполнить и вернуть)

| Пункт | Дата | Результат | Артефакт (путь/ссылка) |
|---|---|---|---|
| B backup/restore/rollback rehearsal | | | |
| C1 CI matrix green | | | |
| C2 live Redis (6/6 tests, keys HMAC-only) | | | |
| C3 rate-limit policy/load review decision | | | |
| D observability wiring + drill | | | |
| E1 importer dry-run vs audit согласованы | | | |
| E2 importer apply на одноразовом контуре, reconciliation подписан | | | |
| Owner Stack Ready sign-off (ADR-0021) | | | |

Gate **не принят**, пока все строки не заполнены и результаты не перенесены в `PLATFORM-OPERATIONS.md` §5. Дополнительно остаются самостоятельными блокерами: внешнее юридическое заключение, согласие бета-участников, ADR-0015. Технический gate не разрешает публичные UGC-загрузки, рекламу, монетизацию или эфир.
