import '../../shared/runtime.cjs';
import { createObservability } from '../../shared/observability.cjs';
import { createLogger } from '../../shared/logging.cjs';
import { createRequestContextMiddleware } from '../../shared/request-context.cjs';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { AppModule } from './app.module';

/** AD-O1/O2: единый JSON-логгер и correlation id (до observability — контекст для всех middleware). */
const log = createLogger('feature-flags-service');

/** Переключатели имеют отдельный процесс и не публикуют служебный порт за пределы localhost по умолчанию. */
async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(AppModule, { bodyParser: false });
    app.enableShutdownHooks();
    app.use(createRequestContextMiddleware());
    app.use(createObservability({ service: 'feature-flags-service' }).middleware);
    app.use(express.json({ limit: '2kb' }));
    await app.listen(process.env.PORT ? Number(process.env.PORT) : 4400, process.env.BIND_HOST || '127.0.0.1');
    log.info('listening');
}

void bootstrap().catch((error: unknown) => {
    log.error('Не удалось запустить сервис переключателей функций. Проверьте настройки и доступность БД.', { err: error });
    process.exitCode = 1;
});
