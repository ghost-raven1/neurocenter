/// <reference types="vite/client" />

declare global {
    interface ImportMetaEnv {
        readonly VITE_API_BASE_URL?: string;
        readonly VITE_BLITZ_LOGIN_URL?: string;
    }

    interface ImportMeta {
        readonly env: ImportMetaEnv;
    }
}

export {};
