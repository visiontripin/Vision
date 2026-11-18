# Релизы Vision Audio

Этот документ разделяет существующие исторические артефакты и активные каналы. Направление продукта v2 описано в [`ROADMAP-v2.md`](ROADMAP-v2.md); наличие старого release не означает поддержку платформы или готовность UGC.

## Текущий статус каналов

| Канал | Статус | Заметка |
|---|---|---|
| Web demo / GitHub Pages | Активно | Локальный режим браузера, не публичный музыкальный каталог |
| API / web | Активная база | Приватный одно-владельческий режим; public UGC ещё не запущен |
| Android-плеер | Существующий API-клиент | Функциональное развитие отложено до Ф5; публикация новой версии — только по отдельному решению владельца |
| Windows/Linux desktop | Заморожено по ADR-0016 | Существующие релизы не удаляются; новые builds/releases отключены |
| Console / Vision Server | Workflow временно заморожен; Windows build/install/runtime не проверены; owner requirement unresolved | Релиза нет; не устанавливать неподтверждённый код. Freeze не отменяет отдельное требование владельца — см. [`HOME-SERVER-WINDOWS.md`](HOME-SERVER-WINDOWS.md) |

## Web demo

`.github/workflows/pages.yml` публикует локальную web-сборку из `main`. Демо хранит пользовательские файлы в браузере и не соединено с публичной платформой Vision Audio.

## Android

`.github/workflows/android.yml` сохранён для воспроизводимой сборки текущего API-клиента. Перед любым релизным тегом владелец должен подтвердить, что публикация нужна и соответствует текущему scope. Подробности процесса сборки и подписи — [`ANDROID.md`](ANDROID.md).

## Desktop и Console

`apps/desktop` и `apps/console` не входят в активный roadmap до PMF. Их workflows вручную запускаются только для аудита при явном input и не публикуют Releases. Тег `desktop-v*` или `console-v*` сам по себе не должен выпускать новый артефакт.

`apps/console` включает экспериментальный Windows Server код. Он не прошёл Windows build/install/runtime проверки. Временная заморозка automation конфликтует с отдельным требованием владельца к Windows-службе и установщику; не считайте требование выполненным или отменённым. См. ADR-0016, ADR-0020 и архивную заметку [`HOME-SERVER-WINDOWS.md`](HOME-SERVER-WINDOWS.md); это не инструкция к установке.

## Безопасный порядок релиза активного API/web

1. Проверить продуктовый/legal gate и статус пунктов roadmap.
2. `npm ci`, `npm run test:all`, `npm run typecheck:api`, `npm run check:api-types`, `npm run build`.
3. Обновить `CHANGELOG.md`, документы API и roadmap только после принятия изменения.
4. Проверить CI `test` и `smoke` на PR. Required branch protection не подтверждён — владелец должен настроить его в GitHub Settings, если интеграция имеет нужные права.
5. Публиковать только активные артефакты по отдельному решению; не выпускать frozen desktop/console.

Ранее опубликованные файлы доступны в [GitHub Releases](https://github.com/visiontripin/Vision/releases). Список ссылок и статусы — [`DOWNLOADS.md`](DOWNLOADS.md).
