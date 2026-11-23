import '../../shared/runtime.cjs';
import { createObservability } from '../../shared/observability.cjs';
import { createLogger } from '../../shared/logging.cjs';
import { createRequestContextMiddleware } from '../../shared/request-context.cjs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import * as express from 'express';

import { AppModule } from './app.module';

/** AD-O1/O2: единый JSON-логгер и correlation id (до observability — контекст для всех middleware). */
const log = createLogger('rag-sync-service');

/**
 * Точка входа rag-sync-service (порт по умолчанию 4300).
 * Body-лимит поднят (~20mb): sync-батчи несут векторы выбранной проектом размерности.
 */
async function bootstrap(): Promise<void> {
    // Prod: отключение role-gate недопустимо (прямой доступ к сервису = обход авторизации).
    if ((process.env.NODE_ENV || '') === 'production' && process.env.RAG_AUTH_DISABLED === 'true') {
        log.error('RAG_AUTH_DISABLED=true запрещён в production — отказ в старте');
        process.exit(1);
    }

    const app = await NestFactory.create(AppModule, { bodyParser: false });
    app.enableShutdownHooks();
    app.use(createRequestContextMiddleware());
    app.use(createObservability({ service: 'rag-sync-service' }).middleware);
    app.use((req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
        if (
            (req.path.startsWith('/api/') || req.path.startsWith('/internal/')) &&
            (!process.env.NEUROCENTER_INTERNAL_TOKEN ||
                req.headers['x-neurocenter-internal'] !== process.env.NEUROCENTER_INTERNAL_TOKEN)
        ) {
            res.status(403).json({ message: 'Запрос должен пройти через авторизованный шлюз.' });
            return;
        }
        next();
    });
    app.use(express.json({ limit: '20mb' }));
    const port = process.env.PORT ? Number(process.env.PORT) : 4300;

    await app.listen(port, process.env.BIND_HOST || '127.0.0.1');
    log.info('listening', { port });
}

void bootstrap();
