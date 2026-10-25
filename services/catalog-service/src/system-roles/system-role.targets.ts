import { BadGatewayException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { AgentsService } from '../agents/agents.service';
import type { CatalogService } from '../catalog/catalog.service';
import type { RemoteConnectionService } from '../models/remote-connection.service';
import type { ProjectChatService } from '../project-chat/project-chat.service';
import { remoteModelOptions, assertRemoteModelOptions } from '../models/remote-model-options';
import { allowRequest } from '../access/access-policy';
import type { AgentOverrides } from '../agents/agent.types';
import type { SystemRolePolicy } from './system-role.policy';
import { ROLE_BUDGET, ROLE_RAG_POLICY, ROLE_GUIDANCE_POLICY, roleDefinitionPin, roleHash } from './system-role.definitions';
import {acceptedPreviousDefinition, previousRoleDefinitionPin} from './system-role.previous-contract';
import { acceptedLegacyDefinition, legacyRoleDefinitionPin } from './system-role.legacy-contract';
import { restoreRoleProjection, roleProjection, type PrivateProjection } from './system-role.privacy';
import { readRolePackageSource } from './system-role.package-source';
import { readRoleDialogContext } from './system-role.dialog-context';
import { coordinatorContext } from './system-role.coordinator';
import type {SystemRoleMcpAccess} from '../system-role-mcp/system-role-mcp.types';
import type { ModelChatProjectContext } from '../model-chat/chat-project-context';
import type { RoleApplyReceipt, RolePrepared, RoleRunRow, RoleSelection, RoleTargetSelection, RoleTargetSnapshot, SystemRoleId } from './system-role.types';

type Skill = { body: string; meta: { version: number; [key: string]: unknown } };
const changed = (): never => { throw new ConflictException('Выбранная версия изменилась. Подготовьте и просмотрите контекст заново.'); };
/** Domain owners keep their own CAS, permission, history and validation; no target writes use raw SQL. */
export class SystemRoleTargets {
    constructor(private readonly policy: SystemRolePolicy, private readonly agents: AgentsService, private readonly catalog: CatalogService,
        private readonly connections: RemoteConnectionService, private readonly request: typeof fetch = globalThis.fetch, private readonly chats?: ProjectChatService,
        private readonly mcp?:SystemRoleMcpAccess, private readonly projectContext?: ModelChatProjectContext, private readonly guidanceEnabled = false) {}
    async publicChatChoices(req: Request, project: string | null) {
        if (!project || !this.chats) return [];
        return (await this.chats.rooms(req, project)).rooms.filter(room => room.visibility === 'PUBLIC').slice(0, 50)
            .map(room => ({ kind: 'public-chat', id: room.id, name: room.title }));
    }
    async agentChoices(req: Request, project: string | null) {
        const list = await this.agents.list(req, project ?? undefined);
        return (project ? list.assignments.filter(item => !item.removed).map(item => item.card) : list.items)
            .filter(card => !card.archivedAt).slice(0, 50).map(card => ({ kind: 'agent', id: card.id, name: card.name }));
    }
    private async skill(req: Request, id: string, method = 'GET', body?: unknown): Promise<Skill> {
        const actor = await this.policy.models.actor(req), path = '/api/skills/' + id;
        if (!/^(?:common|project-[A-Za-z0-9._-]+)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id) || id.split('/').some(part => !part || part === '.' || part === '..')
            || !allowRequest(actor.claims, actor.activeRole, { method, path })) throw new ForbiddenException('Выбранный скилл недоступен для этого действия.');
        try {
            const response = await this.request((process.env.SKILLS_SERVICE_URL || 'http://localhost:4200').replace(/\/$/, '') + '/api/skills/' + id.split('/').map(encodeURIComponent).join('/'), {
                method, headers: { 'content-type': 'application/json', 'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '',
                    'x-bridge-actor': String(req.headers['x-bridge-actor'] || ''), 'x-bridge-user-id': actor.email },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(10000) });
            if (response.status === 409) return changed();
            if (!response.ok || Number(response.headers.get('content-length') || 0) > 262144) throw Error('unavailable');
            const reader = response.body?.getReader(); if (!reader) throw Error('unavailable');
            const parts: Uint8Array[] = []; let bytes = 0;
            try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 262144) { await reader.cancel(); throw Error('limit'); } parts.push(part.value); } }
            finally { reader.releaseLock(); }
            const value = JSON.parse(Buffer.concat(parts).toString()) as Skill;
            if (!value || typeof value.body !== 'string' || !value.meta || !Number.isSafeInteger(value.meta.version)) throw Error('invalid'); return value;
        } catch (cause) { if (cause instanceof ConflictException) throw cause; throw new BadGatewayException('Сервис скиллов не подтвердил версию. Проверьте её у владельца перед новым действием.'); }
    }
    async read(req: Request, selection: RoleSelection, target: RoleTargetSelection): Promise<RoleTargetSnapshot> {
        const actor = await this.policy.actor(req, selection.projectId), main = actor.activeRole === 'Главный админ';
        let version = 0, before: Record<string, unknown> = {}, content: string | Record<string, unknown> = '', editable = true, json = false;
        if (target.kind === 'prompt') { content = target.text!; before = { text: target.text }; editable = false; }
        if (target.kind === 'dialog-context') {
            const context = await readRoleDialogContext(this.policy.models.pool, actor.email, selection.projectId, target.id);
            content = JSON.stringify({ selectedOwnDialogContext: context.messages }, null, 2);
            before = { text: content, contextPin: context.pin, sourceDialogId: context.dialogId }; editable = false;
        }
        if (target.kind === 'package-source') {
            if (!main) throw new ForbiddenException('Доверенный исходник упаковки проверяет главный администратор.');
            const source = await readRolePackageSource(this.policy.models.pool, target.id, actor.email, selection.projectId);
            content = JSON.stringify({ inspection: source.descriptor, metadataPin: source.pin, buildPerformed: false, runtimeVerified: false }, null, 2);
            before = { text: content, sourceDialogId: source.dialogId }; editable = false;
        }
        if (target.kind === 'public-chat') {
            if (!selection.projectId || !this.chats || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(target.id)) throw new ForbiddenException('Выберите публичный чат текущего проекта.');
            const source = await this.chats.repository.scoped(selection.projectId, this.chats.policy.input(req), 1, false, async (db, room) => {
                if (room.visibility !== 'PUBLIC') throw new ForbiddenException('Выберите публичный чат. Приватный диалог не включается в контекст системного агента.');
                const page = await this.chats!.repository.page(db, selection.projectId!, undefined, 20, target.id);
                return { version: Number(room.revision), messages: page.messages.filter(item => item.status === 'done').map(item => ({ id: item.id, position: String(item.position), kind: item.kind, content: item.content })) };
            }, false, target.id);
            version = source.version; content = JSON.stringify({ publicRoomId: target.id, messages: source.messages }, null, 2); before = { text: content }; editable = false;
        }
        if (target.kind === 'agent') {
            const list = await this.agents.list(req, selection.projectId ?? undefined);
            const assignment = list.assignments.find(item => item.agentId === target.id && !item.removed), card = assignment?.card ?? list.items.find(item => item.id === target.id);
            if (!card || selection.projectId && !assignment) throw new ForbiddenException('Агент не назначен выбранному проекту.');
            version = selection.projectId ? list.revision! : card.version; content = assignment?.effective.prompt ?? card.definition.prompt;
            before = { card, ...(assignment ? { assignment, projectRevision: list.revision } : {}), text: content }; editable = !!selection.projectId || main;
        }
        if (target.kind === 'skill') {
            if (selection.projectId && !main) {
                const project = await this.policy.models.resolveProject(req, selection.projectId, 3, actor);
                if (!target.id.startsWith('project-' + project.id + '/') && !target.id.startsWith('project-' + project.name + '/')) throw new ForbiddenException('Выберите скилл, принадлежащий текущему проекту.');
            }
            const skill = await this.skill(req, target.id); version = skill.meta.version; content = skill.body; before = { text: skill.body };
            editable = allowRequest(actor.claims, actor.activeRole, { method: 'PUT', path: '/api/skills/' + target.id });
        }
        if (target.kind === 'plugin-settings') {
            if (selection.projectId && !(await this.policy.models.pool.query("SELECT 1 FROM project_assets WHERE project_id=$1 AND asset_id=$2 AND asset_kind='plugin'", [selection.projectId, target.id])).rowCount) throw new ForbiddenException('Плагин не назначен выбранному проекту.');
            const plugin = await this.catalog.getAiPlugin(target.id);
            if (plugin.id !== target.id || plugin.kind !== 'plugin' || plugin.archivedAt) throw new ConflictException('Выберите точный ID доступного плагина.');
            version = plugin.version; content = plugin.description; before = { text: content }; editable = main;
        }
        if (target.kind === 'adapter') {
            if (!main) throw new ForbiddenException('Приватное подключение настраивает главный администратор.');
            const view = await this.connections.read(target.id); if (!view.revision) throw new ConflictException('Сначала создайте подключение в форме модели.');
            version = view.revision; content = { ...view.options }; before = { options: view.options, modelRevision: view.modelRevision }; json = true;
        }
        const projection = roleProjection(content, json, target.kind === 'adapter' ? ['apiFormat', 'reasoningEffort', 'responseModel', 'tokenLimitParameter'] : []);
        if (Buffer.byteLength(projection.content) > (target.kind === 'dialog-context' ? 49152 : 32768)) throw new ConflictException('Выбранный контекст превышает предел цели. Выберите меньший фрагмент.');
        return { key: target.kind + ':' + target.id, kind: target.kind, id: target.id, version, pin: roleHash({ version, before }),
            modelContent: projection.content, before: structuredClone({ ...before, projection }), editable };
    }
    /** Only Runner supplies acceptedRun; new admissions always use current definitions and fresh authority. */
    async prepare(req: Request, id: SystemRoleId, selection: RoleSelection, acceptedMcp?: RolePrepared['mcp'], accepted?: Pick<RolePrepared, 'projectContext' | 'guidance'>, acceptedRun?: RoleRunRow): Promise<RolePrepared> {
        const legacy = acceptedRun?.agent_id === id && acceptedRun.snapshot === accepted ? acceptedLegacyDefinition(acceptedRun) : undefined;
        const previous = acceptedRun?.agent_id === id && acceptedRun.snapshot === accepted ? acceptedPreviousDefinition(acceptedRun) : undefined;
        const guidance = accepted === undefined ? this.guidanceEnabled ? {version: 1 as const, projectId: selection.projectId} : undefined : accepted.guidance;
        selection = { projectId: selection.projectId, instruction: selection.instruction, diagnostics: selection.diagnostics, targets: selection.targets,...(selection.mcp?.length?{mcp:selection.mcp}:{}) };
        const targets: RoleTargetSnapshot[] = [];
        for (const target of selection.targets) targets.push(await this.read(req, selection, target));
        if(selection.mcp?.length&&!acceptedMcp&&!this.mcp)throw new ConflictException('Исполнитель MCP системных агентов не настроен. Сохраните выбор и повторите позже.');
        const mcp=selection.mcp?.length?acceptedMcp??await this.mcp!.prepare(req,selection.projectId,selection.mcp):undefined;
        let projectContext = accepted?.projectContext;
        if (accepted === undefined && selection.projectId && this.projectContext) {
            const captured = await this.projectContext.capture(req, selection.projectId);
            if (captured.searchEnabled) projectContext = { scope: 'project-index', projectId: selection.projectId,
                projectName: captured.evidence.project!.name, identity: captured.identity,
                recipients: [id, ...(id === 'agent-coordinator' ? coordinatorContext({ selection, targets, mcp }).roles.map(role => role.id) : [])],
                ...(captured.evidence.generation ? { generation: captured.evidence.generation } : {}), ...(captured.evidence.snapshot ? { snapshot: captured.evidence.snapshot } : {}) };
        }
        if (projectContext) {
            if (!this.projectContext || projectContext.projectId !== selection.projectId) throw new ConflictException('Разрешение базы знаний относится к другому проекту.');
            await this.projectContext.assertIdentity(req, projectContext.projectId, projectContext.identity);
        }
        const preview = JSON.stringify({ instruction: roleProjection(selection.instruction).content, diagnostics: selection.diagnostics,
            targets: targets.map(target => ({ key: target.key, kind: target.kind, version: target.version, content: target.modelContent })),
            ...(projectContext ? { projectContext: { ...projectContext, policy: ROLE_RAG_POLICY, sharesModelCallBudget: true } } : {}),
            ...(guidance ? {guidance: {projectId: guidance.projectId, description: 'Справочные статьи и реальные безопасные проверки индекса, модели, моих мостов, очереди и обучения. Настройки не меняются автоматически.', policy: ROLE_GUIDANCE_POLICY}} : {}),
            ...(mcp?{mcp}:{}),...(id === 'agent-coordinator' ? { delegation: coordinatorContext({ selection, targets,mcp }, !!legacy) } : {}) }, null, 2);
        if (Buffer.byteLength(preview) > ROLE_BUDGET.contextBytes) throw new ConflictException('Общий выбранный контекст больше 64 КиБ. Уменьшите выбор.');
        const definitionPin = legacy ? legacyRoleDefinitionPin(id) : previous ? previousRoleDefinitionPin(id) : roleDefinitionPin(id), consentDigest = roleHash({ definitionPin, selection, targets: targets.map(({ key, pin, modelContent }) => ({ key, pin, modelContent })),...(mcp?{mcp}:{}), ...(projectContext ? { projectContext, projectKnowledge: ROLE_RAG_POLICY } : {}), ...(guidance ? {guidance, guidancePolicy: ROLE_GUIDANCE_POLICY} : {}) });
        return { selection, definitionPin, consentDigest, preview, targets,...(mcp?{mcp}:{}), ...(projectContext ? { projectContext } : {}), ...(guidance ? {guidance} : {}) };
    }
    replacement(target: RoleTargetSnapshot, content: string): string {
        const restored = restoreRoleProjection(content, target.before.projection as unknown as PrivateProjection, target.kind === 'adapter');
        if (target.kind === 'adapter') remoteModelOptions(JSON.parse(restored));
        return restored;
    }
    async write(req: Request, prepared: RolePrepared, target: RoleTargetSnapshot, replacement: string, key: string, rollback?: RoleApplyReceipt): Promise<RoleApplyReceipt> {
        const selected = prepared.selection.targets.find(item => item.kind === target.kind && item.id === target.id)!;
        const current = await this.read(req, prepared.selection, selected);
        if (!target.editable || !current.editable || (rollback ? current.version !== rollback.version || current.pin !== rollback.pin : current.pin !== target.pin)) return changed();
        const actor = await this.policy.actor(req, prepared.selection.projectId), text = rollback ? String(target.before.text ?? '') : this.replacement(target, replacement);
        let ownerVersion = -1, ownerModelRevision: number | undefined, expectedOptions: unknown;
        if (target.kind === 'agent') {
            if (prepared.selection.projectId) {
                const previous = (rollback ? target : current).before.assignment as { overrides: AgentOverrides };
                const patch = { overrides: rollback ? previous.overrides : { ...previous.overrides, prompt: text }, expectedRevision: current.version, requestKey: key };
                const saved = rollback ? await this.agents.projects.update(actor, prepared.selection.projectId, target.id, patch)
                    : await this.agents.configure(req, prepared.selection.projectId, target.id, patch);
                ownerVersion = saved.revision;
            } else {
                const card = (await this.agents.get(req, target.id)), patch = { definition: { ...card.definition, prompt: text }, expectedVersion: current.version, requestKey: key };
                const saved = rollback ? await this.agents.cards.update(actor, target.id, patch) : await this.agents.update(req, target.id, patch);
                ownerVersion = saved.version;
            }
        }
        if (target.kind === 'skill') ownerVersion = (await this.skill(req, target.id, 'PUT', { body: text, expectedVersion: current.version, note: 'Системный агент: проверенное человеком изменение.' })).meta.version;
        if (target.kind === 'plugin-settings') {
            if (actor.activeRole !== 'Главный админ') throw new ForbiddenException('Общий плагин изменяет главный администратор.');
            ownerVersion = (await this.catalog.updateAiPlugin(target.id, { expectedVersion: current.version, description: text }, actor.email)).version;
        }
        if (target.kind === 'adapter') {
            const view = await this.connections.read(target.id), options = rollback ? remoteModelOptions(target.before.options) : remoteModelOptions(JSON.parse(this.replacement(target, replacement)));
            assertRemoteModelOptions(await this.policy.models.get(target.id), options);
            const saved = await this.connections.save(target.id, { expectedRevision: view.revision, expectedModelRevision: view.modelRevision, baseUrl: view.baseUrl,
                requestDimensions: view.requestDimensions, credential: view.credential, credentialEnv: view.credentialEnv ?? undefined, timeoutMs: view.timeoutMs, options }, actor.email,
            async () => { await this.policy.models.requireMain(req); });
            ownerVersion = saved.revision; ownerModelRevision = saved.modelRevision; expectedOptions = options;
        }
        const after = await this.read(req, prepared.selection, selected);
        if (after.version !== ownerVersion || (target.kind === 'adapter' ? after.before.modelRevision !== ownerModelRevision || roleHash(after.before.options) !== roleHash(expectedOptions) : after.before.text !== text)) return changed();
        return { targetKey: target.key, owner: target.kind, version: after.version, pin: after.pin };
    }
}
