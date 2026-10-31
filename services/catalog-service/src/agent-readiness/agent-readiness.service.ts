import {
    BadRequestException,
    ConflictException,
    HttpException,
    Injectable,
    OnApplicationShutdown,
    OnModuleInit,
    ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { agentId, object, request, revision } from '../agents/agent-validation';
import { ModelsService } from '../models/models.service';
import { ModelRuntime } from '../models/model-runtime';
import { projectEmbeddingPin } from '../models/project-embedding.validation';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { readFeatures } from '../../../shared/feature-client.cjs';
import { AgentTrialPolicy, agentTrialPin } from './agent-readiness.policy';
import { AgentTrialRepository, trialPending, type TrialRow } from './agent-readiness.repository';
import { AgentTrialRunner, AGENT_TRIAL_FEATURES } from './agent-readiness.runner';
import { startAgentTrial, trialHash } from './agent-readiness.validation';
import type { AgentTrial, AgentTrialOverview, AgentTrialReceipt } from './agent-readiness.types';

/** Private bounded diagnostics: metadata reads and lease recovery never start a model call. */
@Injectable()
export class AgentReadinessService implements OnModuleInit, OnApplicationShutdown {
    readonly policy: AgentTrialPolicy;
    readonly repository: AgentTrialRepository;
    readonly runner: AgentTrialRunner;
    private readonly active = new Map<
        string,
        { abort: AbortController; row: TrialRow; receipt: AgentTrialReceipt; settled: Promise<void> }
    >();
    private timer?: NodeJS.Timeout;
    constructor(
        private readonly models: ModelsService,
        runtime: ModelRuntime,
    ) {
        this.policy = new AgentTrialPolicy(models);
        this.repository = new AgentTrialRepository(models.pool);
        this.runner = new AgentTrialRunner(this.policy, runtime);
    }
    async onModuleInit(): Promise<void> {
        await this.models.ready();
        await this.repository.expire();
        this.timer = setInterval(() => {
            void this.repository.expire().catch(() => undefined);
        }, 10000);
        this.timer.unref();
    }
    async onApplicationShutdown(): Promise<void> {
        clearInterval(this.timer);
        for (const value of this.active.values()) value.abort.abort();
        await Promise.allSettled(
            [...this.active.values()].map((value) =>
                this.repository.stop(
                    value.row.id,
                    value.row.lease_token,
                    'interrupted',
                    value.receipt,
                    'Сервер остановлен. Запустите новое испытание явно.',
                ),
            ),
        );
        await Promise.allSettled([...this.active.values()].map((value) => value.settled));
    }
    async overview(req: Request, projectId: string): Promise<AgentTrialOverview> {
        const actor = await this.policy.actor(req, projectId);
        await this.repository.expire();
        const assignments = await this.policy.agents.assignments(projectId),
            catalog = await this.models.list(req, projectId),
            projectRevision = await this.policy.agents.currentRevision(projectId),
            latest = await this.repository.latest(actor.email, projectId);
        let features: Awaited<ReturnType<typeof readFeatures>>;
        try {
            features = await readFeatures();
        } catch {
            throw new ServiceUnavailableException('Не удалось проверить доступность функций. Повторите позже.');
        }
        const items: AgentTrialOverview['items'] = [];
        for (const assignment of assignments.filter((row) => !row.removed)) {
            const fixed = !!assignment.effective.model,
                models: AgentTrialOverview['items'][number]['eligibility']['models'] = [];
            let reason: string | undefined;
            try {
                await this.policy.assignment(projectId, assignment.agentId);
                for (const choice of catalog.items.filter((model) => catalog.assignedModelIds.includes(model.id))) {
                    try {
                        const selected = await this.policy.model(req, projectId, assignment, choice.id, catalog);
                        models.push({
                            id: selected.id,
                            name: selected.name,
                            pin: projectEmbeddingPin(selected),
                            available: true,
                        });
                    } catch {
                        if (!fixed)
                            models.push({
                                id: choice.id,
                                name: choice.name,
                                pin: projectEmbeddingPin(choice),
                                available: false,
                                reason: 'Нужна доступная проверенная модель диалога.',
                            });
                    }
                }
                if (!models.some((model) => model.available))
                    reason = fixed
                        ? 'Закреплённая модель агента не связана с доступной проверенной моделью проекта.'
                        : 'Добавьте и проверьте модель диалога в проекте.';
            } catch {
                reason = 'Агент больше не доступен для испытания.';
            }
            if (AGENT_TRIAL_FEATURES.some((key) => !features.flags[key]))
                reason = 'Проверка модели или агентов отключена главным администратором.';
            const tool = await this.policy.tool(projectId, assignment);
            if (!features.flags.project_search) {
                tool.available = false;
                tool.reason = 'Поиск по проекту отключён главным администратором.';
            }
            const latestRow = latest.find((row) => row.agent_id === assignment.agentId);
            items.push({
                agentId: assignment.agentId,
                currentPin: agentTrialPin(assignment),
                projectRevision,
                eligibility: {
                    canRun: !reason,
                    ...(reason ? { reason } : {}),
                    modelSelection: fixed ? 'fixed' : 'choose',
                    ...(fixed && models[0] ? { resolvedModelId: models[0].id } : {}),
                    models,
                    tools: [
                        {
                            kind: 'project_search',
                            available: tool.available,
                            requiresConsent: tool.requiresConsent,
                            ...(tool.reason ? { reason: tool.reason } : {}),
                        },
                    ],
                },
                latestTrial: latestRow ? await this.view(req, latestRow) : null,
            });
        }
        await this.policy.actor(req, projectId);
        return { executionSurface: 'server_chat', items };
    }
    async start(req: Request, projectId: string, id: string, raw: unknown): Promise<AgentTrial> {
        agentId(id);
        const input = startAgentTrial(raw),
            actor = await this.policy.actor(req, projectId),
            hash = trialHash({ projectId, agentId: id, input });
        await this.repository.expire();
        const previous = await this.repository.prior(actor.email, input.requestId);
        if (previous) {
            this.same(previous, hash);
            return this.view(req, previous);
        }
        await requireFeaturesEnabled([
            ...AGENT_TRIAL_FEATURES,
            ...(input.tool === 'project_search' ? ['project_search' as const] : []),
        ]);
        const saved = await this.repository.transaction(async (db) => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['agent-trial:' + actor.email]);
            await this.policy.authorize(db, actor, projectId);
            const prior = await this.repository.prior(actor.email, input.requestId, db);
            if (prior) {
                this.same(prior, hash);
                return { row: prior, created: false };
            }
            const set = (
                await db.query<{ revision: number }>(
                    'SELECT revision FROM project_agent_sets WHERE project_id=$1 FOR SHARE',
                    [projectId],
                )
            ).rows[0];
            if (Number(set?.revision ?? 0) !== input.expectedRevision)
                throw new ConflictException('Настройки агентов проекта изменились. Обновите список.');
            const assignment = await this.policy.assignment(projectId, id, db),
                pin = agentTrialPin(assignment);
            if (pin !== input.expectedAgentPin) throw new ConflictException('Промпт или настройки агента изменились.');
            const model = await this.policy.model(req, projectId, assignment, input.modelId, undefined, db);
            if (projectEmbeddingPin(model) !== input.expectedModelPin)
                throw new ConflictException('Модель испытания изменилась.');
            let toolPin: string | null = null;
            if (input.tool === 'project_search') {
                const tool = await this.policy.tool(projectId, assignment, db);
                if (!tool.available || (tool.requiresConsent && !input.toolConsent))
                    throw new ConflictException(
                        tool.reason ?? 'Подтвердите разрешение на чтение проекта для этого испытания.',
                    );
                toolPin = tool.pin;
            }
            const receipt: AgentTrialReceipt = {
                agentVersion: assignment.version,
                agentManifest: assignment.manifest,
                agentPin: pin,
                promptSha256: createHash('sha256').update(assignment.effective.prompt).digest('hex'),
                configSha256: trialHash(assignment.effective),
                modelId: model.id,
                modelName: model.name,
                modelPin: input.expectedModelPin,
                toolMode: input.tool,
                checks: [
                    { kind: 'prompt_sent', status: 'not_run', message: 'Промпт ещё не отправлен модели.' },
                    { kind: 'model_response', status: 'not_run', message: 'Тестовое задание ещё не выполнено.' },
                    ...(input.tool === 'project_search'
                        ? [
                              {
                                  kind: 'project_search' as const,
                                  status: 'not_run' as const,
                                  message: 'Поиск по проекту ещё не выполнен.',
                              },
                          ]
                        : []),
                ],
            };
            const row = await this.repository.insert(db, {
                id: randomUUID(),
                owner: actor.email,
                project: projectId,
                agent: id,
                hash,
                input,
                snapshot: { definition: assignment.effective, agentPin: pin, nonce: randomUUID(), toolPin },
                receipt,
                lease: randomUUID(),
            });
            await this.policy.assertCurrent(req, row, db);
            return { row, created: true };
        });
        if (saved.created) this.launch(req, saved.row);
        return this.view(req, saved.row);
    }
    private same(row: TrialRow, hash: string): void {
        if (row.request_hash !== hash)
            throw new ConflictException('Этот ключ запроса уже использован для другого испытания.');
    }
    async read(req: Request, project: string, agent: string, id: string): Promise<AgentTrial> {
        agentId(agent);
        request(id);
        const actor = await this.policy.actor(req, project);
        await this.repository.expire();
        return this.view(req, await this.repository.owned(actor.email, project, agent, id));
    }
    async cancel(req: Request, project: string, agent: string, id: string, raw: unknown): Promise<AgentTrial> {
        agentId(agent);
        request(id);
        const input = object(raw, ['expectedRevision']);
        revision(input.expectedRevision);
        const actor = await this.policy.actor(req, project);
        await this.repository.expire();
        const row = await this.repository.transaction(async (db) => {
            const current = await this.repository.owned(actor.email, project, agent, id, db, true);
            await this.policy.authorize(db, actor, project);
            if (current.revision !== input.expectedRevision)
                throw new ConflictException('Состояние испытания изменилось. Обновите результат.');
            return trialPending(current)
                ? this.repository.save(db, current, 'cancelled', current.receipt, 'Испытание отменено пользователем.')
                : current;
        });
        this.active.get(id)?.abort.abort();
        return this.view(req, row);
    }
    private launch(req: Request, row: TrialRow): void {
        const abort = new AbortController(),
            receipt = structuredClone(row.receipt),
            value = { abort, row, receipt, settled: Promise.resolve() };
        this.active.set(row.id, value);
        value.settled = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
            const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(90000)]);
            try {
                const checkpoint = (next: AgentTrialReceipt) =>
                    this.repository.transaction(async (db) => {
                        signal.throwIfAborted();
                        const current = await this.repository.owned(
                            row.owner_email,
                            row.project_id,
                            row.agent_id,
                            row.id,
                            db,
                            true,
                        );
                        if (!trialPending(current) || current.lease_token !== row.lease_token)
                            throw new ConflictException('Испытание остановлено.');
                        const model = await this.policy.assertCurrent(req, current, db);
                        value.row = await this.repository.save(
                            db,
                            current,
                            'running',
                            next,
                            'Выполняется тестовое задание.',
                        );
                        signal.throwIfAborted();
                        return model;
                    });
                await this.runner.run(req, row, receipt, signal, checkpoint);
                await this.repository.transaction(async (db) => {
                    signal.throwIfAborted();
                    const current = await this.repository.owned(
                        row.owner_email,
                        row.project_id,
                        row.agent_id,
                        row.id,
                        db,
                        true,
                    );
                    await this.policy.assertCurrent(req, current, db);
                    signal.throwIfAborted();
                    await this.repository.save(
                        db,
                        current,
                        'succeeded',
                        receipt,
                        'Тестовое задание выполнено в чате Нейроцентра.',
                    );
                });
            } catch (error) {
                const cancelled = abort.signal.aborted,
                    timeout = !cancelled && signal.aborted;
                if (!cancelled && receipt.checks[1].status !== 'passed')
                    receipt.checks[1] = {
                        kind: 'model_response',
                        status: 'failed',
                        message: 'Выполнение тестового задания не подтверждено.',
                    };
                const safe =
                    error instanceof BadRequestException || error instanceof ConflictException
                        ? error.message
                        : 'Модель не выполнила испытание. Проверьте подключение и запустите новый тест.';
                await this.repository
                    .stop(
                        row.id,
                        row.lease_token,
                        cancelled ? 'cancelled' : timeout ? 'interrupted' : 'failed',
                        receipt,
                        cancelled
                            ? 'Испытание отменено.'
                            : timeout
                              ? 'Время испытания истекло. Запустите новый тест явно.'
                              : safe,
                    )
                    .catch(() => undefined);
            } finally {
                this.active.delete(row.id);
            }
        });
    }
    private async view(req: Request, row: TrialRow): Promise<AgentTrial> {
        let current = true;
        try {
            await this.repository.transaction((db) => this.policy.assertCurrent(req, row, db));
        } catch (error) {
            if (!(error instanceof HttpException)) throw error;
            current = false;
        }
        await this.policy.actor(req, row.project_id);
        return {
            id: row.id,
            requestId: row.request_id,
            revision: row.revision,
            executionSurface: 'server_chat',
            status: row.status,
            message: row.message,
            createdAt: new Date(row.created_at).toISOString(),
            finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
            current,
            ...(!current
                ? { staleReason: 'Промпт, модель, разрешения или выбранный индекс изменились после этого испытания.' }
                : {}),
            canCancel: trialPending(row) && !!row.lease_until && new Date(row.lease_until).getTime() > Date.now(),
            receipt: row.receipt,
        };
    }
}
