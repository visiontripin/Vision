# ADR 0004 — React Native + Tauri для нативных приложений

**Контекст.** Нужны Android, iOS, Windows, Linux. Команда маленькая, язык один — TypeScript.

**Варианты.** Flutter (Dart, отдельный стек) · React Native + Electron (тяжёлый десктоп) ·
React Native + Tauri (один TS-стек, лёгкие установщики) · нативные Kotlin/Swift/C# (дорого).

**Решение.** Android/iOS — React Native (Expo). Windows/Linux — Tauri 2, переиспользует
web-бандл. Общий контракт — `packages/shared`.

**Последствия.** Один клиент API и один набор типов на пять платформ. Плата: RN-специфичные
модули для фонового аудио, отсутствие Rust-тулчейна в CI до этапа 3, ограничения WebView
(нет эксклюзивного аудио-вывода, но он и не нужен).
