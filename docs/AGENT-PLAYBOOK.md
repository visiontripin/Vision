# Agent Playbook — как работать в этом репозитории

**Для кого:** ИИ-агент (и владелец) в песочнице/локальном checkout. Копировать решения, не изобретать заново. Всё проверено на этой ветке 2026-11-12. Здесь только *how-to*; источники правды по состоянию — `ROADMAP-v2.md`, `DEVELOPMENT-ROADMAP.md`, `PLATFORM-OPERATIONS.md` §5.

## 0. Золотые правила

- Только ветка `arena/3e05af70-vision`. Не создавать/не переключать ветки, не пушить в другие. Пуш — только fast-forward, без `--force`.
- `apps/mobile/vision-release.p12` — **tracked** файл; `*.p12` в `.gitignore` не действует на него (существующий остаётся в истории; новые p12 не добавятся). Никогда не удалять/не ротировать без отдельного решения владельца (ANDROID.md).
- Техническая готовность ≠ разрешение на публичный UGC/бету. Gate не отмечать выполненным за владельца.
- Docker/Redis/Postgres в песочнице **нет**. Нельзя "проверить руками" — делаем код + тесты на PGlite + turnkey-пакет (`docs/PLATFORM-REHEARSAL.md`) для владельца.

## 1. Песочница пересоздаётся → репозиторий «откатывается» на base

Симптомы: `git rev-parse HEAD` показывает базовый коммит (`9524489`), изменения — untracked/modified, `git log` пуст. **Рабочее дерево сохраняется.** Восстановление:

```bash
git fetch origin
git rev-parse origin/arena/3e05af70-vision   # remote tip — источник истины (пуши не теряются)
```

Проверка «дерево == remote» (без потери untracked):

```bash
export GIT_INDEX_FILE=/tmp/tmpindex-check; rm -f "$GIT_INDEX_FILE"
git read-tree origin/arena/3e05af70-vision   # ВАЖНО: от remote-дерева, не с нуля
git add -A                                     # untracked файлы тоже сравниваем
git diff --cached --name-only origin/arena/3e05af70-vision
# ожидаемо: пусто (или только что созданные файлы текущей задачи)
rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE
```

Подвох: scratch-индекс «с нуля» теряет tracked-ignored файлы (`vision-release.p12`) и ложно сообщает о расхождении — поэтому `git read-tree` от remote первой командой. `git check-ignore <tracked-path>` вернёт «не игнорируется» (правила не действуют на tracked), для нового пути — сработает.

Затем — **никогда `git reset --hard` при грязном дереве** (это стёрло день работы один раз). Безопасно: `git merge --ff-only origin/arena/3e05af70-vision` — двигает ветку на tip, сохраняя uncommitted-изменения (если git считает, что FF возможен; иначе просто откажет и ничего не уничтожит). `git reset --hard` допустим только когда `git diff --cached <remote>` пуст. Если diff показывает ровно ваши новые/изменённые файлы — это uncommitted work, его коммитят (после перехода на tip), не сносят.

Практика: сверка через scratch-индекс занимает секунды — делать её **до** любых разрушительных операций, а `git status --short` до и после.

`node_modules` исчезает вместе с песочницей → `npm ci` (165 пакетов; ioredis, pg, PGlite, @aws-sdk/client-s3 есть; занимает ~30 с).

## 2. Git/GitHub практика

- `git push` после пересоздания может отклониться (`fetch first`) — просто повторить после восстановления (fast-forward, история не менялась).
- CI: push сам запускает workflow (~2 мин). Смотреть:
  ```bash
  gh run list --branch arena/3e05af70-vision --limit 4
  gh run watch <id> --exit-status --interval 15   # exit ≠ 0 при падении
  gh run view <id> --json conclusion,jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'
  ```
  Обязательные зелёные джобы: Platform integration (PostgreSQL 16 + Redis 7.4 + MinIO), Tests/build, API smoke, Android typecheck.
- branch protection API → **403**; описание/topics репозитория → 403; PR создавать не нужно — работа прямо в ветке.
- Локальные проверки перед коммитом: `git diff --check`, `bash -n` для shell, `node --check` для скриптов.
- Коммиты — обычные (`feat(stage1): …`), без WIP, push сразу.

## 3. Тесты: три независимых сьюта (все должны быть зелёными)

| Сьют | Команда | Время | Примечание |
|---|---|---|---|
| API (unit + PGlite e2e) | `npm test` | ~60 с | 273 pass / 6 skip (интеграция гейтится env) |
| Клиент (web/mobile/console/local) | `npm run test:local` | ~10 с | 145 pass |
| Скрипты (`scripts/*.test.mjs`) | `npm run test:scripts` | ~20 с | 35 pass; сюда попал и importer |

- Интеграционные тесты пропускаются по env: `PLATFORM_DATABASE_URL` (PG), `PLATFORM_REDIS_URL` (Redis), `PLATFORM_S3_*` (MinIO) — в CI они заданы и реально бегут.
- **Паттерн PGlite-теста платформы** (эталон — `services/api/test/platform-ingest-e2e.test.js`): `PGlite({ extensions: { vector } })`, pool-стаб: `connect` возвращает client с `query` (BEGIN/COMMIT/ROLLBACK → `{rows:[]}`, иначе `database.query(sql, values)` или `database.exec`), `runPlatformMigrations(pool, { directory: MIGRATIONS_DIR })`; fake memory storage имитирует S3 (`headObject`/`hashObject`/`copyObject`/`deleteObject`/`putPrivateObject`), fake transcoder — доработать по месту.
- Кворумы интеграции: importer-тесты следуют этому же шаблону (см. `scripts/platform-sqlite-import.test.mjs`).
- Количество тестов в md быстро устаревает → после прогона обновлять `DEVELOPMENT-ROADMAP.md`, а не переписывать историю.

## 4. Платформенный контур v2 — что и где лежит

- Миграции: `services/api/src/platform/migrations/00{1..8}_*.sql`, runner `migrations.js`, `createPlatformPool()` требует `PLATFORM_DATABASE_URL` (отдельный pool, **не** DATABASE_URL).
- Upload/ingest путь (переиспользовать, не дублировать): `platform/upload.js` — `createUploadIntent` (owner + quota + валидация AUDIO_TYPES, размер ≤ `PLATFORM_UPLOAD_MAX_BYTES`=200 МБ) → `storage.putPrivateObject({key: storage.makeQuarantineKey({ownerId, trackId, intentId})})` → `completeUploadIntent` (head/hash/copy/delete, `media_objects` + `platform_outbox`) → worker. Ключ детерминирован от IDs.
- Storage: `platform/storage.js` — `createPlatformStorage()` читает `PLATFORM_S3_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY/REGION/PUBLIC_ENDPOINT`; `headObject/hashObject/copyObject/deleteObject`.
- Rate-limit: `platform/rate-limit.js` — `PLATFORM_RATE_LIMIT_POLICIES`, Redis Lua fixed-window + HMAC-ключи (`vision-platform:rate-limit:v1:`), fail-closed 503; in-memory — только для unit-тестов.
- Metrics: `platform/metrics.js` — token-gated `/metrics` (`PLATFORM_METRICS_TOKEN` ≥ 32 байта, 404 без/с плохим токеном); логи — JSON, request-id.
- Backup/restore: `npm run platform:local:{init,up,migrate,status,logs,backup,restore,down}` (`scripts/platform-local.mjs`), data-layer — `platform-local-data.mjs`; restore деструктивен, всегда pre-restore bundle, API/worker остаются stopped.
- Legacy SQLite: прежний сервер изображён модулем констант в `scripts/platform-sqlite-audit.mjs` (read-only inventory); новый импортёр `platform-sqlite-import.mjs` ходит в **платформенные** PG/S3, не в SQLite-сервер.
- Docker Desktop локально: хост-порты loopback-only (4400 API, 9001 MinIO); между контейнерами — service names (`database`, `redis`, `storage`, сеть обычно `vision_default`); одноразовые инструменты гонять через `docker run --rm --network <net> -v "${PWD}:/app" -w /app …`.

## 5. Документы и ledger — правила дисциплины

- `docs/PLATFORM-OPERATIONS.md` §5 — единственный стандартный acceptance ledger. Каждый гейт: реализация + что нужно для закрытия + честная пометка «не принято».
- `docs/PLATFORM-REHEARSAL.md` — turnkey пакет owner-run репетиции (A..F). Всё, что нельзя сделать в песочнице, попадает туда готовыми командами + критериями; не отмечать галочкой то, что можно только подтвердить на машине владельца.
- `docs/ROADMAP-v2.md` — scope + чеклисты; менять статусы `[~]` → `[x]` только после принятия по гейту. Backend checkpoint (§16) — факты реализации, не acceptance.
- ADR не принимать самому (внешние решения — владелец/юрист).
- Документы — по-русски, коротко, без воды; «ухищрение» = одна команда/решение с максимальным эффектом.
- Новые md обязательно линковать из `docs/INDEX.md`.

## 6. Быстрые команды

```bash
npm ci                       # после пересоздания песочницы
npm run test:all             # API + local + scripts
npm run typecheck:api && npm run check:api-types
npm run build && npm run build:console
git diff --check && git status --short
gh run watch --exit-status --interval 15 <runId>
```

## 7. Известные ловушки (уже решены — не решать заново)

- `node --test scripts/*.test.mjs` запускает importer-тесты с негомогенным окружением — `node:sqlite` пишет ExperimentalWarning (на Node 22 это норма; в тестах PGlite подключается напрямую).
- `--owner` валидировать до подключения к PG/S3 (чтобы ошибка не маскировалась «PLATFORM_DATABASE_URL is required»); `node:sqlite` импортировать лениво (чтобы `--help` не ругался на экспериментальный модуль).
- pip в системе заблокирован (PEP 668): ставить в venv в /tmp (`python3 -m venv /tmp/yamlcheck && /tmp/yamlcheck/bin/pip install pyyaml`). PyPI доступен (pypi.org/files.pythonhosted.org — разрешённые хосты), а глобальный `pip install` в системный site-packages — нет.
- `git diff` не видит untracked → сначала `git status --short`, для сравнения деревьев — `git read-tree` (см. §1), не `git diff`.
- Ключи Redis rate-limit и отчёт импортёра не содержат сырых PII — так и оставлять (HMAC/sourceId+sha256).
- `test:scripts` гоняется в CI (`ci.yml`, job «Tests, JSDoc typecheck and web build») — новые `scripts/*.test.mjs` автоматически попадают в CI.
- Тестовые типы: `fs.statSync(path, { throwIfNoEntry: false })` возвращает undefined вместо throw — удобно для предпроверок CLI.
