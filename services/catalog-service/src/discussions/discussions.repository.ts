import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../database/pool';
import { ensureCatalogSchema } from '../database/catalog-schema';

/** Owned transactions discard a session whenever rollback acknowledgement is uncertain. */
@Injectable()
export class DiscussionsRepository implements OnModuleInit, OnModuleDestroy {
    readonly pool: Pool = createPool(
        { connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 3 },
        'discussions',
    );
    async onModuleInit() {
        await ensureCatalogSchema(this.pool);
    }
    async onModuleDestroy() {
        await this.pool.end();
    }
    async transaction<T>(run: (db: PoolClient) => Promise<T>): Promise<T> {
        const db = await this.pool.connect();
        let discard = false;
        try {
            await db.query('BEGIN');
            await db.query("SET LOCAL lock_timeout='5s'");
            const result = await run(db);
            await db.query('COMMIT');
            return result;
        } catch (error) {
            try {
                await db.query('ROLLBACK');
            } catch {
                discard = true;
            }
            throw error;
        } finally {
            db.release(discard);
        }
    }
}
