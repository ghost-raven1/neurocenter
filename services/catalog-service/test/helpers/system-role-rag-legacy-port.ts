import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { ModelsService } from '../../src/models/models.service';
import { modelFromRow, type IModelRow } from '../../src/models/model-history';
import { SystemRolePolicy } from '../../src/system-roles/system-role.policy';
import { SystemRoleRepository } from '../../src/system-roles/system-role.repository';
import type { RoleRunRow, RoleSelection } from '../../src/system-roles/system-role.types';

export const LEGACY_BASE = 'eacf600edd1f17ed3b544c91c54084effdee0e7d';
export const LEGACY_TIME = '2026-10-25T00:00:00.000Z';
export const LEGACY_IDS = { project: 'prj-legacy-context', agent: 'agent-selected', model: 'model-legacy-chat',
    run: '12345678-1234-1234-1234-123456789abc', request: '22345678-1234-1234-1234-123456789abc',
    dialog: '32345678-1234-1234-1234-123456789abc', turn: '42345678-1234-1234-1234-123456789abc' };
export const legacySelection = (): RoleSelection => ({ projectId: LEGACY_IDS.project, instruction: 'Проверь выбранный промпт.', diagnostics: [],
    targets: [{ kind: 'agent', id: LEGACY_IDS.agent }] });

/** Real policy/repository owners over an in-memory SQL port; no Pool, socket or external service. */
export function legacyAuthorityPort(accepted?: RoleRunRow) {
    const project = { id: LEGACY_IDS.project, name: 'Legacy project', state: 'ACTIVE', headRevision: 1 };
    const actor = { email: 'owner@example.test', activeRole: 'Админ проекта', claims: { email: 'owner@example.test',
        userRoles: ['Админ проекта'], projects: [{ projectId: project.id, role: 'Админ проекта' }], pluginIds: [], skillPaths: [] } };
    const modelRow: IModelRow = { id: LEGACY_IDS.model, name: 'Legacy chat', revision: 1,
        descriptor: { runtime: 'ollama', model: 'fixture:legacy-chat', capability: 'chat', dimension: null,
            manifestSha256: 'a'.repeat(64), source: 'custom', description: '' }, created_at: LEGACY_TIME, updated_at: LEGACY_TIME, archived_at: null };
    const state = { accountEnabled: true, membership: 'Админ проекта', assigned: true, sourceAccepted: true,
        targetText: 'SELECTED LEGACY AGENT PROMPT', targetVersion: 7, leaseValid: true };
    let row = accepted;
    const acceptedSource = accepted?.request.source ? [accepted.request.source.turnId, accepted.request.source.dialogId, accepted.actor,
        accepted.request.requestId, accepted.agent_id, accepted.request_hash, accepted.project_id] : undefined;
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const rows = (items: unknown[]) => ({ rows: items, rowCount: items.length });
    const db = { release() {}, query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return rows([]);
        if (sql.includes('FROM platform_users')) return rows(values[0] === actor.email ? [{ enabled: state.accountEnabled, is_main_admin: false }] : []);
        if (sql.includes('FROM project_members')) return rows(values[0] === project.id && values[1] === actor.email ? [{ role: state.membership }] : []);
        if (sql.includes('FROM projects WHERE id=$1')) return rows(values[0] === project.id ? [{ id: project.id }] : []);
        if (sql.includes('FROM system_role_dialog_intents')) return rows(state.sourceAccepted && JSON.stringify(values) === JSON.stringify(acceptedSource) ? [{ id: LEGACY_IDS.turn }] : []);
        if (sql.includes('FROM chat_system_role_origins')) return rows([]);
        if (sql.includes('FROM project_models')) return rows(state.assigned && values[0] === project.id && values[1] === modelRow.id ? [{ model_id: modelRow.id }] : []);
        if (sql.includes('FROM model_catalog WHERE id=$1')) return rows(values[0] === modelRow.id ? [modelRow] : []);
        if (sql.includes('FROM model_remote_connections') || sql.includes('FROM project_rag_sync_intents')) return rows([]);
        if (sql.startsWith('SELECT * FROM system_role_runs WHERE actor=')) return rows([]);
        if (sql.includes("FROM system_role_runs WHERE id=$1 AND state='running'")) return rows(row && state.leaseValid && row.id === values[0]
            && row.lease_token === values[1] && row.state === 'running' && new Date(row.lease_until!).getTime() > Date.now() ? [row] : []);
        if (sql.startsWith('UPDATE system_role_runs SET state=')) {
            if (!row || row.id !== values[0] || row.revision !== values[9]) return rows([]);
            Object.assign(row, { state: values[1], phase: values[2], message: values[3], revision: row.revision + 1,
                steps: JSON.parse(String(values[4])), facts: JSON.parse(String(values[5])), result: values[6] === null ? null : JSON.parse(String(values[6])),
                applied: JSON.parse(String(values[7])), calls_started: values[10] });
            if (!values[8]) row.lease_until = null;
            return rows([row]);
        }
        if (sql.startsWith('INSERT INTO operations(')) return rows([]);
        throw new Error('Unexpected controlled legacy SQL: ' + sql);
    } };
    const pool = { ...db, connect: async () => db };
    const models = { pool, actor: async () => actor, resolveProject: async (_req: Request, id: string) => {
        if (id !== project.id) throw new ForbiddenException('project denied'); return { ...project };
    }, getUsable: async () => modelFromRow(modelRow) };
    const agents = { list: async () => {
        const card = { id: LEGACY_IDS.agent, name: 'Selected agent', version: 3, definition: { prompt: state.targetText } };
        return { items: [card], revision: state.targetVersion, assignments: [{ agentId: card.id, card, removed: false,
            effective: { prompt: state.targetText }, overrides: { prompt: state.targetText } }] };
    } };
    const policy = new SystemRolePolicy(models as unknown as ModelsService);
    const repository = new SystemRoleRepository(pool as never, '00000000-0000-4000-8000-000000000001');
    const req = { headers: {} } as Request;
    return { project, actor, modelRow, state, queries, db, pool, models, agents, policy, repository, req,
        accepted(value: RoleRunRow) { row = value; }, get row() { return row; } };
}
