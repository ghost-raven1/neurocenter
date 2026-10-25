import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildPackage } from '../src/catalog/bundle-package';
import { SystemRoleMcpPolicy } from '../src/system-role-mcp/system-role-mcp.policy';
import { SYSTEM_ROLE_MCP_CAPABILITY, type RoleMcpTarget } from '../../shared/system-role-mcp.cjs';

const project = 'mcp-policy-project', email = 'owner@test';
const remote = (headers = { Accept: 'application/json' }) => buildPackage({ id: 'generic-tool', kind: 'mcp', name: 'Generic tool', version: 1 }, [], '', { transport: 'remote', url: 'https://mcp.example/service', headers });
/** Boundary ports deliberately reject alternate pools: the supplied transaction must own every mutable pin read. */
function fixture() {
    const pkg = remote(), target: RoleMcpTarget = { runtime: 'device', assetId: pkg.plugin.id, version: 1, manifest: pkg.manifest.sha256,
        deviceId: randomUUID(), bindingId: 'b'.repeat(64), instanceId: randomUUID(), configurationRevisions: [] };
    const actor = { email, activeRole: 'Админ проекта', claims: { email, userRoles: ['Админ проекта'], projects: [{ projectId: project, role: 'Админ проекта' }] } };
    const device = { id: target.deviceId, email, role: actor.activeRole, report: { protocolVersion: 2, capabilities: ['durable-completions', 'managed-installations', 'workspace-instance-v1', SYSTEM_ROLE_MCP_CAPABILITY], bindings: [{ projectId: project, bindingId: target.bindingId, instanceId: target.instanceId }] } };
    let connected = true;
    const db = { query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM project_assets')) return { rows: [{ project_id: project, asset_id: pkg.plugin.id, asset_kind: 'mcp', asset_version: 1, asset_manifest: pkg.manifest.sha256, pin_snapshot: { package: pkg } }] };
        if (sql.includes('FROM bridge_devices')) return { rows: connected ? [device] : [] };
        if (sql.includes('FROM platform_users')) return { rows: [{ enabled: true, is_main_admin: false }] };
        if (sql.includes('FROM project_members')) return { rows: actor.claims.projects };
        return { rows: [] };
    }) };
    const forbiddenPool = { query: vi.fn(async () => { throw new Error('A second pool must not authorize dispatch'); }) };
    const installations = { inspectionDelivery: vi.fn(async (_actor, _input, currentDb) => { expect(currentDb).toBe(db); return { package: pkg }; }) };
    const plans = { approvedInstalled: vi.fn(async (_project, _package, currentDb) => { expect(currentDb).toBe(db); return { package: pkg }; }) };
    const policy = new SystemRoleMcpPolicy({ pool: forbiddenPool, actor: async () => actor, resolveProject: async () => ({ id: project }) } as never,
        { owned: vi.fn(async () => { throw new Error('Stale device owner helper must not authorize dispatch'); }) } as never, installations as never, plans as never);
    return { policy, db, pkg, target, device, installations, plans, forbiddenPool, revoke: () => { connected = false; } };
}

describe('Generic MCP catalogue runtime authority', () => {
    it('resolves the exact owned binding, package and approval using the caller transaction', async () => {
        const f = fixture();
        await expect(f.policy.target({ headers: {} } as never, project, f.target, f.db as never)).resolves.toEqual({ package: f.pkg });
        expect(f.installations.inspectionDelivery).toHaveBeenCalledOnce(); expect(f.plans.approvedInstalled).toHaveBeenCalledOnce(); expect(f.forbiddenPool.query).not.toHaveBeenCalled();
    });
    it('rejects a revoked device before resolving installation or dispatch authority', async () => {
        const f = fixture(); f.revoke();
        await expect(f.policy.target({ headers: {} } as never, project, f.target, f.db as never)).rejects.toHaveProperty('status', 403);
        expect(f.installations.inspectionDelivery).not.toHaveBeenCalled(); expect(f.plans.approvedInstalled).not.toHaveBeenCalled();
    });
    it('rejects binding and configuration revision changes before a tool can be admitted', async () => {
        const f = fixture(); f.device.report.bindings[0].instanceId = randomUUID();
        await expect(f.policy.target({ headers: {} } as never, project, f.target, f.db as never)).rejects.toThrow('экземпляр');
        f.device.report.bindings[0].instanceId = f.target.runtime === 'device' ? f.target.instanceId : '';
        await expect(f.policy.target({ headers: {} } as never, project, { ...f.target, configurationRevisions: [{ assetId: f.pkg.plugin.id, manifest: f.pkg.manifest.sha256, revision: randomUUID() }] } as RoleMcpTarget, f.db as never)).rejects.toThrow('настройка');
    });
    it('permits a pinned generic HTTP MCP without a computer, but refuses credentials in its public manifest', async () => {
        const f = fixture(); await expect(f.policy.server(f.pkg, f.db as never)).resolves.toBeUndefined();
        for (const headers of [{ Authorization: 'Bearer private' }, { 'X-Api-Key': 'private' }, { Accept: '{env:SECRET}' }]) await expect(f.policy.server(remote(headers as never), f.db as never)).rejects.toThrow('Секреты');
        expect(f.installations.inspectionDelivery).not.toHaveBeenCalled();
    });
    it('accepts only a proven plugin MCP producer and exact assigned manifest', async () => {
        const f = fixture();
        await expect(f.policy.package(project, { ...f.target, manifest: 'c'.repeat(64) }, f.db as never)).rejects.toThrow('изменились');
        const ordinary = buildPackage({ id: 'generic-tool', kind: 'plugin', name: 'OpenCodeRAG', version: 1 }, [], '', { entrypoint: 'plugin-factory.mjs' });
        const db = { query: async () => ({ rows: [{ asset_id: ordinary.plugin.id, asset_kind: 'plugin', asset_version: 1, asset_manifest: ordinary.manifest.sha256, pin_snapshot: { package: ordinary } }] }) };
        await expect(f.policy.package(project, { ...f.target, assetKind: 'plugin', manifest: ordinary.manifest.sha256 }, db as never)).rejects.toThrow('MCP');
    });
});
