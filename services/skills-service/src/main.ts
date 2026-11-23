import '../../shared/runtime.cjs';
import { createObservability } from '../../shared/observability.cjs';
import { loadSkillsConfig } from './config';
import { formatConfigReport } from '../../shared/config.cjs';
import { assertServiceVolumes } from '../../shared/volume-ownership.cjs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';

import { AppModule } from './app.module';

/**
 * Точка входа skills-service (порт по умолчанию 4200).
 */
async function bootstrap(): Promise<void> {
    // AD-9: окружение читается только через config-модуль; fail-fast с агрегированным отчётом.
    const config = loadSkillsConfig();
    console.log('[skills-service] конфигурация:\n' + formatConfigReport(config.report));
    // AD-OP-6 (OQ-2): fail-closed проверка владельца тома скиллов (production-only).
    assertServiceVolumes('skills-service', [process.env.SKILLS_STORAGE_PATH || '/app/data/skills']);
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

    const port = config.values.port;

    await app.listen(port, config.values.bindHost);

    console.log(`[skills-service] listening on :${port}`);
}

void bootstrap();
