import { vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { defaultFeatureFlags, evaluateFeatureFlags, type FeatureFlagKey } from '../../../shared/feature-flags.cjs';
import { ModelRuntime } from '../../src/models/model-runtime';
import type { OllamaClient } from '../../src/models/ollama-client';
import type { RemoteConnectionService } from '../../src/models/remote-connection.service';
import type { ModelsService } from '../../src/models/models.service';
import { ProjectEmbeddingRepository } from '../../src/models/project-embedding.repository';
import type { IProjectEmbeddingSelection } from '../../src/models/project-embedding.types';
import { ModelChatProjectContext } from '../../src/model-chat/chat-project-context';
import type { ChatProjectSource } from '../../src/model-chat/chat-project-context.types';
import { currentModelUsage } from '../../src/model-usage/model-usage.context';
import { SystemRoleTargets } from '../../src/system-roles/system-role.targets';
import type { SystemRolePolicy } from '../../src/system-roles/system-role.policy';
import type { SystemRoleRepository } from '../../src/system-roles/system-role.repository';
import { SystemRoleRunner } from '../../src/system-roles/system-role.runner';
import { roleCallBudget, roleDefinitionPin } from '../../src/system-roles/system-role.definitions';
import type { RolePrepared, RoleRunRow, RoleSelection, SystemRoleId } from '../../src/system-roles/system-role.types';
import { embeddingModel } from './project-context-port';
import type { SystemRoleMcpAccess } from '../../src/system-role-mcp/system-role-mcp.types';

export const diagnosis = (id?: string) => JSON.stringify({ kind: 'diagnosis', summary: 'Проверяемый ответ', answer: 'Проверены доступные источники. Контекст проекта получен из разрешённого индекса. Изменения не применялись. Проверьте приведённые рекомендации перед изменением настроек.',
    findings: id ? [{ evidenceId: id, detail: 'Данные из переданного источника' }] : [], nextSteps: [], changes: [] });
export const delegation = (roleId: SystemRoleId, targetKeys: string[] = []) => ({ roleId, instruction: 'Проверь свою часть.', targetKeys, diagnostics: [] });
export const snippet = (id = 'source-one', excerpt = 'PROJECT KNOWLEDGE') => ({ id, path: 'docs/unrelated-name.md', startLine: 3, endLine: 7, score: 0.9, excerpt });

/** Real context, target, coordinator and runtime owners; only durable/catalog/provider ports are controlled. No socket or PG access. */
export async function systemRoleRagPort(id: SystemRoleId = 'agent-ai-admin', search = true, targets: RoleSelection['targets'] = [],
    tools?: { selection: RoleSelection['mcp']; access: Pick<SystemRoleMcpAccess, 'prepare' | 'canContinueTools' | 'call' | 'close'> }) {
    const project = { id: 'prj-context', name: 'Context', state: 'ACTIVE', headRevision: 1 };
    const selected: IProjectEmbeddingSelection = { projectId: project.id, revision: 1, dataRevision: 2, activeGeneration: 'initial-' + 'a'.repeat(32),
        activeSnapshot: 'b'.repeat(64), profile: { provider: 'openai', model: 'pinned-embedding', dimension: 3 }, expectedDimension: 3,
        modelPin: 'c'.repeat(64), model: embeddingModel };
    const actor = { email: 'owner@example.test', activeRole: 'Главный админ', claims: { email: 'owner@example.test', userRoles: ['Главный админ'], projects: [], pluginIds: [], skillPaths: [] } };
    const flags = Object.fromEntries(Object.keys(defaultFeatureFlags()).map(key => [key, true])) as Record<FeatureFlagKey, boolean>;
    flags.project_search = search;
    const state: { allowed: boolean; pin: boolean; pending: boolean; sources: ChatProjectSource[]; response(): Response } = {
        allowed: true, pin: true, pending: false, sources: [snippet()], response: () => Response.json({ generation: selected.activeGeneration, snapshot: selected.activeSnapshot, sources: state.sources }) };
    const db = { query: vi.fn(async () => ({ rowCount: state.pending ? 1 : 0, rows: [] })) };
    const models = { pool: db, actor: vi.fn(async () => actor), resolveProject: vi.fn(async (_req: Request, projectId: string) => {
        if (!state.allowed || projectId !== project.id) throw new ForbiddenException('project denied'); return { ...project };
    }) };
    vi.spyOn(ProjectEmbeddingRepository.prototype, 'read').mockImplementation(async () => selected);
    const requests = vi.fn(async (url: string | URL | globalThis.Request) => {
        const address = String(url);
        if (address.includes('/internal/project-rag/search')) return state.response();
        if (address.endsWith('/internal/feature-flags/evaluated')) return Response.json(evaluateFeatureFlags(flags));
        throw new Error('Unexpected fixture request');
    });
    vi.stubGlobal('fetch', requests); vi.stubEnv('MODEL_CHAT_CONTEXT_WINDOW_TOKENS', '131072');
    const calls: Array<{ endpoint: string; agentId: string | null | undefined; body: Record<string, unknown>; requiredFeatures: readonly FeatureFlagKey[] | undefined }> = [];
    let provider = async (endpoint: 'embed' | 'chat', body: Record<string, unknown>): Promise<Record<string, unknown>> => endpoint === 'embed'
        ? { embeddings: [[1, 2, 3]] } : { done_reason: 'stop', message: { role: 'assistant', content: diagnosis(JSON.stringify(body).includes('PROJECT KNOWLEDGE') ? 'source-one' : undefined) } };
    const local = { infer: async (_model: unknown, endpoint: 'embed' | 'chat', body: Record<string, unknown>) => {
        const usage = currentModelUsage(); calls.push({ endpoint, agentId: usage.agentId, body, requiredFeatures: usage.requiredFeatures });
        return provider(endpoint, body);
    } };
    const runtime = new ModelRuntime(local as unknown as OllamaClient, {} as RemoteConnectionService);
    const context = new ModelChatProjectContext(models as unknown as ModelsService, runtime);
    const model = { ...embeddingModel, id: 'chat-one', capability: 'chat' as const, dimension: null };
    const policy = { models, actor: async (req: Request, projectId: string | null) => { if (projectId) await models.resolveProject(req, projectId); return actor; },
        current: async () => { if (!state.allowed) throw new ForbiddenException('owner revoked'); if (!state.pin) throw new ConflictException('model pin changed'); return model; } };
    const access = tools?.access as SystemRoleMcpAccess | undefined;
    const owner = new SystemRoleTargets(policy as unknown as SystemRolePolicy, {} as never, {} as never, {} as never, requests, undefined, access, context);
    const req = { headers: {} } as Request, abort = new AbortController();
    const selection: RoleSelection = { projectId: project.id, instruction: 'Проверь проект.', diagnostics: [], targets, ...(tools ? { mcp: tools.selection } : {}) };
    const prepared = await owner.prepare(req, id, selection);
    const row = { id: '12345678-1234-1234-1234-123456789abc', agent_id: id, project_id: project.id, actor: actor.email, actor_role: actor.activeRole,
        request: { ...selection, requestId: '22345678-1234-1234-1234-123456789abc', modelId: model.id, expectedModelPin: 'e'.repeat(64), expectedDefinitionPin: roleDefinitionPin(id), consentDigest: prepared.consentDigest },
        snapshot: prepared, model, state: 'running', phase: 'collecting', lease_token: 'lease', lease_until: new Date(Date.now() + 120000),
        calls_started: 0, facts: [], result: null, applied: [], steps: [] } as unknown as RoleRunRow;
    const repository = { pool: db, fenced: async (_id: string, _lease: string, work: (db: unknown, row: RoleRunRow) => Promise<unknown>) => {
        if (row.state !== 'running') throw new ConflictException('lease lost'); return work(db, row);
    }, change: async (_db: unknown, current: RoleRunRow, state: RoleRunRow['state'], phase: string, message: string, patch: Partial<RoleRunRow>) => Object.assign(current, { state, phase, message }, patch),
        reserveCall: vi.fn(async (_id: string, _lease: string, authorize: (db: unknown, row: RoleRunRow) => Promise<unknown>) => {
            await authorize(db, row); if (row.calls_started >= roleCallBudget(row.agent_id, !!row.snapshot.mcp?.length)) throw new ConflictException('budget exhausted');
            row.calls_started++; return row;
        }) };
    const runner = new SystemRoleRunner(repository as unknown as SystemRoleRepository, policy as unknown as SystemRolePolicy, owner, runtime, async () => undefined, undefined, undefined, access, context);
    return { project, selected, state, models, flags, db, calls, requests, context, runtime, owner, req, abort, row, repository, prepared,
        provider(value: typeof provider) { provider = value; }, run: () => runner.run(req, row, abort.signal),
        async accept(value: RolePrepared) { row.snapshot = value; row.project_id = value.selection.projectId; row.request.projectId = value.selection.projectId;
            row.request.consentDigest = value.consentDigest; row.request.expectedDefinitionPin = value.definitionPin; } };
}
