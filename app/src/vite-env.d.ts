/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STANDBY_API_BASE_URL?: string;
  readonly VITE_STANDBY_DEMO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
