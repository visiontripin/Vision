# Безопасность Vision Audio

## Статус

Vision Audio — личный проект в разработке. **Публичной беты нет**, регистрации
и приём музыки закрыты, пользовательские данные в репозитории отсутствуют
(см. [`docs/DEVELOPMENT-ROADMAP.md`](docs/DEVELOPMENT-ROADMAP.md), раздел
«Beta go/no-go»). Материал ниже — действующие правила, а не заявление о
готовности к продакшену.

## Как сообщить об уязвимости

- Используйте **GitHub Security Advisories** (приватный канал):
  https://github.com/visiontripin/Vision/security/advisories/new
- Не публикуйте детали в открытых issues и обсуждениях.
- Опишите: затронутый контур (legacy-плеер / платформа v2), шаги
  воспроизведения, влияние. Ответ — в рамках доступного владельцу времени.

## Правила для контрибьюторов и агентов

- Секреты, `.env*`, токены, пароли и PII — никогда в Git
  ([`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md), «Секреты и артефакты»).
- `apps/mobile/vision-release.p12` — tracked-файл подписи: не удалять и не
  ротировать без отдельного решения владельца (`docs/ANDROID.md`).
- Legacy API по умолчанию слушает `0.0.0.0` и использует известный пароль —
  **не выставляйте его в интернет/домашнюю сеть**; инструкции только в
  [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
- Локальный контур v2 — только loopback по
  [`docs/BETA-WINDOWS-LOCAL.md`](docs/BETA-WINDOWS-LOCAL.md); регистрация в
  нём выключена.
- Приватные/чужие аудиофайлы и материалы участников не загружать в тестовые
  среды, Pages-демо и репозиторий.

## Что сделано технически (legacy-контур)

- Токен — HMAC-SHA256, только в `Authorization: Bearer`; для `<audio>`/`<img>` —
  короткоживущие подписанные URL с TTL.
- Загрузки проверяются по magic bytes; имена файлов на диске — UUID;
  path traversal исключён префиксной проверкой.
- Rate limit на вход; комментарии и приватные ссылки с ограниченным сроком
  жизни (`docs/adr/0007-private-links.md`).
- Контракт и границы — [`docs/API.md`](docs/API.md); эксплуатация и бэкапы —
  [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Платформа v2

Контур в разработке: playback-сессии подписаны, rate-limit и fail-closed
moderation/rights реализованы и покрыты тестами; приёмка безопасности входит в
Stack Ready gate ([`docs/PLATFORM-REHEARSAL.md`](docs/PLATFORM-REHEARSAL.md),
[`docs/adr/0021-backend-first-before-apps.md`](docs/adr/0021-backend-first-before-apps.md)).
**Техническая реализация не разрешает публичный запуск** — внешние legal/privacy
гейты остаются открытыми.
