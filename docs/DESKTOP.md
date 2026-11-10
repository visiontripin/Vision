# Десктоп: Windows и Linux (Tauri 2)

Приложение — это тот же web-бандл (`apps/web/dist`), завёрнутый в Rust-оболочку
Tauri 2. Установщик ~6–12 МБ вместо ~100 МБ у Electron: системный WebView вместо
своего браузера, нативные трей, меню и глобальные клавиши.

**Статус v0.2.0.** Собирается в CI (`.github/workflows/desktop.yml` → `.deb` и
`.AppImage`), умеет трей, сворачивание в трей и медиа-клавиши. Windows-джоба и
подпись установщиков — следующий шаг.

## Что внутри

```
apps/desktop/
  package.json                 скрипты сборки и @tauri-apps/cli
  src-tauri/
    Cargo.toml                 tauri, plugin-global-shortcut, plugin-updater
    tauri.conf.json            окно, CSP, бандлы (msi, nsis, deb, appimage)
    capabilities/default.json  минимальные разрешения (core, shortcuts, updater)
    src/main.rs                трей, медиа-клавиши, «свернуть в трей», команда player_state
apps/web/src/desktop.ts        мост: слушаем media:*, отправляем player_state
apps/web/src/components/DesktopBridge.tsx  связка моста с плеером
```

### Трей

Пункты: «Играть/Пауза», «Предыдущий», «Следующий», «Показать окно», «Выход».
Клик левой кнопкой по иконке показывает окно; tooltip — `Vision Audio · <трек> — <артист>`.
Подпись пункта «Играть/Пауза» меняется по состоянию плеера.

### Сворачивание в трей

Закрытие окна перехватывается (`WindowEvent::CloseRequested` → `api.prevent_close()`
+ `window.hide()`): приложение продолжает играть, пока его не закроют из меню трея.
Это ожидаемое поведение для музыкального плеера, но требует привычки: «Выход» — в трее.

### Медиа-клавиши и мост в фронтенд

| Источник | Событие | Что делает фронтенд |
| --- | --- | --- |
| `Ctrl+Alt+Space` | `media:play-pause` | `player.toggle()` |
| `Ctrl+Alt+→` | `media:next` | `player.next()` |
| `Ctrl+Alt+←` | `media:prev` | `player.prev()` |
| пункты трея | те же события | то же |
| плеер | `invoke('player_state', { playing, title, artist })` | подпись и tooltip трея |

`apps/web/src/desktop.ts` — единственное место, где фронтенд знает про Tauri:
`isDesktop()` проверяет `window.__TAURI_INTERNALS__`, поэтому в браузере и на
GitHub Pages мост выключен, а `@tauri-apps/api` подгружается динамическим импортом
(в основном бандле его нет).

## Сборка

```bash
npm ci                                   # зависимости репозитория
npm --prefix apps/desktop install        # tauri CLI
npm --prefix apps/desktop run build:linux    # .deb + .AppImage
npm --prefix apps/desktop run build:windows  # .msi + NSIS (на Windows)
```

`beforeBuildCommand` собирает web (`npm --prefix ../web run build`), `frontendDist`
указывает на `apps/web/dist` — отдельной сборки фронтенда не нужно.

### CI

`.github/workflows/desktop.yml`:

- запускается на PR с изменениями `apps/desktop`, `apps/web`, `packages/shared`,
  по тегу `desktop-v*` и вручную;
- `ubuntu-22.04` + WebKitGTK 4.1 + `libayatana-appindicator3-dev` (трей) и Rust stable
  с кэшем (`Swatinem/rust-cache`);
- если компиляция падает, ошибки `error[E…]` вытаскиваются в аннотации run-а —
  так их видно без скачивания логов;
- артефакт `vision-desktop-linux` (`.deb`, `.AppImage`), по тегу — GitHub Release
  `desktop-v<версия>`.

Релиз:

```bash
git tag desktop-v0.2.0 && git push origin desktop-v0.2.0
```

## Ограничения

- **Linux**: нужен `libwebkit2gtk-4.1` (Ubuntu 22.04+), в `.deb` зависимость прописана.
- **Windows**: WebView2 ставится bootstrapper-ом, установщики — `msi`/`nsis`.
- **macOS** пока не собирается: нет Apple-подписи, код общий — джоба добавляется
  вместе с сертификатом.
- **Подпись**: Linux не требует, Windows Authenticode требует сертификат — пока
  установщик неподписанный (SmartScreen предупредит).
- Приложение — **клиент**: сервер (API + трекер реплик) остаётся отдельным
  процессом. Встроенный сид — следующий шаг (`apps/desktop/README.md`).

## Что дальше

- Windows-джоба CI и подпись;
- встроенный сервер (`STORAGE_MODE=metadata`, `SEED_ENABLED=1`) — десктоп как узел
  реплик, а не только клиент;
- автозапуск при входе в систему;
- офлайн-кэш библиотеки на диске.
