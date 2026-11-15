# Аудит удалённых Arena-веток — подготовка к Ф0.4

**Дата проверки:** 2026-11-12
**Репозиторий:** `visiontripin/Vision`, default branch `main`.
**Метод:** GitHub API branch list + `gh pr list --state all`.
**Удаление:** не выполнялось; для удаления удалённых refs требуется отдельное явное подтверждение владельца.

## Вывод

GitHub показывает 27 веток: `main` и 26 `arena/*`. Из них `arena/3e05af70-vision` — текущая активная ветка этой сессии, её сохранять. PR #1–#36 в полученном списке имеют состояние `MERGED`; это сильный признак, что прочие refs исторические, но перед удалением нужно сверить head SHA каждого ref с merge SHA/PR и проверить, не используют ли их другие сессии/автоматизация.

| Ветка | Наблюдение по PR | Предложение | Действие |
|---|---|---|---|
| `main` | default branch | сохранить | не трогать |
| `arena/3e05af70-vision` | текущая активная ветка; ещё не оформлена этим отчётом как merged | сохранить | не трогать |
| Остальные 25 `arena/*` refs | PR-история #1–#36 — merged; некоторые refs использовались повторно для нескольких PR | кандидаты на удаление после SHA-проверки | ожидать явного разрешения владельца |

## Исторические ветки-кандидаты (не удалены)

`arena/a12920fb-vision`, `arena/ab9d6f23-vision`, `arena/adb3fbe9-vision`, `arena/b5be37af-vision`, `arena/bcdd253a-vision`, `arena/bedea013-vision`, `arena/f03065b7-vision`, `arena/f4805288-vision`, `arena/f6890820-vision`, `arena/4d247e97-vision`, `arena/5d94b73d-vision`, `arena/7a630afd-vision`, `arena/7d7b19ec-vision`, `arena/9e79898c-vision`, `arena/9efd421e-vision`, `arena/86ecd7a2-vision`, `arena/413ce17e-vision`, `arena/805f64f8-vision`, `arena/899c9cdb-vision`, `arena/2177f3a2-vision`, `arena/3937a6b1-vision`, `arena/8041e970-vision`, `arena/038282b9-vision`, `arena/860365fb-vision`, `arena/51523393-vision`.

## Ограничения

- Эта сессия не удаляет удалённые ветки: удаление необратимо для ссылки и затронет работу других сессий/владельцев.
- Нельзя включать `delete-branch-on-merge` без решения владельца: это затронет будущие PR и активные Arena refs.
- `gh api repos/visiontripin/Vision/branches/main/protection` вернул HTTP 403 `Resource not accessible by integration`; наличие/отсутствие required checks из этого запроса подтвердить нельзя.
- Следующий безопасный шаг после подтверждения: сохранить branch name + SHA snapshot, исключить `main` и `arena/3e05af70-vision`, сверить merged PR head SHA и только затем удалять явно выбранные refs.

## Перепроверка перед уборкой (2026-11-12)

- `git ls-remote --heads origin` снова показал 27 refs: `main`, текущую `arena/3e05af70-vision` и перечисленные выше 25 исторических `arena/*` refs. Локально доступны только `main` и активная ветка; старых remote-tracking refs нет.
- `gh pr list --state all` вернул 36 merged PR и 0 open PR.
- Head SHA текущего remote ref совпадает с head SHA одного из merged PR у 22 кандидатов. У трёх refs SHA не совпадает, поэтому их нельзя считать безопасными для удаления без дополнительного разбора: `arena/805f64f8-vision`, `arena/899c9cdb-vision`, `arena/f03065b7-vision`.
- Удаление не выполнялось. Владелец уточнил: сохранять необходимые исходники и инструкции, вести работу только в активной ветке и фиксировать состояние в отдельном Markdown-файле. Это разрешает уборку рабочей области и документации, но не является командой удалять чужие/исторические remote refs. `main` и `arena/3e05af70-vision` сохраняются; дальнейший учёт изменений — в [`WORKSPACE-RECOVERY-LOG.md`](WORKSPACE-RECOVERY-LOG.md).
