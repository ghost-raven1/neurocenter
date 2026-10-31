import '../../shared/runtime.cjs';
import { createObservability } from '../../shared/observability.cjs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { AppModule } from './app.module';

/** Переключатели имеют отдельный процесс и не публикуют служебный порт за пределы localhost по умолчанию. */
async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(AppModule, { bodyParser: false });
    app.enableShutdownHooks();
    app.use(createObservability({ service: 'feature-flags-service' }).middleware);
    app.use(express.json({ limit: '2kb' }));
    await app.listen(process.env.PORT ? Number(process.env.PORT) : 4400, process.env.BIND_HOST || '127.0.0.1');
    console.log('[feature-flags-service] listening');
}

void bootstrap().catch(() => {
    console.error('Не удалось запустить сервис переключателей функций. Проверьте настройки и доступность БД.');
    process.exitCode = 1;
});
