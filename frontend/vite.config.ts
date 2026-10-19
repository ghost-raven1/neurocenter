import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Локальная разработка, два бэкенда:
 *   - /auth          → oauth2-bridge (SSO/Blitz login), default :22222 (VITE_AUTH_PROXY_TARGET)
 *   - /api, /socket.io → api-gateway (BFF/realtime), default :4000 (VITE_API_PROXY_TARGET)
 *
 * changeOrigin + secure:false + cookieDomainRewrite передают SSO-cookie
 * локальному клиенту через dev-прокси.
 */
const DEFAULT_AUTH_PROXY_TARGET = 'http://localhost:22222';
const DEFAULT_API_PROXY_TARGET = 'http://localhost:4000';

/**
 * Vite-конфиг (function-форма, чтобы прочитать переменные окружения через loadEnv).
 *
 * @param {import('vite').ConfigEnv} configEnv - режим запуска
 * @returns {import('vite').UserConfig}
 */
export default defineConfig((configEnv) => {
    const env = { ...process.env, ...loadEnv(configEnv.mode, process.cwd(), '') };
    const authTarget = env.VITE_AUTH_PROXY_TARGET || DEFAULT_AUTH_PROXY_TARGET;
    const apiTarget = env.VITE_API_PROXY_TARGET || DEFAULT_API_PROXY_TARGET;

    const shared = {
        changeOrigin: true,
        xfwd: true,
        secure: false,
        cookieDomainRewrite: {},
    };

    return {
        plugins: [react()],
        css: {
            preprocessorOptions: {
                less: {
                    javascriptEnabled: true,
                    additionalData: `@import (reference) "${fileURLToPath(new URL('./src/common/styles/brand.less', import.meta.url)).replace(/\\/g, '/')}";`,
                    modifyVars: {
                        'primary-color': '@brand-primary',
                        'primary-color-hover': '@brand-hover',
                        'primary-color-active': '@brand-active',
                        'primary-1': '@brand-tint',
                        'primary-2': '@brand-tint-2',
                        'primary-3': '@brand-tint-3',
                        'primary-4': '@brand-border-hover',
                        'primary-5': '@brand-hover',
                        'info-color': '@brand-primary',
                        'info-color-deprecated-bg': '@brand-tint',
                        'info-color-deprecated-border': '@brand-border',
                        'alert-info-bg-color': '@brand-tint',
                        'alert-info-border-color': '@brand-border',
                        'alert-info-icon-color': '@brand-primary',
                        'link-color': '@brand-primary',
                        'link-hover-color': '@brand-hover',
                        'link-active-color': '@brand-active',
                        'border-radius-base': '8px',
                        'text-color': '#24344a',
                        'heading-color': '#14283d',
                        'border-color-base': '#d8e1e8',
                    },
                },
            },
        },
        server: {
            host: '127.0.0.1',
            port: 5173,
            // Dev сохраняет inline-пролог React Refresh; production CSP задаётся в nginx.conf.
            headers: {
                'X-Content-Type-Options':'nosniff',
                'X-Frame-Options':'DENY',
                'Referrer-Policy':'no-referrer',
                'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
            },
            proxy: {
                '/auth': { ...shared, target: authTarget },
                '/api': { ...shared, target: apiTarget },
                '/socket.io': { ...shared, target: apiTarget, ws: true },
            },
        },
        build: { outDir: 'dist', sourcemap: false },
    };
});
