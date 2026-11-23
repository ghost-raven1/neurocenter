import { ensureCatalogSchema } from '../database/catalog-schema';
import { createPool } from '../database/pool';
import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { insertErrorEvent, listErrorEvents, type IErrorEvent, type IErrorEventQuery, type IErrorEventRow } from './error-events';
import type { IPage } from '../catalog/dto';

/**
 * AD-O5 (res-obs 6.10): приём error-событий из outbox писателей (POST /internal/error-events)
 * и чтение для админа (GET /api/errors). Свой пул (max 3) — как у security-events:
 * запись не конкурирует за соединения основного каталога.
 */
@Injectable()
export class ErrorEventsService implements OnModuleInit, OnModuleDestroy {
    readonly pool = createPool(
        { connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 3 },
        'error-events',
    );
    private initialization?: Promise<void>;
    ready(): Promise<void> {
        return (this.initialization ??= this.initialize());
    }
    async onModuleInit(): Promise<void> {
        await this.ready();
    }
    private async initialize(): Promise<void> {
        await ensureCatalogSchema(this.pool);
    }
    async onModuleDestroy(): Promise<void> {
        await this.pool.end();
    }

    /** Пакет событий из outbox: одна транзакция; повторная доставка не дублирует (id). */
    async record(events: IErrorEvent[]): Promise<{ received: number }> {
        if (!Array.isArray(events) || !events.length || events.length > 200) {
            throw new BadRequestException('Ожидается пакет из 1..200 error-событий.');
        }
        for (const event of events) {
            if (
                !event ||
                typeof event !== 'object' ||
                typeof event.service !== 'string' ||
                !event.service ||
                (event.level !== 'error' && event.level !== 'critical') ||
                typeof event.message !== 'string' ||
                !event.message
            ) {
                throw new BadRequestException('Каждое событие требует service, level (error|critical) и message.');
            }
            if (event.id !== undefined && typeof event.id !== 'string') {
                throw new BadRequestException('id должен быть строкой (UUID).');
            }
            if (event.requestId !== undefined && event.requestId !== null && typeof event.requestId !== 'string') {
                throw new BadRequestException('requestId должен быть строкой.');
            }
            if (
                event.stackHint !== undefined &&
                event.stackHint !== null &&
                (typeof event.stackHint !== 'string' || Buffer.byteLength(event.stackHint, 'utf8') > 4096)
            ) {
                throw new BadRequestException('stackHint — строка не длиннее 4 КБ (кадры + имена, без значений).');
            }
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            for (const event of events) {
                await insertErrorEvent(client, event);
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
        return { received: events.length };
    }

    /** Страница для админа (GET /api/errors). */
    list(query: IErrorEventQuery): Promise<IPage<IErrorEventRow>> {
        return listErrorEvents(this.pool, query);
    }
}
