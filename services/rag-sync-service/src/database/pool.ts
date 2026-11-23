import { Pool, type ClientBase, type PoolConfig } from 'pg';
import { createLogger } from '../../../shared/logging.cjs';

/** Логирует разрыв; запросы, отмена и освобождение клиента остаются у владельца. */
export function observeClientErrors(client: ClientBase, scope: string): void {
    const logger = createLogger('rag-sync-service').child({ scope });
    client.on('error', (error) => {
        logger.warn('Соединение PostgreSQL прервано', { err: error });
    });
}

/** Постоянный обработчик защищает и выданные клиенту соединения, пока pg снимает свой idle-listener. */
export function createPool(config: PoolConfig, scope: string): Pool {
    return (
        new Pool({ connectionTimeoutMillis: 5000, ...config, application_name: 'neurocenter:' + scope })
            .on('connect', (client) => observeClientErrors(client, scope))
            // Разрыв уже записан клиентом; pg сам удаляет повреждённое idle-соединение.
            .on('error', () => undefined)
    );
}
