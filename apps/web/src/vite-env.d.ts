/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' — локальный режим (IndexedDB, без API) */
  readonly VITE_LOCAL_MODE?: string;
}
