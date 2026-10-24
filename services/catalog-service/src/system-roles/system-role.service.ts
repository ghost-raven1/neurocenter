import { ConflictException, Injectable, NotFoundException, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import { AgentsService } from '../agents/agents.service';
import { CatalogService } from '../catalog/catalog.service';
import { ModelsService } from '../models/models.service';
import { ModelRuntime } from '../models/model-runtime';
import { RemoteConnectionService } from '../models/remote-connection.service';
import { ProjectChatService } from '../project-chat/project-chat.service';
import { projectLevel } from '../access/access.model';
import type { IModelActor } from '../models/model-access';
import { projectEmbeddingPin } from '../models/project-embedding.validation';
import { listTargets } from '../catalog-requests/request.targets';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { ROLE_BUDGET, SYSTEM_ROLE_DEFINITIONS, roleDefinitionPin, roleHash, systemRole } from './system-role.definitions';
import { SystemRoleRepository, type RoleExecutionLane } from './system-role.repository';
import { SystemRolePolicy } from './system-role.policy';
import { SystemRoleTargets } from './system-role.targets';
import { SystemRoleRunner } from './system-role.runner';
import { SystemRoleApplication } from './system-role.apply';
import { notifyRoleOperations } from './system-role.operations';
import { roleAction, roleRequestId, roleSelection, startRoleRun } from './system-role.validation';
import type { RoleRunRow, RoleRunView, SystemRoleId } from './system-role.types';

/** Builtins share a durable owner, with one active request per transport. Restart never replays paid work. */
@Injectable()
export class SystemRoleService implements OnModuleInit, OnApplicationShutdown {
    readonly repository: SystemRoleRepository;
    readonly policy: SystemRolePolicy;
    readonly targets: SystemRoleTargets;
    private readonly runner: SystemRoleRunner;
    private readonly application: SystemRoleApplication;
    private readonly active = new Map<string, AbortController>();
    private readonly lanes = new Set<RoleExecutionLane>();
    private readonly tasks = new Set<Promise<void>>();
    private timer?: ReturnType<typeof setInterval>;
    private drainTask?: Promise<void>;
    private draining = false;
    private wakeAgain = false;
    private stopped = false;
    constructor(private readonly models: ModelsService, agents: AgentsService, catalog: CatalogService, connections: RemoteConnectionService, runtime: ModelRuntime, chats: ProjectChatService) {
        this.repository = new SystemRoleRepository(models.pool); this.policy = new SystemRolePolicy(models);
        this.targets = new SystemRoleTargets(this.policy, agents, catalog, connections, globalThis.fetch, chats);
        this.runner = new SystemRoleRunner(this.repository, this.policy, this.targets, runtime, () => models.ready());
        this.application = new SystemRoleApplication(this.repository, this.policy, this.targets);
    }
    async onModuleInit(): Promise<void> {
        await this.models.ready(); await this.repository.expire();
        this.timer = setInterval(() => { void this.repository.expire().then(() => this.wake()).catch(() => undefined); }, 5000);
        this.timer.unref();
    }
    async onApplicationShutdown(): Promise<void> {
        this.stopped = true; if (this.timer) clearInterval(this.timer);
        for (const controller of this.active.values()) controller.abort(new Error('System role runner stopped.'));
        await this.drainTask;
        await Promise.allSettled([...this.tasks]); // At most one tracked task per transport.
    }
    private role(id: string): SystemRoleId { return systemRole(id).id; }
    private project(value?: string): string | null {
        if (value === undefined || value === '') return null;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new ConflictException('Выберите точный ID проекта.'); return value;
    }
    async overview(req: Request, projectId?: string) {
        await this.models.ready(); const project = this.project(projectId), actor = await this.policy.actor(req, project);
        const availableModels = (await this.models.list(req, actor.activeRole === 'Главный админ' ? undefined : project ?? undefined)).items;
        const models = availableModels
            .filter(model => !model.archivedAt && ['chat', 'vision'].includes(model.capability) && (model.runtime === 'ollama' ? model.manifestSha256 : model.verificationSha256))
            .map(model => ({ id: model.id, name: model.name, pin: projectEmbeddingPin(model) }));
        const targets: Array<{ kind: string; id: string; name: string }> = [];
        const agentList = await this.targets.agentChoices(req, project);
        targets.push(...agentList);
        try { targets.push(...await this.targets.publicChatChoices(req, project)); } catch { /* Unavailable chat history is not an automatic context grant. */ }
        for (const type of ['skill', 'plugin'] as const) {
            try { targets.push(...(await listTargets(this.models.pool, actor, type, project)).map(item => ({ kind: type === 'plugin' ? 'plugin-settings' : type, id: item.id, name: item.name }))); }
            catch { /* Optional catalog outage must not hide diagnostics or previously accepted runs. */ }
        }
        if (actor.activeRole === 'Главный админ') targets.push(...availableModels.filter(model => model.runtime === 'remote-openai' || model.runtime === 'remote-ollama').map(model => ({ kind: 'adapter', id: model.id, name: model.name })));
        return { definitions: SYSTEM_ROLE_DEFINITIONS.map(({ prompt: _prompt, ...definition }) => ({ ...definition, definitionPin: roleDefinitionPin(definition.id) })),
            budget: ROLE_BUDGET, models, targets, projectId: project };
    }
    async prepare(req: Request, agentId: string, raw: unknown) {
        const id = this.role(agentId), selection = roleSelection(id, raw); await this.policy.actor(req, selection.projectId);
        await requireFeaturesEnabled([systemRole(id).flag]);
        const prepared = await this.targets.prepare(req, id, selection);
        return { preview: prepared.preview, consentDigest: prepared.consentDigest, definitionPin: prepared.definitionPin,
            targets: prepared.targets.map(({ key, kind, id, version, editable }) => ({ key, kind, id, version, editable })) };
    }
    async start(req: Request, agentId: string, raw: unknown): Promise<RoleRunView> {
        const id = this.role(agentId), input = startRoleRun(id, raw), actor = await this.policy.actor(req, input.projectId), requestHash = roleHash({ id, input });
        const old = await this.repository.existing(actor.email, input.requestId);
        if (old) {
            if (old.request_hash !== requestHash) throw new ConflictException('Ключ запроса относится к другому запуску.');
            await this.policy.read(req, old); return this.view(old);
        }
        await requireFeaturesEnabled([systemRole(id).flag, ...(input.sourceFeature ? [input.sourceFeature] : [])]);
        const snapshot = await this.targets.prepare(req, id, input), model = await this.policy.model(req, input.modelId, input.projectId, input.expectedModelPin);
        if (snapshot.definitionPin !== input.expectedDefinitionPin || snapshot.consentDigest !== input.consentDigest) throw new ConflictException('Контекст изменился. Подготовьте и подтвердите его заново.');
        if (Buffer.byteLength(JSON.stringify(snapshot)) > 524288 || Buffer.byteLength(JSON.stringify(input)) > 131072) throw new ConflictException('Уменьшите выбранный контекст.');
        const row = await this.repository.create({ agent_id: id, project_id: input.projectId, actor: actor.email, actor_role: actor.activeRole,
            request_id: input.requestId, request_hash: requestHash, request: input, snapshot, model }, async db => {
            await this.policy.authorize(db, actor, input.projectId);
            await this.policy.source(db, actor.email, id, input, requestHash);
            await this.policy.modelInTransaction(db, actor, input.projectId, input.modelId, input.expectedModelPin);
        });
        void notifyRoleOperations(); this.wake(); return this.view(row);
    }
    async list(req: Request, agentId: string, projectId?: string): Promise<RoleRunView[]> {
        const id = this.role(agentId), project = this.project(projectId), actor = await this.policy.actor(req, project, 1);
        return (await this.repository.list(actor.email, id, project)).map(row => this.view(row, actor));
    }
    async detail(req: Request, agentId: string, runId: string): Promise<RoleRunView> {
        const row = await this.owned(req, agentId, runId); return this.view(row, await this.policy.read(req, row));
    }
    async request(req: Request, agentId: string, requestId: string, expectedHash?: string): Promise<RoleRunView> {
        const id = this.role(agentId), actor = await this.models.actor(req), row = await this.repository.existing(actor.email, roleRequestId(requestId));
        if (!row || row.agent_id !== id) throw new NotFoundException('Сохранённый запрос не найден.');
        if (expectedHash !== undefined && (!/^[a-f0-9]{64}$/.test(expectedHash) || row.request_hash !== expectedHash)) throw new ConflictException('Ключ запроса относится к другому запуску.');
        return this.view(row, await this.policy.read(req, row));
    }
    private async owned(req: Request, agentId: string, runId: string): Promise<RoleRunRow> {
        const id = this.role(agentId), row = await this.repository.get(roleRequestId(runId));
        if (!row || row.agent_id !== id) throw new NotFoundException('Запуск системного агента не найден.');
        await this.policy.read(req, row); return row;
    }
    async cancel(req: Request, agentId: string, runId: string, raw: unknown): Promise<RoleRunView> {
        const action = roleAction(raw), row = await this.owned(req, agentId, runId);
        const saved = await this.repository.transaction(async db => {
            const current = await this.repository.get(row.id, db, true); if (!current) throw new NotFoundException('Запуск не найден.');
            await this.policy.read(req, current);
            if (!['queued', 'running', 'awaiting_review'].includes(current.state)) return current;
            if (current.revision !== action.expectedRevision) throw new ConflictException('Состояние изменилось. Обновите запуск перед отменой.');
            return this.repository.change(db, current, 'cancelled', 'cancelled', 'Запуск отменён пользователем. Предложение сохранено в истории.');
        });
        if (saved.state === 'cancelled') this.active.get(saved.id)?.abort(new Error('System role cancelled.'));
        void notifyRoleOperations(); return this.view(saved, await this.policy.read(req, saved));
    }
    async apply(req: Request, agentId: string, runId: string, raw: unknown, rollback = false): Promise<RoleRunView> {
        const action = roleAction(raw), row = await this.owned(req, agentId, runId);
        const saved = await this.application.apply(req, row, action.expectedRevision, action.requestId, rollback);
        void notifyRoleOperations(); return this.view(saved);
    }
    private view(row: RoleRunRow, actor?: IModelActor): RoleRunView {
        const manage = !actor || (row.project_id ? projectLevel(actor.claims, actor.activeRole, row.project_id) >= 3 : actor.activeRole === 'Главный админ');
        return { id: row.id, agentId: row.agent_id, projectId: row.project_id, actor: row.actor, state: row.state, phase: row.phase, revision: row.revision,
            operationId: 'system-role-' + row.id, message: row.message, createdAt: new Date(row.created_at).toISOString(), finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
            callsStarted: row.calls_started, modelId: row.request.modelId, modelPin: row.request.expectedModelPin, facts: row.facts, result: row.result, steps: row.steps, applied: row.applied,
            targets: row.snapshot.targets.map(({ key, kind, id, version, modelContent, editable }) => ({ key, kind, id, version, content: modelContent, editable })),
            canApply: manage && row.state === 'awaiting_review' && !!row.result?.changes.length && row.result.changes.every(change => row.snapshot.targets.find(target => target.key === change.targetKey)?.editable),
            canRollback: manage && ['succeeded', 'failed', 'interrupted'].includes(row.state) && !!row.applied.length,
            canCancel: ['queued', 'running', 'awaiting_review'].includes(row.state) };
    }
    private wake(): void {
        if (this.stopped) return;
        if (this.draining) { this.wakeAgain = true; return; }
        this.draining = true;
        this.drainTask = this.drain().finally(() => {
            this.draining = false;
            if (this.wakeAgain) { this.wakeAgain = false; this.wake(); }
        });
    }
    private async drain(): Promise<void> {
        try {
            while (!this.stopped) {
                const available = (['server', 'device-codex'] as const).filter(lane => !this.lanes.has(lane));
                if (!available.length) return;
                const row = await this.repository.claim(available); if (!row) return;
                if (this.stopped) { await this.fail(row, true); return; }
                const lane = row.model.runtime === 'device-codex' ? 'device-codex' : 'server';
                this.lanes.add(lane);
                const task = this.run(row).catch(() => undefined).finally(() => {
                    this.tasks.delete(task); this.lanes.delete(lane); this.wake();
                });
                this.tasks.add(task);
            }
        } catch { /* Durable leases expire safely; a scheduler fault never replays old model work. */ }
    }
    private async run(row: RoleRunRow): Promise<void> {
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(new Error('System role deadline.')), Math.max(1, new Date(row.lease_until!).getTime() - Date.now()));
        timeout.unref(); this.active.set(row.id, controller);
        const req = { headers: { 'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '',
            'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: row.actor, activeRole: row.actor_role })) } } as unknown as Request;
        try { await this.runner.run(req, row, controller.signal); }
        catch { await this.fail(row, controller.signal.aborted); }
        finally { clearTimeout(timeout); this.active.delete(row.id); void notifyRoleOperations(); }
    }
    private async fail(row: RoleRunRow, interrupted: boolean): Promise<void> {
        await this.repository.transaction(async db => {
            const current = await this.repository.get(row.id, db, true);
            if (current?.state === 'running' && current.lease_token === row.lease_token) await this.repository.change(db, current,
                interrupted ? 'interrupted' : 'failed', interrupted ? 'interrupted' : 'failed',
                interrupted ? 'Исполнение прервано. Новый вызов требует явного запуска.' : 'Запуск не завершён: проверьте доступность, права, версии и выбранный контекст. Автоматического платного повтора нет.');
        });
    }
}
