import { discussionAttachmentUploadRoute } from '../../shared/discussion-attachment-route.cjs';
import { snapshotContentRoute } from '../../shared/snapshot-content-route.cjs';
import { sourceUploadContentRoute } from '../../shared/source-upload-route.cjs';
import { ggufImportContentRoute } from '../../shared/gguf-import-route.cjs';
import { ggufRequestTimeouts } from '../../shared/gguf-request-timeout.cjs';
import { assetSourceArchiveRoute } from '../../shared/asset-source-archive-route.cjs';
import '../../shared/runtime.cjs';
import { createObservability } from '../../shared/observability.cjs';
import { loadCatalogConfig } from './config';
import { formatConfigReport } from '../../shared/config.cjs';
import { assertServiceVolumes } from '../../shared/volume-ownership.cjs';
import { createLogger } from '../../shared/logging.cjs';
import { createRequestContextMiddleware } from '../../shared/request-context.cjs';import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';

import { AppModule } from './app.module';

/** AD-O1/O2: единый JSON-логгер и correlation id (до observability — контекст для всех middleware). */
const log = createLogger('catalog-service');

/**
 * Точка входа каталожного microservice.
 */
async function bootstrap(): Promise<void> {
    // AD-9: окружение читается только через config-модуль; fail-fast с агрегированным отчётом.
    const config = loadCatalogConfig();
    log.info('configuration', { report: formatConfigReport(config.report) });
    // AD-OP-6 (OQ-2): fail-closed проверка владельцев writable-томов (production-only).
    assertServiceVolumes('catalog-service', [
        process.env.PROJECTS_ROOT || '/data/projects',
        process.env.BACKUP_DIR || '/app/backups',
        process.env.RUNTIME_ARTIFACT_DIR || '/app/runtime-artifacts',
        process.env.MODEL_STORAGE_PATH,
    ]);
    const app = await NestFactory.create(AppModule, { bodyParser: false });
    app.enableShutdownHooks();
    app.use(ggufRequestTimeouts(app.getHttpServer()));
    app.use(createRequestContextMiddleware());
    app.use(createObservability({ service: 'catalog-service' }).middleware);
    // Body-бюджет выравнивает цепь nginx 50m → gateway 50mb → catalog 50mb (entry 9, OQ2):
    // 40MB-запрос проходит всю цепь, а не умирает 413'ом глубоко в catalog (бывший 35mb).
    const jsonParser = express.json({ limit: '50mb' });
    app.use((req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
        if (
            ggufImportContentRoute(req.method, req.path) ||
            discussionAttachmentUploadRoute(req.method, req.path) ||
            sourceUploadContentRoute(req.method, req.path) ||
            snapshotContentRoute(req.method, req.path) ||
            assetSourceArchiveRoute(req.method, req.path)
        ) {
            next();
            return;
        }
        jsonParser(req, res, next);
    });
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
    const port = config.values.port;

    await app.listen(port, config.values.bindHost);
    log.info('listening', { port });
}

void bootstrap();
