import '../../shared/runtime.cjs';
import { createObservability } from '../../shared/observability.cjs';
import { loadFeatureFlagsConfig } from './config';
import { formatConfigReport } from '../../shared/config.cjs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { AppModule } from './app.module';

/** Переключатели имеют отдельный процесс и не публикуют служебный порт за пределы localhost по умолчанию. */
async function bootstrap(): Promise<void> {
    // AD-9: окружение читается только через config-модуль; fail-fast с агрегированным отчётом.
    const config = loadFeatureFlagsConfig();
    console.log('[feature-flags-service] конфигурация:\n' + formatConfigReport(config.report));
    const app = await NestFactory.create(AppModule, { bodyParser: false });
    app.enableShutdownHooks();
    app.use(createObservability({ service: 'feature-flags-service' }).middleware);
    app.use(express.json({ limit: '2kb' }));
    await app.listen(config.values.port, config.values.bindHost);
    console.log('[feature-flags-service] listening');
}

void bootstrap().catch(() => {
    console.error('Не удалось запустить сервис переключателей функций. Проверьте настройки и доступность БД.');
    process.exitCode = 1;
});
