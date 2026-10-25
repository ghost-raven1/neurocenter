import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFeatureFlags, evaluateFeatureFlags, type FeatureFlagKey } from '../../shared/feature-flags.cjs';
import { SystemRoleService } from '../src/system-roles/system-role.service';
import { SystemRoleTargets } from '../src/system-roles/system-role.targets';
import { roleDefinitionPin, roleHash } from '../src/system-roles/system-role.definitions';
import { roleResult } from '../src/system-roles/system-role.validation';
import { ProjectEmbeddingRepository } from '../src/models/project-embedding.repository';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import type { IProjectEmbeddingSelection } from '../src/models/project-embedding.types';
import type { RoleRunRow, RoleSelection } from '../src/system-roles/system-role.types';
import { legacyAuthorityPort } from './helpers/system-role-rag-legacy-port';

const accepted = JSON.parse(readFileSync('test/fixtures/system-role-rag-eacf600.json', 'utf8')) as { row: RoleRunRow };
type PrepareAgain = { reason: 'definition_changed'; selection: RoleSelection; modelId: string };

/** Actual service/application/policy/repository/target owners; only run storage and catalog/provider ports are controlled. */
async function fixture(current = false) {
    const row = structuredClone(accepted.row);
    if (current) {
        const source = legacyAuthorityPort(row), targets = new SystemRoleTargets(source.policy, source.agents as never, {} as never, {} as never);
        row.snapshot = await targets.prepare(source.req, row.agent_id, row.snapshot.selection);
        row.request.expectedDefinitionPin = row.snapshot.definitionPin; row.request.consentDigest = row.snapshot.consentDigest;
        row.request_hash = roleHash({ id: row.agent_id, input: row.request });
    }
    row.state = 'awaiting_review'; row.phase = 'review'; row.lease_until = null; row.calls_started = 1;
    row.result = roleResult(JSON.stringify({ kind: 'proposal', summary: 'Сохранённое предложение', findings: [], nextSteps: [], changes: [{ targetKey: row.snapshot.targets[0].key,
        replacement: 'Полный новый выбранный промпт', explanation: 'Уточнение выбранной задачи.' }] }), row.snapshot, []);
    const port = legacyAuthorityPort(row), originalQuery = port.db.query;
    const query = async (sql: string, values: unknown[] = []) => {
        if (sql === 'SELECT * FROM system_role_runs WHERE id=$1' || sql === 'SELECT * FROM system_role_runs WHERE id=$1 FOR NO KEY UPDATE') {
            return { rows: values[0] === row.id ? [row] : [], rowCount: values[0] === row.id ? 1 : 0 };
        }
        return originalQuery(sql, values);
    };
    port.db.query = query; port.pool.query = query;
    const flags = Object.fromEntries(Object.keys(defaultFeatureFlags()).map(key => [key, true])) as Record<FeatureFlagKey, boolean>;
    flags.project_search = false;
    const requests = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith('/internal/feature-flags/evaluated')) return Response.json(evaluateFeatureFlags(flags));
        throw Error('Unexpected legacy continuation fixture fetch: ' + String(url));
    });
    vi.stubGlobal('fetch', requests);
    const embedding = { ...row.model, id: 'model-continuation-embedding', model: 'fixture:embedding', capability: 'embedding' as const, dimension: 3 };
    const selection: IProjectEmbeddingSelection = { projectId: row.project_id!, revision: 1, dataRevision: 1, activeGeneration: 'initial-' + 'a'.repeat(32),
        activeSnapshot: 'b'.repeat(64), profile: { provider: 'openai', model: 'fixture:embedding', dimension: 3 }, expectedDimension: 3,
        modelPin: projectEmbeddingPin(embedding), model: embedding };
    vi.spyOn(ProjectEmbeddingRepository.prototype, 'read').mockResolvedValue(selection);
    const infer = vi.fn(async () => { throw Error('Free continuation must not invoke a model'); });
    const service = new SystemRoleService(port.models as never, port.agents as never, {} as never, {} as never, { infer } as never, {} as never);
    const create = vi.spyOn(service.repository, 'create'), write = vi.spyOn(service.targets, 'write');
    return { ...port, row, service, infer, create, write };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Truthful legacy proposal capability and current preparation', () => {
    it('does not advertise apply for an authentic legacy awaiting-review proposal', async () => {
        const f = await fixture(), view = await f.service.detail(f.req, f.row.agent_id, f.row.id);
        expect(view.canApply).toBe(false);
        expect(view).toMatchObject({ state: 'awaiting_review', result: f.row.result, canCancel: true });
        expect(f.infer).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    });
    it('prepares the current role from the owner original input without starting a run', async () => {
        const f = await fixture(), original = structuredClone(f.row), view = await f.service.detail(f.req, f.row.agent_id, f.row.id);
        const draft = Reflect.get(view, 'prepareAgain') as PrepareAgain | undefined;
        expect(draft).toEqual({ reason: 'definition_changed', selection: original.snapshot.selection, modelId: original.request.modelId });
        const prepared = await f.service.prepare(f.req, f.row.agent_id, draft!.selection);
        expect(prepared.definitionPin).toBe(roleDefinitionPin(f.row.agent_id));
        expect(prepared.definitionPin).not.toBe(original.request.expectedDefinitionPin);
        expect(prepared.consentDigest).not.toBe(original.request.consentDigest);
        expect(JSON.parse(prepared.preview)).toMatchObject({ instruction: original.request.instruction });
        expect(draft).not.toHaveProperty('expectedDefinitionPin'); expect(draft).not.toHaveProperty('consentDigest');
        expect(draft).not.toHaveProperty('projectContext'); expect(draft).not.toHaveProperty('source');
        expect(f.row).toEqual(original); expect(f.infer).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    });
    it('keeps current awaiting-review proposals applicable', async () => {
        const f = await fixture(true), view = await f.service.detail(f.req, f.row.agent_id, f.row.id);
        expect(view.canApply).toBe(true); expect(Reflect.get(view, 'prepareAgain')).toBeUndefined();
        expect(f.infer).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    });
    it('keeps the fresh application pin guard and performs no legacy owner write', async () => {
        const f = await fixture(), original = structuredClone(f.row);
        await expect(f.service.apply(f.req, f.row.agent_id, f.row.id,
            { expectedRevision: f.row.revision, requestId: '92345678-1234-1234-1234-123456789abc' })).rejects.toThrow('Определение агента изменилось');
        expect(f.row).toEqual(original); expect(f.infer).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
    });
    it('keeps legacy service-chat input private from another administrator', async () => {
        const f = await fixture(); f.actor.email = 'other@example.test'; f.actor.claims.email = f.actor.email;
        await expect(f.service.detail(f.req, f.row.agent_id, f.row.id)).rejects.toHaveProperty('status', 404);
        expect(f.infer).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    });
});
