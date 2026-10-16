/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module '*.sql?raw' {
  const source: string;
  export default source;
}

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}
