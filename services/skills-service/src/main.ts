import '../../shared/runtime.cjs';
import { createObservability } from '../../shared/observability.cjs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';

import { AppModule } from './app.module';

/**
 * Точка входа skills-service (порт по умолчанию 4200).
 */
async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(AppModule, { bodyParser: false });

    app.enableShutdownHooks();

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

    const port = process.env.PORT ? Number(process.env.PORT) : 4200;

    await app.listen(port, process.env.BIND_HOST || '127.0.0.1');

    console.log(`[skills-service] listening on :${port}`);
}

void bootstrap();
