# Vision Audio — Windows и Linux

Tauri 2: Rust-оболочка + тот же web-бандл (`apps/web/dist`). Установщик ~6–12 МБ
вместо ~100 МБ у Electron, доступ к трею, глобальным клавишам и автообновлению.

## Требования

- Rust (stable) и Cargo — https://rustup.rs
- Linux: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`
- Windows: WebView2 (ставится автоматически) + MSVC Build Tools

> В текущем sandbox Rust не установлен, поэтому сборка здесь не выполнялась —
> проверяйте локально или в CI (`docs/ROADMAP.md`, этап 3).

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

- окно с drag&drop файлов (drop открывает загрузку в web-интерфейсе);
- глобальные медиа-клавиши `Ctrl+Alt+Space` / `Ctrl+Alt+←/→` → события `media:*` во фронтенд;
- автообновление через `tauri-plugin-updater` (endpoint задаётся в `tauri.conf.json`);
- CSP ограничивает `connect-src`/`media-src` только своим API.

## Иконки

`src-tauri/icons/icon.png` — 512×512. Пересобрать полный набор (ico/icns/png) можно так:

```bash
npm --prefix apps/desktop run icon
```

## Дальше по плану (этап 3)

- трей с управлением воспроизведением;
- локальный кэш библиотеки (SQLite) и офлайн-режим;
- автозапуск и «свернуть в трей при закрытии»;
- подпись установщиков (Windows Authenticode, Linux — не требуется) и CI-релизы.
