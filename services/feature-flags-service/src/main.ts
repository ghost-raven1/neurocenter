import '../../shared/runtime.cjs';
import { createObservability, recordErrorEvent } from '../../shared/observability.cjs';
import { installCrashHandler } from '../../shared/crash-handler.cjs';
import { ErrorOutbox, deliverErrorEvents } from '../../shared/error-outbox.cjs';
import os from 'node:os';
import path from 'node:path';
import { loadFeatureFlagsConfig } from './config';
import { formatConfigReport } from '../../shared/config.cjs';
import { createLogger } from '../../shared/logging.cjs';
import { createRequestContextMiddleware } from '../../shared/request-context.cjs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { AppModule } from './app.module';

/** AD-O1/O2: единый JSON-логгер и correlation id (до observability — контекст для всех middleware). */
const log = createLogger('feature-flags-service');

/**
 * AD-O5 (res-obs 6.10): crash-политика. Сервис без прямого PG: crash-событие
 * в file outbox, фоновая доставка в catalog POST /internal/error-events.
 */
const errorOutbox = new ErrorOutbox(
    process.env.ERROR_OUTBOX_PATH
        ? path.resolve(process.env.ERROR_OUTBOX_PATH)
        : path.join(os.tmpdir(), 'neurocenter', 'error-outbox', 'feature-flags-service'),
    deliverErrorEvents,
    { logger: log },
);
void errorOutbox.start().catch(() => {
    log.warn('Error outbox: не удалось запустить фоновую доставку в каталог.');
});
installCrashHandler({
    service: 'feature-flags-service',
    log,
    reportError: (event) => errorOutbox.append([event]),
    record: (level) => recordErrorEvent('feature-flags-service', level),
});
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        void errorOutbox.stop().catch(() => undefined);
    });
}

/** Переключатели имеют отдельный процесс и не публикуют служебный порт за пределы localhost по умолчанию. */
async function bootstrap(): Promise<void> {
    // AD-9: окружение читается только через config-модуль; fail-fast с агрегированным отчётом.
    const config = loadFeatureFlagsConfig();
    log.info('configuration', { report: formatConfigReport(config.report) });
    const app = await NestFactory.create(AppModule, { bodyParser: false });
    app.enableShutdownHooks();
    app.use(createRequestContextMiddleware());
    app.use(createObservability({ service: 'feature-flags-service' }).middleware);
    app.use(express.json({ limit: '2kb' }));
    await app.listen(config.values.port, config.values.bindHost);
    log.info('listening');
}

void bootstrap().catch((error: unknown) => {
    log.error('Не удалось запустить сервис переключателей функций. Проверьте настройки и доступность БД.', { err: error });
    process.exitCode = 1;
});
