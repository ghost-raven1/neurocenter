import '../../shared/runtime.cjs';
import { createObservability, recordErrorEvent } from '../../shared/observability.cjs';
import { installCrashHandler } from '../../shared/crash-handler.cjs';
import { ErrorOutbox, deliverErrorEvents } from '../../shared/error-outbox.cjs';
import os from 'node:os';
import path from 'node:path';
import { loadOauth2BridgeConfig } from './config';
import { formatConfigReport } from '../../shared/config.cjs';
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
 * AD-O5 (res-obs 6.10): crash-политика. Мост без прямого PG: crash-событие
 * в file outbox, фоновая доставка в catalog POST /internal/error-events.
 */
const errorOutbox = new ErrorOutbox(
    process.env.ERROR_OUTBOX_PATH
        ? path.resolve(process.env.ERROR_OUTBOX_PATH)
        : path.join(os.tmpdir(), 'neurocenter', 'error-outbox', 'oauth2-bridge'),
    deliverErrorEvents,
    { logger: log },
);
void errorOutbox.start().catch(() => {
    log.warn('Error outbox: не удалось запустить фоновую доставку в каталог.');
});
installCrashHandler({
    service: 'oauth2-bridge',
    log,
    reportError: (event) => errorOutbox.append([event]),
    record: (level) => recordErrorEvent('oauth2-bridge', level),
});
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        void errorOutbox.stop().catch(() => undefined);
    });
}

/**
 * Точка входа SSO-моста: bootstrap NestJS + cookie-parser (для OAuth state / session).
 */
async function bootstrap(): Promise<void> {
    // AD-9: окружение читается только через config-модуль; fail-fast с агрегированным отчётом.
    const config = loadOauth2BridgeConfig();
    log.info('configuration', { report: formatConfigReport(config.report) });
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
    const port = config.values.port;

    await app.listen(port, config.values.bindHost);
    log.info('listening', { port });
}

void bootstrap();
