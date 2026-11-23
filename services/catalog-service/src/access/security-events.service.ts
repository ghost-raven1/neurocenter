import { ensureCatalogSchema } from '../database/catalog-schema';
import { createPool } from '../database/pool';
import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { securityEvent, type ISecurityEvent } from './security-events';

/**
 * P0-RES/AD-O7: приём security-событий от писателей без прямого PG (oauth2-bridge, api-gateway).
 * Доставка — file outbox писателя; идемпотентность — уникальный event_id (ON CONFLICT DO NOTHING).
 */
@Injectable()
export class SecurityEventsService implements OnModuleInit, OnModuleDestroy {
    readonly pool = createPool(
        { connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 3 },
        'security-events',
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

    /** Пакет событий из outbox: одна транзакция; повторная доставка не дублирует (event_id). */
    async record(events: ISecurityEvent[]): Promise<{ received: number }> {
        if (!Array.isArray(events) || !events.length || events.length > 200) {
            throw new BadRequestException('Ожидается пакет из 1..200 security-событий.');
        }
        for (const event of events) {
            if (
                !event ||
                typeof event !== 'object' ||
                typeof event.actor !== 'string' ||
                !event.actor ||
                typeof event.action !== 'string' ||
                !event.action ||
                typeof event.resourceId !== 'string' ||
                !event.resourceId
            ) {
                throw new BadRequestException('Каждое событие требует actor, action и resourceId.');
            }
            if (event.eventId !== undefined && typeof event.eventId !== 'string') {
                throw new BadRequestException('eventId должен быть строкой (UUID).');
            }
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            for (const event of events) {
                await securityEvent(client, event);
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
}
