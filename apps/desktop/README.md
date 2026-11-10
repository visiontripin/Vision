# Vision Audio — Windows и Linux

Версия оболочки — **0.2.0** (трей, сворачивание в трей, медиа-клавиши, мост
`media:*` ↔ плеер).

Tauri 2: Rust-оболочка + тот же web-бандл (`apps/web/dist`). Установщик ~6–12 МБ
вместо ~100 МБ у Electron, доступ к трею, глобальным клавишам и автообновлению.

## Требования

- Rust (stable) и Cargo — https://rustup.rs
- Linux: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`
- Windows: WebView2 (ставится автоматически) + MSVC Build Tools

> Сборка проверяется в CI: `.github/workflows/desktop.yml` собирает `.deb` и
> `.AppImage` на `ubuntu-22.04` при каждом PR с изменениями `apps/desktop`,
> `apps/web` или `packages/shared`. Артефакт — `vision-desktop-linux`, по тегу
> `desktop-v*` он же уезжает в GitHub Release.

## Запуск

```bash
# из корня: соберёт web и поднимет Tauri с Vite
npm --prefix apps/desktop install
npm --prefix apps/desktop run dev
```

API должен быть доступен по `http://localhost:4000` (или укажите свой сервер на экране входа).
Vite проксирует `/api` на API во время разработки; в production-сборке адрес API
задаётся на экране входа и хранится в localStorage.

## Сборка

```bash
npm --prefix apps/desktop run build:windows   # .msi + .exe (NSIS)
npm --prefix apps/desktop run build:linux     # .AppImage + .deb
```

## Реализованные нативные интеграции

- **системный трей**: «Играть/Пауза», «Предыдущий», «Следующий», «Показать окно»,
  «Выход»; tooltip показывает текущий трек (`apps/desktop/src-tauri/src/main.rs`);
- **сворачивание в трей**: закрытие окна не выходит из приложения — выход только
  через меню трея, так что музыка не обрывается на «крестике»;
- **глобальные медиа-клавиши** `Ctrl+Alt+Space` / `Ctrl+Alt+←/→` → события `media:*`;
- **мост в фронтенд** (`apps/web/src/desktop.ts`): `listenDesktop` подписывается на
  команды трея и клавиш, `publishDesktopState` отправляет в трей название/артиста и
  состояние «играет» (команда `player_state`); в браузере мост молчит;
- окно с drag&drop файлов (drop открывает загрузку в web-интерфейсе);
- автообновление через `tauri-plugin-updater` (endpoint задаётся в `tauri.conf.json`);
- CSP ограничивает `connect-src`/`media-src` только своим API.

Подробности и CI — `docs/DESKTOP.md`.

## Иконки

`src-tauri/icons/icon.png` — 512×512. Пересобрать полный набор (ico/icns/png) можно так:

```bash
npm --prefix apps/desktop run icon
```

## Дальше по плану

- Windows-джоба в CI (`.msi`/NSIS) и подпись установщиков Authenticode;
- локальный сид: приложение включает встроенный сервер (`STORAGE_MODE=metadata`,
  `SEED_ENABLED=1`) и раздаёт скачанные файлы — тогда десктоп становится полноценным
  узлом реплик, а не только клиентом;
- автозапуск при входе в систему;
- офлайн-кэш библиотеки на диске и работа без сервера.
