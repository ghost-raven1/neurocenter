import '../../shared/runtime.cjs';
import { createObservability } from '../../shared/observability.cjs';
import { loadOauth2BridgeConfig } from './config';
import { formatConfigReport } from '../../shared/config.cjs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { browserSecurity } from './security/browser-security';

/**
 * Точка входа SSO-моста: bootstrap NestJS + cookie-parser (для OAuth state / session).
 */
async function bootstrap(): Promise<void> {
    // AD-9: окружение читается только через config-модуль; fail-fast с агрегированным отчётом.
    const config = loadOauth2BridgeConfig();
    console.log('[oauth2-bridge] конфигурация:\n' + formatConfigReport(config.report));
    // Prod: отключение SSO (mock-пользователь) недопустимо.
    if ((process.env.NODE_ENV || '') === 'production' && process.env.SSO_DISABLE === 'true') {
        console.error('[oauth2-bridge] SSO_DISABLE=true запрещён в production — отказ в старте');
        process.exit(1);
    }

    const app = await NestFactory.create(AppModule);
    app.enableShutdownHooks();
    app.use(createObservability({ service: 'oauth2-bridge' }).middleware);
    app.use(browserSecurity);
    app.use(cookieParser());
    const port = config.values.port;

    await app.listen(port, config.values.bindHost);
    console.log(`[oauth2-bridge] listening on :${port}`);
}

void bootstrap();
