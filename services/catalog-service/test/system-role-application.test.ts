import { describe, expect, it, vi } from 'vitest';
import { SystemRoleApplication } from '../src/system-roles/system-role.apply';
import { roleDefinitionPin } from '../src/system-roles/system-role.definitions';
import type { RoleRunRow } from '../src/system-roles/system-role.types';
const deferred = () => { let resolve!: (value?: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
    const row = { id: 'run', agent_id: 'agent-autoconfigurator', project_id: 'prj-one', state: 'awaiting_review', revision: 5, applied: [],
        request: { expectedDefinitionPin: roleDefinitionPin('agent-autoconfigurator') }, result: { kind: 'proposal', changes: [{ targetKey: 'agent:one', replacement: 'New prompt' }] },
        snapshot: { targets: [{ key: 'agent:one', editable: true }], selection: { projectId: 'prj-one' } } } as unknown as RoleRunRow;
    const repository = { transaction: async work => work({}), get: async () => row, applying: async (_id, phase) => { if (row.state !== 'applying' || row.phase !== phase) throw Error('fenced'); return row; },
        change: vi.fn(async (_db, current, state, phase, message, patch) => Object.assign(current, { state, phase, message, revision: current.revision + 1 }, patch)) };
    const policy = { actor: vi.fn(async () => ({ email: 'admin@example.test' })), authorize: vi.fn(async () => undefined) };
    const receipt = { targetKey: 'agent:one', version: 2, pin: 'b'.repeat(64), owner: 'agent' };
    const targets = { write: vi.fn(async () => receipt) }, features = vi.fn(async () => undefined);
    const service = new SystemRoleApplication(repository as never, policy as never, targets as never, features);
    return { row, repository, policy, targets, receipt, features, apply: (revision = 5, rollback = false) => service.apply({} as never, row, revision, '12345678-1234-1234-1234-123456789abc', rollback) };
}
describe('Human role proposal application', () => {
    it('does not dispatch a second owner write while the first tab is applying', async () => {
        const f = fixture(), started = deferred(), release = deferred();
        f.targets.write.mockImplementation(async () => { started.resolve(); await release.promise; return f.receipt; });
        const first = f.apply(); await started.promise;
        expect((await f.apply()).state).toBe('applying'); expect(f.targets.write).toHaveBeenCalledOnce();
        release.resolve(); await first; expect(f.row.state).toBe('succeeded'); expect(f.row.applied).toEqual([f.receipt]);
        await f.apply(); expect(f.targets.write).toHaveBeenCalledOnce();
    });
    it('does not repeat an unknown owner mutation acknowledgement', async () => {
        const f = fixture(); f.targets.write.mockRejectedValue(new Error('HTTP response lost after possible owner commit'));
        expect((await f.apply()).state).toBe('interrupted'); expect(f.row.applied).toEqual([]);
        await expect(f.apply(f.row.revision)).rejects.toThrow(); expect(f.targets.write).toHaveBeenCalledOnce();
        expect(f.row.message).not.toContain('HTTP');
    });
    it('rolls back only actual owner receipts with the role flag disabled', async () => {
        const f = fixture(); await f.apply(); const checks = f.features.mock.calls.length; f.features.mockRejectedValue(new Error('role disabled'));
        const saved = await f.apply(f.row.revision, true); expect(saved.phase).toBe('rolled_back'); expect(saved.applied).toEqual([]);
        expect(f.targets.write.mock.calls[1][5]).toEqual(f.receipt); expect(f.features).toHaveBeenCalledTimes(checks);
    });
    it('rejects stale human revision and mixed read-only targets before any owner mutation', async () => {
        const f = fixture(); await expect(f.apply(4)).rejects.toThrow(); expect(f.targets.write).not.toHaveBeenCalled();
        f.row.snapshot.targets[0].editable = false; await expect(f.apply()).rejects.toThrow('владельца'); expect(f.targets.write).not.toHaveBeenCalled();
    });
});
