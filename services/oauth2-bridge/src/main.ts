import '../../shared/runtime.cjs';
import { createObservability } from '../../shared/observability.cjs';
import { createLogger } from '../../shared/logging.cjs';
import { createRequestContextMiddleware } from '../../shared/request-context.cjs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { browserSecurity } from './security/browser-security';

/** AD-O1/O2: единый JSON-логгер и correlation id (до observability — контекст для всех middleware). */
const log = createLogger('oauth2-bridge');

/**
 * Точка входа SSO-моста: bootstrap NestJS + cookie-parser (для OAuth state / session).
 */
async function bootstrap(): Promise<void> {
    // Prod: отключение SSO (mock-пользователь) недопустимо.
    if ((process.env.NODE_ENV || '') === 'production' && process.env.SSO_DISABLE === 'true') {
        log.error('SSO_DISABLE=true запрещён в production — отказ в старте');
        process.exit(1);
    }

    const app = await NestFactory.create(AppModule);
    app.enableShutdownHooks();
    app.use(createRequestContextMiddleware());
    app.use(createObservability({ service: 'oauth2-bridge' }).middleware);
    app.use(browserSecurity);
    app.use(cookieParser());
    const port = process.env.PORT ? Number(process.env.PORT) : 22222;

    await app.listen(port, process.env.BIND_HOST || '127.0.0.1');
    log.info('listening', { port });
}

void bootstrap();
