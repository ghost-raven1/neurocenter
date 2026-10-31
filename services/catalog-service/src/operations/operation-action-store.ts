import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool, PoolConfig } from 'pg';
import { createPool } from '../database/pool';

/** Session locks and durable action receipts have their own pool; executors retain the models pool. */
export class OperationActionStore implements OnApplicationShutdown {
    private readonly pool: Pool;

    /** The selected database is supplied by DI or the fixture; this owner never reads environment defaults. */
    constructor(config: PoolConfig) {
        if (!config?.connectionString && !(config?.host && config.database && config.user)) {
            throw new Error('Operation action store requires an explicitly selected database.');
        }
        this.pool = createPool({ ...config, max: 5 }, 'operation-actions');
    }

    connect() {
        return this.pool.connect();
    }
    async onApplicationShutdown(): Promise<void> {
        await this.pool.end();
    }
}
