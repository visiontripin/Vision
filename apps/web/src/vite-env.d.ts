/// <reference types="vite/client" />

/** Версия сборки — подставляет Vite при сборке (см. `vite.config.ts`). */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** '1' — локальный режим (IndexedDB, без API) */
  readonly VITE_LOCAL_MODE?: string;
}
