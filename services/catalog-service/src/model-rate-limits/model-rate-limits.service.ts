import { ForbiddenException, HttpException, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import { createPool } from '../database/pool';
import { ModelsService } from '../models/models.service';
import type { IModel } from '../models/model.types';
import { validateModelId } from '../models/model-validation';
import { canReadCommon } from '../access/access.model';
import { readFeatures } from '../../../shared/feature-client.cjs';
import {
    ModelRateLimitsRepository,
    ratePolicySaveUnconfirmed,
    rateStoreUnavailable,
} from './model-rate-limits.repository';
import { modelRateLimitInput } from './model-rate-limits.validation';
import { modelRateWait } from './model-rate-limits.wait';
import type { ModelRateLimitPolicy, ModelRateLimitView } from './model-rate-limits.types';

/** Catalog-wide policy uses a separate pool so fresh authorization never waits on its own client. */
@Injectable()
export class ModelRateLimitsService implements OnModuleInit, OnApplicationShutdown {
    readonly pool = createPool(
        { connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 3 },
        'model-rate-limits',
    );
    readonly repository = new ModelRateLimitsRepository(this.pool);
    private readonly shutdown = new AbortController();
    constructor(private readonly models: ModelsService) {}
    async onModuleInit(): Promise<void> {
        await this.models.ready();
    }
    async onApplicationShutdown(): Promise<void> {
        this.shutdown.abort();
        await this.pool.end();
    }
    private async authorizeRead(req: Request, id: string): Promise<boolean> {
        const actor = await this.models.actor(req);
        if (!canReadCommon(actor.claims, actor.activeRole))
            throw new ForbiddenException('Настройки общего лимита доступны администраторам.');
        await this.models.getAccessible(id, req);
        return actor.activeRole === 'Главный админ';
    }
    private async featureEnabled(signal?: AbortSignal): Promise<boolean> {
        try {
            return (await readFeatures(process.env, globalThis.fetch, signal)).flags.model_rate_limits;
        } catch {
            signal?.throwIfAborted();
            throw rateStoreUnavailable();
        }
    }
    async read(req: Request, id: string): Promise<ModelRateLimitView> {
        validateModelId(id);
        await this.authorizeRead(req, id);
        let value: ModelRateLimitPolicy;
        try {
            value = await this.repository.read(id);
        } catch {
            throw rateStoreUnavailable();
        }
        const featureEnabled = await this.featureEnabled();
        return { ...value, canManage: await this.authorizeRead(req, id), featureEnabled };
    }
    async save(req: Request, id: string, raw: unknown): Promise<ModelRateLimitView> {
        validateModelId(id);
        const input = modelRateLimitInput(raw),
            actor = await this.models.requireMain(req);
        const authorize = () => this.models.requireMain(req);
        const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(30000)]);
        try {
            for (;;) {
                signal.throwIfAborted();
                const saved = await this.repository.trySave(id, input, actor, authorize, signal);
                if (saved) {
                    await this.models.requireMain(req);
                    return { ...saved, canManage: true, featureEnabled: await this.featureEnabled(signal) };
                }
                await modelRateWait(15, signal);
            }
        } catch (error) {
            if (error instanceof HttpException && error.getStatus() < 500) throw error;
            throw ratePolicySaveUnconfirmed();
        }
    }
    /** A failed/unknown COMMIT consumes no HTTP attempt and is never retried automatically. */
    async acquire(
        model: IModel,
        signal?: AbortSignal,
        beforeAttempt?: () => Promise<boolean | void>,
        onWait?: (ms: number) => void,
    ): Promise<void> {
        validateModelId(model.id);
        const deadline = AbortSignal.timeout(30000),
            combined = AbortSignal.any([this.shutdown.signal, deadline, ...(signal ? [signal] : [])]);
        let retryAfterMs = 1;
        try {
            for (;;) {
                combined.throwIfAborted();
                const result = await this.repository.tryAcquire(model.id, combined, beforeAttempt);
                if (result.admitted) return;
                retryAfterMs = result.retryAfterMs;
                const started = performance.now();
                try {
                    await modelRateWait(Math.min(250, retryAfterMs), combined);
                } finally {
                    onWait?.(Math.max(0, performance.now() - started));
                }
            }
        } catch (error) {
            signal?.throwIfAborted();
            this.shutdown.signal.throwIfAborted();
            if (deadline.aborted)
                throw new HttpException(
                    {
                        statusCode: 429,
                        code: 'MODEL_RATE_WAIT_TIMEOUT',
                        retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)),
                        message:
                            'Модель занята другими запросами. Повторите позже или попросите администратора увеличить лимит модели.',
                    },
                    429,
                );
            if (error instanceof HttpException) throw error;
            throw rateStoreUnavailable();
        }
    }
}
