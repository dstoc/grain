declare module '*.json?raw' {
  const content: string;
  export default content;
}

interface ImportMetaEnv {
  readonly VITE_GRAIN_YJS_M0_PROFILE?: string;
  readonly VITE_GRAIN_YJS_M0_RUN_INDEX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
