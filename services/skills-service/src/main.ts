import '../../shared/runtime.cjs';
import { createObservability, recordErrorEvent } from '../../shared/observability.cjs';
import { installCrashHandler } from '../../shared/crash-handler.cjs';
import { ErrorOutbox, deliverErrorEvents } from '../../shared/error-outbox.cjs';
import os from 'node:os';
import path from 'node:path';
import { loadSkillsConfig } from './config';
import { formatConfigReport } from '../../shared/config.cjs';
import { assertServiceVolumes } from '../../shared/volume-ownership.cjs';
import { createLogger } from '../../shared/logging.cjs';
import { createRequestContextMiddleware } from '../../shared/request-context.cjs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';

import { AppModule } from './app.module';

/** AD-O1/O2: единый JSON-логгер и correlation id (до observability — контекст для всех middleware). */
const log = createLogger('skills-service');

/**
 * AD-O5 (res-obs 6.10): crash-политика. Сервис без прямого PG: crash-событие
 * в file outbox, фоновая доставка в catalog POST /internal/error-events.
 */
const errorOutbox = new ErrorOutbox(
    process.env.ERROR_OUTBOX_PATH
        ? path.resolve(process.env.ERROR_OUTBOX_PATH)
        : path.join(os.tmpdir(), 'neurocenter', 'error-outbox', 'skills-service'),
    deliverErrorEvents,
    { logger: log },
);
void errorOutbox.start().catch(() => {
    log.warn('Error outbox: не удалось запустить фоновую доставку в каталог.');
});
installCrashHandler({
    service: 'skills-service',
    log,
    reportError: (event) => errorOutbox.append([event]),
    record: (level) => recordErrorEvent('skills-service', level),
});
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        void errorOutbox.stop().catch(() => undefined);
    });
}

/**
 * Точка входа skills-service (порт по умолчанию 4200).
 */
async function bootstrap(): Promise<void> {
    // AD-9: окружение читается только через config-модуль; fail-fast с агрегированным отчётом.
    const config = loadSkillsConfig();
    log.info('configuration', { report: formatConfigReport(config.report) });
    // AD-OP-6 (OQ-2): fail-closed проверка владельца тома скиллов (production-only).
    assertServiceVolumes('skills-service', [process.env.SKILLS_STORAGE_PATH || '/app/data/skills']);
    const app = await NestFactory.create(AppModule, { bodyParser: false });

    app.enableShutdownHooks();

    app.use(createRequestContextMiddleware());
    app.use(createObservability({ service: 'skills-service' }).middleware);

    app.use((req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
        if (
            req.path.startsWith('/api/') &&
            (!process.env.NEUROCENTER_INTERNAL_TOKEN ||
                req.headers['x-neurocenter-internal'] !== process.env.NEUROCENTER_INTERNAL_TOKEN)
        ) {
            res.status(403).json({ message: 'Запрос должен пройти через авторизованный шлюз.' });
            return;
        }
        next();
    });

    app.use(express.json({ limit: '50mb' }));

    const port = config.values.port;

    await app.listen(port, config.values.bindHost);

    log.info('listening', { port });
}

void bootstrap();
