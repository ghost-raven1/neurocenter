import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { FlagsRepository } from './flags.repository';
import type { IEvaluatedFeatureFlags, IFeatureFlag, IFeatureFlagList } from '../../../shared/feature-flags.cjs';
import {evaluateFeatureFlags} from '../../../shared/feature-flags.cjs';

/** Настройки и аудит находятся в каталожной БД и входят в её существующую резервную копию. */
@Injectable()
export class FlagsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(FlagsService.name);
    private readonly pool = new Pool({ connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog',
        max: 3, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000,
        idle_in_transaction_session_timeout: 15000, application_name: 'neurocenter:feature-flags' });
    private readonly repository = new FlagsRepository(this.pool);

    constructor() {
        this.pool.on('error', () => { this.logger.warn('Соединение PostgreSQL прервано; следующий запрос создаст новое.'); });
    }

    async onModuleInit(): Promise<void> {
        try { await this.repository.setup(); }
        catch { throw new Error('Не удалось подготовить хранилище переключателей. Проверьте доступ к PostgreSQL.'); }
    }
    async onModuleDestroy(): Promise<void> { await this.pool.end(); }
    async ready(): Promise<void> { await this.pool.query('SELECT 1'); }
    list(): Promise<IFeatureFlagList> { return this.safe(async () => ({ items: await this.repository.list() })); }
    evaluated(): Promise<IEvaluatedFeatureFlags> { return this.safe(async () => evaluateFeatureFlags(await this.repository.evaluated())); }
    patch(key: unknown, raw: unknown, authorize: () => Promise<string>): Promise<IFeatureFlag> { return this.safe(() => this.repository.patch(key, raw, authorize)); }

    private async safe<T>(action: () => Promise<T>): Promise<T> {
        try { return await action(); }
        catch (error) {
            if (error instanceof HttpException) { throw error; }
            throw new ServiceUnavailableException('Хранилище переключателей временно недоступно. Повторите запрос позже.');
        }
    }
}
