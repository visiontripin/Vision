# Аудит удалённых Arena-веток — подготовка к Ф0.4

**Дата проверки:** 2026-11-12
**Репозиторий:** `visiontripin/Vision`, default branch `main`.
**Метод:** GitHub API branch list + `gh pr list --state all` + compare по SHA.
**Удаление:** по прямому указанию владельца удалены 25 устаревших `arena/*` refs. Оставлены только `main` и активная `arena/3e05af70-vision`.

## Вывод

После очистки GitHub показывает только две ветки: `main` и текущую `arena/3e05af70-vision`. До удаления открытых PR не было, PR #1–#36 имели состояние `MERGED`; все 25 DELETE-запросов к GitHub API завершились успешно. SHA-проверка выявила один дополнительный коммит вне `main` и активной ветки; он сохранён тегом `archive/arena-805f64f8-vision`, не отдельной веткой.

| Ветка / ref | Результат |
|---|---|
| `main` | Сохранена; default branch, SHA `9524489e0ea9dafe439e43cf41f265411e0e7f0b`. |
| `arena/3e05af70-vision` | Сохранена; активная ветка. Удалённый tip — `4bfec8633f987ce65999dabbecbef425d90b47fb`; локальный `HEAD` пока на базовом SHA `9524489e0ea9dafe439e43cf41f265411e0e7f0b`. Перед будущим push нужно сначала сверить/интегрировать удалённый tip, не force-push. |
| 25 остальных `arena/*` refs | Удалены по прямому запросу владельца. |
| `archive/arena-805f64f8-vision` (tag) | Сохраняет единственный найденный уникальный коммит `18049fce631a5c5a207543bd0e067d9a1c43b86d` (release-upload fix) без восстановления ветки. |

## Исторические ветки, удалённые по запросу

`arena/a12920fb-vision`, `arena/ab9d6f23-vision`, `arena/adb3fbe9-vision`, `arena/b5be37af-vision`, `arena/bcdd253a-vision`, `arena/bedea013-vision`, `arena/f03065b7-vision`, `arena/f4805288-vision`, `arena/f6890820-vision`, `arena/4d247e97-vision`, `arena/5d94b73d-vision`, `arena/7a630afd-vision`, `arena/7d7b19ec-vision`, `arena/9e79898c-vision`, `arena/9efd421e-vision`, `arena/86ecd7a2-vision`, `arena/413ce17e-vision`, `arena/805f64f8-vision`, `arena/899c9cdb-vision`, `arena/2177f3a2-vision`, `arena/3937a6b1-vision`, `arena/8041e970-vision`, `arena/038282b9-vision`, `arena/860365fb-vision`, `arena/51523393-vision`.

## Проверка после уборки (2026-11-12)

- GitHub API и `git ls-remote --heads origin` подтвердили: в remote остались только `main` и `arena/3e05af70-vision`; локально также присутствуют только эти две ветки.
- Перед удалением `gh pr list --state all` показал 36 merged PR и 0 open PR; все 25 удаляемых веток были незащищёнными.
- `arena/899c9cdb-vision` и `arena/f03065b7-vision` указывали на коммиты, уже входящие в `main`. `arena/805f64f8-vision` содержала один дополнительный CI-коммит `18049fce631a5c5a207543bd0e067d9a1c43b86d`; он сохранён remote-тегом `archive/arena-805f64f8-vision`, поэтому исходник можно восстановить без отдельной ветки.
- Локальный `HEAD` текущей ветки пока отстаёт от её удалённого tip `4bfec8633f987ce65999dabbecbef425d90b47fb`. Рабочее дерево содержит незакоммиченный WIP; ветку не переключать и не force-push. Перед публикацией текущих изменений сначала требуется сверить этот коммит с локальным WIP.
- `delete-branch-on-merge` не включался.

## Финальная перепроверка после remediation (2026-11-12)

- `git ls-remote --heads origin` (повторно): только `main` (`9524489e0ea9dafe439e43cf41f265411e0e7f0b`) и `arena/3e05af70-vision` (`4bfec8633f987ce65999dabbecbef425d90b47fb`). Других веток нет.
- Архивный тег перепроверен через GitHub API: `refs/tags/archive/arena-805f64f8-vision` → `18049fce631a5c5a207543bd0e067d9a1c43b86d`, `type: commit`. Тег на месте, отдельная ветка не восстанавливалась.
- `gh pr list --state open`: пусто (0 открытых PR).
- Локальный `HEAD` активной ветки — `9524489e0ea9dafe439e43cf41f265411e0e7f0b`; удалённый tip активной ветки — `4bfec8633f987ce65999dabbecbef425d90b47fb`. Незакоммиченный WIP сохранён без reset/force-push/commit/push в этом срезе.
- После remediation повторно прошли: `npm run test:all`, `npm run build`, `npm run build:console`, `npm run check:api-types`, `npm run typecheck:api`, `bash -n scripts/termux-setup.sh`, `git diff --check`.

## Сверка удалённого tip с локальным WIP (2026-11-12)

- `git fetch origin refs/heads/arena/3e05af70-vision`: удалённый tip `4bfec8633f987ce65999dabbecbef425d90b47fb` — 14 коммитов поверх `main` (`9524489e…` — merge-base, предок tip). Коммиты: `fe4a11a` (Android tester), `9e56af4` (ADR-0021 platform), `82f35c4` (merge), 10 CI/MinIO/PostgreSQL-коммитов `2f9ce12…4bfec86` (2026-11-15…16).
- Удалённый tip изменил 176 файлов. Локальный WIP: 91 tracked modified/deleted + 110 untracked = 201 файл.
- Пересечение: 81 tracked (оба изменили) + 95 untracked (add/add) = 176. **Файлов, которые есть только в удалённом tip и отсутствуют локально, нет (0)** — локальный WIP содержит все добавления удалённого tip.
- Из 176 пересекающихся файлов: 116 идентичны (40 tracked + 76 untracked), 60 различаются (41 tracked + 19 untracked). Во всех проверенных различающихся файлах локальная версия — надмножество удалённой: remediation (CSP `frame-ancestors 'self'`, `mediaSecretIsConfigured`, preflight, `engines >=22.16.0`, `*.p12/*.jks/*.keystore` в `.gitignore`, `applyDefaultListenerHost`) + дополнительная платформенная работа (metrics, `platform-local-data`, `checkBucket`, backup/restore). Удалённый tip remediation **не содержит** (`frame-ancestors *`, `engines >=22.5`, без preflight).
- Удаления совпадают: все файлы, удалённые в удалённом tip (Android embedded-server, `docs/EMBEDDED.md`, скрипты), отсутствуют и локально.
- Только локально (нет в удалённом tip): 15 untracked (`runtime-checks.js`, `server-preflight.js`, `startup-config.js`, `platform/metrics.js`, `platform-local-data.mjs`, `platform-sqlite-audit.mjs`, `INTERNAL-ALPHA-PLAN.md`, `PLATFORM-OPERATIONS.md`, ADR-0022, тесты startup/platform) + 10 tracked (`Dockerfile`, `pages.yml`, `lib.ts`/`lib.test.ts` консоли, `CONTENT.md`, `termux-setup.sh`, тесты API).
- Вывод: локальный WIP = удалённый tip + remediation + локальная работа. Публикация возможна fast-forward push после переноса локального `HEAD` на удалённый tip и коммита дельты (60 различающихся + 25 локально-новых файлов). Reset/force-push/commit/push в этом срезе не выполнялись — требуется отдельное подтверждение владельца.

## Интеграция: коммит + merge (2026-11-12)

- По указанию владельца выбран путь «сначала коммит»: WIP закоммичен на текущем `HEAD` как `f02a15c` (201 файл, keystore не затронут), затем выполнен `git merge 4bfec863…`.
- Merge дал 30 конфликтов (12 content + 18 add/add). Во всех случаях локальная версия — более новая (remediation + metrics/backup + ADR-0022), удалённая — устаревшая (CSP `*`, `engines >=22.5`, `node-version: 22`, pre-metrics platform, до-чисточный текст аудита). Все конфликты разрешены в пользу локальной стороны; уникального нового контента в удалённой версии не было. 15 локально-новых файлов сохранены.
- Merge-коммит `b2e65c2`. Удалённый tip — предок `HEAD`, push возможен fast-forward без force. Push в этом срезе не выполнялся.
- После merge повторно прошли: `npm run test:all` (API 273 pass / 6 skipped, local 145, scripts 31), `npm run build`, `npm run build:console`, `npm run typecheck:api`, `npm run check:api-types` (после `npm ci` — `openapi-typescript` отсутствовал в `node_modules`), `bash -n scripts/termux-setup.sh`, `git diff --check`. Сгенерированный `openapi.d.ts` не изменился при регенерации — в синхроне с merged `openapi.js`.
