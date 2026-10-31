import '../../shared/runtime.cjs';
import { createObservability } from '../../shared/observability.cjs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { browserSecurity } from './security/browser-security';

/**
 * Точка входа SSO-моста: bootstrap NestJS + cookie-parser (для OAuth state / session).
 */
async function bootstrap(): Promise<void> {
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
    const port = process.env.PORT ? Number(process.env.PORT) : 22222;

    await app.listen(port, process.env.BIND_HOST || '127.0.0.1');
    console.log(`[oauth2-bridge] listening on :${port}`);
}

void bootstrap();
