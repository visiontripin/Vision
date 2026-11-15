# Журнал сохранения и восстановления рабочей ветки

**Срез:** 2026-11-12
**Назначение:** зафиксировать, что сохраняем, какие решения изменили курс и как безопасно продолжать работу. Это журнал состояния в Markdown, а не копия файлов проекта: исходники остаются в текущем рабочем дереве.

## Контрольная точка

- Репозиторий: `visiontripin/Vision`.
- Единственная ветка для дальнейшей работы: `arena/3e05af70-vision`.
- База и текущий `HEAD` на момент аудита: `9524489e0ea9dafe439e43cf41f265411e0e7f0b`.
- Ветка не переключалась, новые ветки не создавались. `main` оставлен как базовая ссылка.
- На момент фиксации: 81 изменённый tracked-файл (58 модифицированы, 23 удалены) и 63 нужных untracked-файла. В `git status --short` untracked-файлы свёрнуты в 48 записей из-за каталогов. Это накопленная работа ветки, не мусор для массовой очистки.
- Не выполнялись `git clean`, reset, commit, push или удаление GitHub refs. Изменения сохранены в рабочем дереве и не были свёрнуты в commit.
- Из репозитория не удалялись файлы в рамках этой уборки: удалены только локальные игнорируемые сборочные каталоги `apps/web/dist/` и `apps/console/dist/`. Несколько небезопасных/устаревших сетевых инструкций переписаны как архивные предупреждения; исходники сохранены. `node_modules/` оставлен и игнорируется Git.

## Указания владельца — текущая основа работы

1. Продолжать только в активной ветке, сохраняя необходимые исходники и инструкции.
2. Сохранять отдельную Markdown-запись, чтобы видеть, что было сделано и где изменили курс.
3. Оставить ветку без случайных артефактов и лишней информации.
4. Корневой README использовать как презентацию продукта; технические детали и рабочие инструкции держать в Markdown-документах.
5. Не заявлять о готовности беты, публичной загрузке музыки или проверенном Windows Server.

## Что сохранено и почему

- **Переход к Vision Audio v2:** продуктовая цель — платформа независимой музыки и персональное радио «Моя волна». Текущий плеер/API не подменяет собой целевую платформу.
- **Изолированный v2 backend:** ранний API, PostgreSQL-схемы, миграции, identity/catalog/moderation и тесты сохранены как нужная инженерная работа. Локальный Compose-конфиг ограничен loopback; фактический Docker/PostgreSQL/Windows запуск ещё не подтверждён.
- **Windows Vision Server:** кодовый эксперимент сохранён из-за отдельного требования владельца, но не представляется как релиз, проверенная установка или v2 API. Workflow заморожен; см. [`HOME-SERVER-WINDOWS.md`](HOME-SERVER-WINDOWS.md) и [`apps/console/README.md`](../apps/console/README.md).
- **Бета и права:** планы, формы и консультационные материалы остаются черновиками. Они не разрешают набор участников или приём музыки.
- **Публичная витрина:** корневой [`README.md`](../README.md) теперь кратко представляет продукт и явно говорит, что платформа v2 ещё не запущена. Технические инструкции вынесены в [`DEVELOPMENT.md`](DEVELOPMENT.md), список документации — в [`INDEX.md`](INDEX.md).
- **Прогресс:** [`DEVELOPMENT-ROADMAP.md`](DEVELOPMENT-ROADMAP.md) фиксирует около **16%** общего прогресса и **0%** готовности к закрытой бете.

## Где курс был скорректирован

1. **Сервер внутри Android-плеера.** Он был описан как направление версии 0.29.0, затем удалён из активного мобильного пути версии 0.30.0: мобильный APK остаётся клиентом API. История сохранена в `CHANGELOG.md`; удаление списка файлов ниже — намеренная продуктовая работа, а не случайная уборка.
2. **Личный плеер против платформы v2.** Старый README смешивал описание существующего личного плеера, команды сборки, API и план будущего продукта. Текущий README оставлен как презентация; технические инструкции и ссылки собраны в Markdown под `docs/`.
3. **Windows Server.** Код и прежние формулировки могли выглядеть как готовая поставка. Это неверно: Windows-сборка и реальная установка не подтверждены. Статус исправлен в changelog и `apps/console/README.md`; эксперимент сохранён, но закрыт от пользовательских обещаний.
4. **«Почистить ветку».** Сначала трактовка была неоднозначной. После уточнения выполняется уборка документации/игнорируемых артефактов, а не массовое удаление исходников или remote refs. Переходить на другие ветки и удалять refs не нужно.

## Удалённые из активного пути Android embedded-server файлы

Эти 23 tracked-файла уже помечены удалёнными в накопленной работе ветки. Их не следует восстанавливать без отдельного решения о смене продуктового направления:

- `.github/workflows/android-embedded.yml`
- `apps/mobile/nodejs/android/CMakeLists.txt`
- `apps/mobile/nodejs/android/java/app/vision/audio/node/VisionNodeModule.kt`
- `apps/mobile/nodejs/android/java/app/vision/audio/node/VisionNodePackage.kt`
- `apps/mobile/nodejs/android/java/app/vision/audio/node/VisionNodeService.kt`
- `apps/mobile/nodejs/android/node-version.json`
- `apps/mobile/nodejs/android/vision-node-jni.cpp`
- `apps/mobile/nodejs/embedded/bootstrap.mjs`
- `apps/mobile/src/lib/embedded-server.test.ts`
- `apps/mobile/src/lib/embedded-server.ts`
- `apps/mobile/src/lib/tester.test.ts`
- `apps/mobile/src/lib/tester.ts`
- `apps/mobile/src/runtime.ts`
- `apps/mobile/src/screens/ServerStatusScreen.tsx`
- `apps/mobile/src/screens/TesterScreen.tsx`
- `apps/mobile/test/embedded-server.test.mjs`
- `docs/EMBEDDED.md`
- `scripts/android-embed-node.mjs`
- `scripts/android-embed-node.test.mjs`
- `scripts/android-tester-app.mjs`
- `scripts/android-tester-app.test.mjs`
- `scripts/fetch-nodejs-mobile.mjs`
- `scripts/kotlin-sanity.test.mjs`

## Новые файлы, сохранённые в текущей работе

### Локальная платформа v2 и API

- `Dockerfile.platform`
- `compose.platform.local.yml`
- `scripts/platform-local.mjs`
- `scripts/platform-local.test.mjs`
- `scripts/generate-openapi-types.mjs`
- `scripts/openapi-types.test.mjs`
- `packages/shared/src/generated/openapi.d.ts`
- `services/api/src/ambient.d.ts`
- `services/api/src/types.d.ts`
- `services/api/tsconfig.json`
- `services/api/src/platform/auth-crypto.js`
- `services/api/src/platform/catalog.js`
- `services/api/src/platform/config.js`
- `services/api/src/platform/identity.js`
- `services/api/src/platform/migrate.js`
- `services/api/src/platform/migrations.js`
- `services/api/src/platform/migrations/001_identity_catalog.sql`
- `services/api/src/platform/migrations/002_events_recsys.sql`
- `services/api/src/platform/migrations/003_radio_voice.sql`
- `services/api/src/platform/migrations/004_rights_moderation_audit.sql`
- `services/api/src/platform/moderation.js`
- `services/api/src/platform/openapi.js`
- `services/api/src/platform/postgres.js`
- `services/api/src/platform/server.js`
- `services/api/src/platform/start.js`
- `services/api/test/owner-setup.test.js`
- `services/api/test/platform-config.test.js`
- `services/api/test/platform-identity.test.js`
- `services/api/test/platform-migrations.test.js`
- `services/api/test/platform-schema.test.js`
- `services/api/test/platform-server.test.js`
- `services/api/test/shutdown.test.js`

### Windows-эксперимент

- `apps/console/scripts/prepare-server.mjs`
- `apps/console/src-tauri/nsis/vision-service-hooks.nsh`
- `apps/console/src-tauri/tauri.windows.conf.json`
- `apps/console/src/ManagedServerPanel.tsx`

### Документы и визуальные материалы

- `docs/BETA-CONSENT-TEMPLATE.md`
- `docs/BETA-FEEDBACK-FORM.md`
- `docs/BETA-PLAN.md`
- `docs/BETA-WINDOWS-LOCAL.md`
- `docs/BRANCH-CLEANUP-AUDIT.md`
- `docs/DEVELOPMENT-ROADMAP.md`
- `docs/DEVELOPMENT.md`
- `docs/HOME-SERVER-WINDOWS.md`
- `docs/INDEX.md`
- `docs/RADIO-GRID.md`
- `docs/REPO-METADATA.md`
- `docs/ROADMAP-v2.md`
- `docs/WORKSPACE-RECOVERY-LOG.md` (этот файл)
- `docs/adr/0011-pivot-public-ugc-radio.md` … `docs/adr/0021-backend-first-before-apps.md`
- `docs/assets/social-preview.png`
- `docs/assets/social-preview.svg`
- `docs/legal/CONSULTATION-BRIEF.md`

## Проверки и незакрытые гейты

- `npm run test:all` завершился успешно после изменений документации и `.gitignore`: 220 API-тестов, 144 клиентских и 26 скриптовых — всего 390, ошибок нет.
- Ранее проходили `npm run typecheck:api && npm run check:api-types`, `npm run build && npm run build:console`, `npm run test:scripts` и `git diff --check`.
- В среде агента нет Docker/Compose и PowerShell. Реальные PostgreSQL 16, Docker Desktop/WSL2 и Windows 10/11 не проверены; тесты не заменяют эти проверки.
- Ветка не готова к бете: UI v2 не подключён к platform API, загрузка музыки не завершена, правовые и операционные гейты открыты.

## Безопасное продолжение

1. Проверить текущее состояние командой `git status --short --branch` и просмотреть изменения через `git diff`.
2. Сохранять работу в `arena/3e05af70-vision`; `main` не менять.
3. Не запускать `git clean`, массовый reset и удаление untracked-файлов: новые исходники и документы перечислены выше.
4. Не удалять исторические remote refs без отдельного списка разрешённых refs. В [`BRANCH-CLEANUP-AUDIT.md`](BRANCH-CLEANUP-AUDIT.md) указано, что три старых refs требуют отдельной SHA-проверки.
5. Перед будущим commit ещё раз проверить секреты, generated output, тесты и содержимое diff. Коммит и push в этом срезе не выполнялись.
