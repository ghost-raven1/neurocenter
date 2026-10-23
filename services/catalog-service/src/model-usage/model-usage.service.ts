import {requireFeaturesEnabled} from '../features/require-feature-enabled';
import { ForbiddenException, Injectable, OnApplicationShutdown, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { createPool } from '../database/pool';
import { projectLevel } from '../access/access.model';
import { ModelsService } from '../models/models.service';
import type { IModel } from '../models/model.types';
import { chatUsage } from '../model-chat/chat-context';
import { currentModelUsage } from './model-usage.context';
import { ModelUsageRepository } from './model-usage.repository';
import {modelUsageFilter} from './model-usage.query';
import {createModelDispatchMetrics,withModelDispatchMetrics} from './model-dispatch-metrics';
import { type ModelUsageQuery, type ModelUsageRecorder, type ModelUsageResult, type UsageScope, type UsageTerminal } from './model-usage.types';

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
        const metrics = createModelDispatchMetrics(), started = performance.now(); let terminal: UsageTerminal = { status: 'error', inputTokens: null, outputTokens: null, latencyMs: 0 };
        const operation = withModelDispatchMetrics(metrics, async () => {
            try {
                combined.throwIfAborted(); const result = await action(combined), usage = chatUsage(result);
                terminal = { status: combined.aborted ? 'cancelled' : 'success', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs: 0 };
                combined.throwIfAborted(); return result;
            } catch (error) {
                terminal.status = combined.aborted ? 'cancelled' : 'error';
                const response = error && typeof error === 'object' && 'getResponse' in error && typeof error.getResponse === 'function' ? error.getResponse() : undefined;
                const code = response && typeof response === 'object' && 'code' in response ? String(response.code) : '';
                const status = error && typeof error === 'object' && 'getStatus' in error && typeof error.getStatus === 'function' ? error.getStatus() : undefined;
                terminal.failureCode = combined.aborted ? 'cancelled' : code === 'MODEL_RATE_WAIT_TIMEOUT' ? 'rate_wait_timeout' : code === 'MODEL_RATE_STORE_UNAVAILABLE' ? 'rate_store_unavailable'
                    : ['FEATURE_DISABLED', 'feature-disabled'].includes(code) ? 'feature_disabled' : status === 403 || status === 401 ? 'permission_denied' : metrics.dispatchCount > 0 ? 'provider_error' : 'internal_error';
                throw error;
            }
            finally {
                Object.assign(terminal, {dispatchCount: metrics.dispatchCount, dispatchedAt: metrics.dispatchedAt, rateWaitMs: Math.round(metrics.rateWaitMs),
                    providerLatencyMs: metrics.dispatchCount ? Math.round(metrics.providerLatencyMs) : null});
                terminal.latencyMs = Math.min(2147483647, Math.max(0, Math.round(performance.now() - started)));
                try { await this.repository.finish(id, this.workerId, terminal); }
                catch { this.writebacks.set(id, terminal); }
            }
        });
        this.active.set(id, operation);
        try { return await operation; } finally { this.active.delete(id); }
    }
    async report(req: Request, query: ModelUsageQuery): Promise<ModelUsageResult> {
        if (req.headers['x-neurocenter-device-id']) throw new ForbiddenException('Журнал доступен пользователю в интерфейсе.');
        const actor = await this.models.actor(req), filter = modelUsageFilter(query); await requireFeaturesEnabled(['model_usage']);
        if (!['Главный админ', 'Админ проекта', 'Разработчик'].includes(actor.activeRole)) throw new ForbiddenException('Для просмотра журнала нужна рабочая роль.');
        const scope: UsageScope = { all: actor.activeRole === 'Главный админ', actor: actor.activeRole === 'Разработчик' ? actor.email : null,
            projectIds: actor.claims.projects.filter(project => projectLevel(actor.claims, actor.activeRole, project.projectId) >= (actor.activeRole === 'Админ проекта' ? 3 : 2)).map(project => project.projectId) };
        if (filter.projectId) {
            if (scope.all) filter.projectId = await this.repository.canonicalProject(filter.projectId);
            else {
                const project = actor.claims.projects.find(item => item.projectId === filter.projectId || !filter.projectId!.startsWith('prj-') && item.projectName === filter.projectId);
                if (!project || !scope.projectIds.includes(project.projectId)) throw new ForbiddenException('Нет доступа к журналу выбранного проекта.');
                filter.projectId = project.projectId;
            }
        }
        if (scope.actor && filter.actorEmail !== undefined && filter.actorEmail !== scope.actor) throw new ForbiddenException('Можно просматривать только собственные операции.');
        const result = await this.repository.report(scope, filter), current = await this.models.actor(req);
        if (current.email !== actor.email || current.activeRole !== actor.activeRole || JSON.stringify(current.claims.projects) !== JSON.stringify(actor.claims.projects)) throw new ForbiddenException('Права изменились. Обновите журнал.');
        const to = new Date(result.windowTo), from = new Date(to.getTime() - filter.days * 86400000);
        return { scope: {kind: scope.all ? 'all' : scope.actor ? 'self' : 'projects', actorEmail: scope.actor, projectIds: scope.projectIds},
            facets: result.facets, byActor: result.byActor, byProject: result.byProject, byEndpoint: result.byEndpoint, byAgent: result.byAgent, series: result.series,
            window: { days: filter.days, from: from.toISOString(), to: to.toISOString() }, summary: result.summary, byModel: result.byModel, byPurpose: result.byPurpose, items: result.items,
            history: { hasMore: result.hasMore, nextCursor: result.hasMore && result.cursor ? Buffer.from(JSON.stringify(result.cursor)).toString('base64url') : null } };
    }
}
