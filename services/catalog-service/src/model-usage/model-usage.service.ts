import {requireFeaturesEnabled} from '../features/require-feature-enabled';
import { BadRequestException, ForbiddenException, Injectable, OnApplicationShutdown, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { createPool } from '../database/pool';
import { projectLevel } from '../access/access.model';
import { ModelsService } from '../models/models.service';
import type { IModel } from '../models/model.types';
import { chatUsage } from '../model-chat/chat-context';
import { currentModelUsage, MODEL_USAGE_PURPOSES } from './model-usage.context';
import { ModelUsageRepository } from './model-usage.repository';
import { MODEL_USAGE_STATUSES, type ModelUsageQuery, type ModelUsageRecorder, type ModelUsageResult, type UsageFilter, type UsageScope, type UsageTerminal } from './model-usage.types';

/** A pending receipt precedes paid work; failed terminal write-back never repeats a completed provider call. */
@Injectable()
export class ModelUsageService implements ModelUsageRecorder, OnModuleInit, OnApplicationShutdown {
    readonly pool = createPool({ connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 5 }, 'model-usage');
    readonly repository = new ModelUsageRepository(this.pool);
    readonly workerId = randomUUID();
    private readonly shutdown = new AbortController();
    private readonly active = new Map<string, Promise<unknown>>();
    private readonly writebacks = new Map<string, UsageTerminal>();
    private timer?: NodeJS.Timeout;
    private maintenance?: Promise<void>;
    constructor(private readonly models: ModelsService) {}
    async onModuleInit(): Promise<void> {
        await this.models.ready(); await this.repository.recover();
        this.timer = setInterval(() => { if (!this.maintenance) this.maintenance = this.maintain().catch(() => undefined).finally(() => { this.maintenance = undefined; }); }, 30000); this.timer.unref();
    }
    async onApplicationShutdown(): Promise<void> {
        this.shutdown.abort(); if (this.timer) clearInterval(this.timer); await this.maintenance;
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([Promise.allSettled([...this.active.values()]), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); }
        finally { if (timer) clearTimeout(timer); }
        await this.flush().catch(() => undefined); await this.repository.interrupt(this.workerId).catch(() => undefined); await this.pool.end();
    }
    private async flush(): Promise<void> { for (const [id, value] of this.writebacks) { await this.repository.finish(id, this.workerId, value); if (this.writebacks.get(id) === value) this.writebacks.delete(id); } }
    private async maintain(): Promise<void> { await this.flush(); await this.repository.renew(this.workerId); await this.repository.recover(); }
    async observe(model: IModel, endpoint: 'chat' | 'embed', action: (signal: AbortSignal) => Promise<Record<string, unknown>>, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const combined = AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : [])]); combined.throwIfAborted();
        const context = currentModelUsage(), id = randomUUID();
        try { await this.repository.begin({ ...context, id, workerId: this.workerId, model, endpoint }); }
        catch { throw new ServiceUnavailableException('Журнал использования моделей недоступен. Запрос к провайдеру не отправлен; повторите позже.'); }
        const started = performance.now(); let terminal: UsageTerminal = { status: 'error', inputTokens: null, outputTokens: null, latencyMs: 0 };
        const operation = (async () => {
            try {
                combined.throwIfAborted(); const result = await action(combined), usage = chatUsage(result);
                terminal = { status: combined.aborted ? 'cancelled' : 'success', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs: 0 };
                combined.throwIfAborted(); return result;
            } catch (error) { terminal.status = combined.aborted ? 'cancelled' : 'error'; throw error; }
            finally {
                terminal.latencyMs = Math.min(2147483647, Math.max(0, Math.round(performance.now() - started)));
                try { await this.repository.finish(id, this.workerId, terminal); }
                catch { this.writebacks.set(id, terminal); }
            }
        })();
        this.active.set(id, operation);
        try { return await operation; } finally { this.active.delete(id); }
    }
    private filter(query: ModelUsageQuery): UsageFilter {
        if (Object.keys(query).some(key => !['days', 'projectId', 'modelId', 'purpose', 'status', 'cursor', 'limit'].includes(key))) throw new BadRequestException('Неизвестный фильтр использования моделей.');
        const days = query.days === undefined ? 7 : Number(query.days), limit = query.limit === undefined ? 50 : Number(query.limit);
        if (![1, 7, 30].includes(days) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('Период: 1, 7 или 30 дней; страница: до 100 вызовов.');
        const filter: UsageFilter = { days, limit };
        for (const key of ['projectId', 'modelId'] as const) if (query[key] !== undefined) { if (typeof query[key] !== 'string' || !query[key] || query[key]!.length > 256 || /[\x00-\x1f\x7f]/.test(query[key]!)) throw new BadRequestException('Некорректный идентификатор фильтра.'); filter[key] = query[key]; }
        if (query.purpose !== undefined) { if (!MODEL_USAGE_PURPOSES.includes(query.purpose as never)) throw new BadRequestException('Неизвестное назначение вызова.'); filter.purpose = query.purpose as UsageFilter['purpose']; }
        if (query.status !== undefined) { if (!MODEL_USAGE_STATUSES.includes(query.status as never)) throw new BadRequestException('Неизвестное состояние вызова.'); filter.status = query.status as UsageFilter['status']; }
        if (query.cursor !== undefined) {
            try { if (typeof query.cursor !== 'string' || query.cursor.length > 512) throw new Error(); const value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
                if (!value || Object.keys(value).sort().join(',') !== 'id,startedAt' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.id) || typeof value.startedAt !== 'string'
                    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(value.startedAt) || !Number.isFinite(new Date(value.startedAt).getTime())) throw new Error(); filter.cursor = value;
            } catch { throw new BadRequestException('Некорректная страница журнала.'); }
        }
        return filter;
    }
    async report(req: Request, query: ModelUsageQuery): Promise<ModelUsageResult> {
        if (req.headers['x-neurocenter-device-id']) throw new ForbiddenException('Журнал доступен пользователю в интерфейсе.');
        const actor = await this.models.actor(req), filter = this.filter(query); await requireFeaturesEnabled(['model_usage']);
        if (!['Главный админ', 'Админ проекта', 'Разработчик'].includes(actor.activeRole)) throw new ForbiddenException('Для просмотра журнала нужна рабочая роль.');
        const scope: UsageScope = { all: actor.activeRole === 'Главный админ', actor: actor.activeRole === 'Разработчик' ? actor.email : null,
            projectIds: actor.claims.projects.filter(project => projectLevel(actor.claims, actor.activeRole, project.projectId) >= (actor.activeRole === 'Админ проекта' ? 3 : 2)).map(project => project.projectId) };
        if (filter.projectId) filter.projectId = (await this.models.resolveProject(req, filter.projectId, actor.activeRole === 'Админ проекта' ? 3 : 2, actor)).id;
        const result = await this.repository.report(scope, filter), current = await this.models.actor(req);
        if (current.email !== actor.email || current.activeRole !== actor.activeRole || JSON.stringify(current.claims.projects) !== JSON.stringify(actor.claims.projects)) throw new ForbiddenException('Права изменились. Обновите журнал.');
        const to = new Date(), from = new Date(to.getTime() - filter.days * 86400000);
        return { window: { days: filter.days, from: from.toISOString(), to: to.toISOString() }, summary: result.summary, byModel: result.byModel, byPurpose: result.byPurpose, items: result.items,
            history: { hasMore: result.hasMore, nextCursor: result.hasMore && result.cursor ? Buffer.from(JSON.stringify(result.cursor)).toString('base64url') : null } };
    }
}
