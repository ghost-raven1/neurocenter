import { describe, expect, it } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
    AgentExtensionRepository,
    assertExtensionInKit,
    agentExtensionKits,
    KIT_SQL,
    resolveAgentExtensionKit,
    resolveKitRows,
    withExtensionKits,
    type IKitRow,
} from '../agent-extension-kit';
import { AGENT_AUDIT_ACTIONS } from '../agent-audit';
import type { IAgentExtension, IProjectAgent } from '../../../../shared/project-agents.cjs';
import type { IProjectPinRow } from '../../catalog/project-asset-pins';

const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);
const PROJECT = 'project-1';
const AGENT = 'agent-dev1';
const DEVICE = '11111111-2222-4333-8444-555555555555';
const ACTOR = 'a@example.test';

interface Recorded {
    sql: string;
    params: unknown[];
}
interface PoolOverrides {
    assigned?: boolean;
    pinRow?: IProjectPinRow | null;
    experimentRow?: Record<string, unknown> | null;
}
/** Fake pool routed by SQL shape: BEGIN/lock/read-check/write/audit/COMMIT. */
function fakePool(overrides: PoolOverrides = {}) {
    const recorded: Recorded[] = [];
    const client = {
        query: async (sql: string, params: unknown[] = []) => {
            recorded.push({ sql, params });
            if (/^BEGIN$/.test(sql.trim())) return { rows: [] };
            if (/^(COMMIT|ROLLBACK)$/.test(sql.trim())) return { rows: [] };
            if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
            if (/SELECT 1 FROM project_agents/.test(sql))
                return { rows: overrides.assigned ? [{}] : [], rowCount: overrides.assigned ? 1 : 0 };
            if (/FROM project_assets/.test(sql)) return { rows: overrides.pinRow ? [overrides.pinRow] : [] };
            if (/INSERT INTO agent_extension_pins/.test(sql)) return { rows: [] };
            if (/INSERT INTO agent_extension_experiments/.test(sql)) return { rows: [] };
            if (/UPDATE agent_extension_experiments SET revoked_at/.test(sql))
                return { rows: overrides.experimentRow ? [overrides.experimentRow] : [] };
            return { rows: [] };
        },
        release: () => {},
    };
    const pool = { connect: async () => client } as never;
    return { pool, recorded };
}
const pinRow = (partial: Partial<IProjectPinRow> = {}): IProjectPinRow => ({
    project_id: PROJECT,
    asset_id: 'mcp-search',
    asset_kind: 'mcp',
    added_by: ACTOR,
    added_at: new Date(),
    asset_version: 3,
    asset_manifest: SHA,
    pin_origin: 'approved',
    pin_snapshot: { card: {} as never, package: {} as never },
    ...partial,
});
const kitRow = (partial: Partial<IKitRow> = {}): IKitRow => ({
    agent_id: AGENT,
    asset_id: 'mcp-search',
    asset_kind: 'mcp',
    asset_version: 3,
    asset_manifest: SHA,
    origin: 'approved',
    ...partial,
});
const fakeDb = (rows: IKitRow[]) => ({
    query: async (_sql: string, _params: unknown[] = []) => ({ rows }),
});

describe('AgentExtensionRepository.pin', () => {
    it('pins an approved project asset and mirrors the exact version/manifest/snapshot (provenance from epic 2)', async () => {
        const { pool, recorded } = fakePool({ assigned: true, pinRow: pinRow() });
        const repo = new AgentExtensionRepository(pool);
        const result = await repo.pin(PROJECT, AGENT, 'mcp-search', 'mcp', ACTOR);
        expect(result).toEqual({
            assetId: 'mcp-search',
            assetKind: 'mcp',
            version: 3,
            manifest: SHA,
            origin: 'approved',
        });
        const insert = recorded.find((row) => /INSERT INTO agent_extension_pins/.test(row.sql));
        expect(insert).toBeTruthy();
        const params = insert!.params as unknown[];
        expect(params[4]).toBe(3);
        expect(params[5]).toBe(SHA);
        expect(JSON.parse(params[6] as string)).toEqual({ card: {}, package: {} });
        expect(recorded[recorded.length - 1].sql).toBe('COMMIT');
    });

    it('refuses an asset that is not in the project approved kit (fail-closed)', async () => {
        const { pool, recorded } = fakePool({ assigned: true, pinRow: null });
        const repo = new AgentExtensionRepository(pool);
        await expect(repo.pin(PROJECT, AGENT, 'mcp-foreign', 'mcp', ACTOR)).rejects.toMatchObject({
            status: 409,
        });
        expect(recorded.every((row) => !/INSERT INTO agent_extension_pins/.test(row.sql))).toBe(true);
    });

    it('refuses a project pin without a confirmed exact version (unconfirmed is not an approved kit entry)', async () => {
        const { pool } = fakePool({
            assigned: true,
            pinRow: pinRow({ asset_version: null, asset_manifest: null, pin_snapshot: null }),
        });
        const repo = new AgentExtensionRepository(pool);
        await expect(repo.pin(PROJECT, AGENT, 'mcp-search', 'mcp', ACTOR)).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses an agent that is not assigned to the project', async () => {
        const { pool, recorded } = fakePool({ assigned: false });
        const repo = new AgentExtensionRepository(pool);
        await expect(repo.pin(PROJECT, 'agent-other', 'mcp-search', 'mcp', ACTOR)).rejects.toBeInstanceOf(
            ConflictException,
        );
        expect(recorded.every((row) => !/INSERT INTO agent_extension_pins/.test(row.sql))).toBe(true);
    });
});

describe('AgentExtensionRepository experiments', () => {
    const base = {
        projectId: PROJECT,
        agentId: AGENT,
        deviceId: DEVICE,
        assetId: 'plugin-local',
        kind: 'plugin',
        declaredVersion: 1,
        declaredManifest: SHA,
        actor: ACTOR,
        input: { purpose: 'capability-test', expiresAt: new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString() },
    };

    it('enables a device-local capability test and writes the audit transactionally', async () => {
        const { pool, recorded } = fakePool({ assigned: true });
        const repo = new AgentExtensionRepository(pool);
        const result = await repo.enableExperiment(
            base.projectId,
            base.agentId,
            base.deviceId,
            base.assetId,
            base.kind,
            base.declaredVersion,
            base.declaredManifest,
            base.actor,
            base.input,
        );
        expect(result.origin).toBe('experimental');
        expect(result.version).toBe(1);
        expect(result.expiresAt).toBe(base.input.expiresAt);
        const audit = recorded.find((row) => /INSERT INTO security_events/.test(row.sql));
        expect(audit).toBeTruthy();
        const params = audit!.params as unknown[];
        expect(params[2]).toBe('agent.extensions.experimental-enable');
        const after = JSON.parse(params[5] as string) as Record<string, unknown>;
        expect(after.agentId).toBe(AGENT);
        expect(after.assetKind).toBe('plugin');
        expect(after.origin).toBe('experimental');
        expect(after.revoked).toBe(false);
        expect(recorded[recorded.length - 1].sql).toBe('COMMIT');
    });

    it('refuses an experiment lifetime outside 7–30 days', async () => {
        const { pool, recorded } = fakePool({ assigned: true });
        const repo = new AgentExtensionRepository(pool);
        const short = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
        const long = new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString();
        await expect(
            repo.enableExperiment(base.projectId, base.agentId, base.deviceId, base.assetId, base.kind, 1, SHA, ACTOR, {
                expiresAt: short,
            }),
        ).rejects.toBeInstanceOf(Error);
        await expect(
            repo.enableExperiment(base.projectId, base.agentId, base.deviceId, base.assetId, base.kind, 1, SHA, ACTOR, {
                expiresAt: long,
            }),
        ).rejects.toBeInstanceOf(Error);
        expect(recorded.every((row) => !/INSERT INTO agent_extension_experiments/.test(row.sql))).toBe(true);
    });

    it('revokes a test and records the revoked audit record', async () => {
        const revokedAt = new Date();
        const { pool, recorded } = fakePool({
            assigned: true,
            experimentRow: {
                device_id: DEVICE,
                asset_id: 'plugin-local',
                asset_kind: 'plugin',
                declared_version: 1,
                declared_manifest: SHA,
                purpose: 'capability-test',
                expires_at: revokedAt,
                revoked_at: revokedAt,
            },
        });
        const repo = new AgentExtensionRepository(pool);
        await repo.revokeExperiment(PROJECT, AGENT, 'plugin-local', 'plugin', ACTOR);
        const audit = recorded.find((row) => /INSERT INTO security_events/.test(row.sql));
        expect(audit).toBeTruthy();
        const params = audit!.params as unknown[];
        expect(params[2]).toBe('agent.extensions.experimental-revoke');
        const before = JSON.parse(params[4] as string) as Record<string, unknown>;
        const after = JSON.parse(params[5] as string) as Record<string, unknown>;
        expect(before.revoked).toBe(false);
        expect(after.revoked).toBe(true);
        expect(typeof after.revokedAt).toBe('string');
    });

    it('reports a missing or already revoked experiment', async () => {
        const { pool } = fakePool({ assigned: true, experimentRow: null });
        const repo = new AgentExtensionRepository(pool);
        await expect(repo.revokeExperiment(PROJECT, AGENT, 'plugin-local', 'plugin', ACTOR)).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });
});

describe('kit resolution', () => {
    it('resolves the exact canonical set and approved wins over an experiment for the same asset', () => {
        const rows = [
            kitRow({ asset_id: 'skill-b', asset_kind: 'skill', asset_version: 2, asset_manifest: SHA2 }),
            kitRow({ asset_id: 'mcp-search', asset_kind: 'mcp', asset_version: 3, asset_manifest: SHA }),
            kitRow({
                agent_id: AGENT,
                asset_id: 'mcp-search',
                asset_kind: 'mcp',
                asset_version: 9,
                asset_manifest: SHA2,
                origin: 'experimental',
            }),
        ];
        expect(resolveKitRows(rows)).toEqual([
            { assetId: 'mcp-search', assetKind: 'mcp', version: 3, manifest: SHA, origin: 'approved' },
            { assetId: 'skill-b', assetKind: 'skill', version: 2, manifest: SHA2, origin: 'approved' },
        ]);
    });

    it('keeps an experiment when the same asset has no approved pin', () => {
        const rows = [
            kitRow({
                asset_id: 'plugin-local',
                asset_kind: 'plugin',
                asset_version: 1,
                asset_manifest: SHA2,
                origin: 'experimental',
            }),
        ];
        expect(resolveKitRows(rows)).toEqual([
            { assetId: 'plugin-local', assetKind: 'plugin', version: 1, manifest: SHA2, origin: 'experimental' },
        ]);
    });

    it('excludes expired and revoked experiments by query contract', () => {
        // The SQL contract is the lifetime gate; expired/revoked rows never reach resolution.
        expect(KIT_SQL).toMatch(/e\.expires_at>now\(\)/);
        expect(KIT_SQL).toMatch(/e\.revoked_at IS NULL/);
        // Approved pins are re-joined to the current confirmed project pin (exact version + manifest).
        expect(KIT_SQL).toMatch(/pa\.asset_version IS NOT NULL AND pa\.asset_manifest IS NOT NULL/);
    });

    it('groups kits per agent in one read and keeps agents without extensions absent', async () => {
        const rows = [kitRow({ agent_id: AGENT }), kitRow({ agent_id: 'agent-qa1', asset_id: 'mcp-qa' })];
        const kits = await agentExtensionKits(fakeDb(rows) as never, PROJECT);
        expect(kits.get(AGENT)).toHaveLength(1);
        expect(kits.get('agent-qa1')).toHaveLength(1);
        expect(kits.get('agent-nobody')).toBeUndefined();
    });
});

describe('assertExtensionInKit (fail-closed runtime gate)', () => {
    const kit: IAgentExtension[] = [
        { assetId: 'mcp-search', assetKind: 'mcp', version: 3, manifest: SHA, origin: 'approved' },
    ];
    it('allows the exact kit entry', () => {
        expect(
            assertExtensionInKit(kit, { assetId: 'mcp-search', assetKind: 'mcp', version: 3, manifest: SHA }),
        ).toEqual(kit[0]);
    });
    it('refuses a missing asset', () => {
        expect(() =>
            assertExtensionInKit(kit, { assetId: 'mcp-foreign', assetKind: 'mcp', version: 3, manifest: SHA }),
        ).toThrow(ConflictException);
    });
    it('refuses a drifted version', () => {
        expect(() =>
            assertExtensionInKit(kit, { assetId: 'mcp-search', assetKind: 'mcp', version: 4, manifest: SHA }),
        ).toThrow(ConflictException);
    });
    it('refuses a drifted manifest', () => {
        expect(() =>
            assertExtensionInKit(kit, { assetId: 'mcp-search', assetKind: 'mcp', version: 3, manifest: SHA2 }),
        ).toThrow(ConflictException);
    });
});

describe('withExtensionKits', () => {
    const entry: IAgentExtension = {
        assetId: 'mcp-search',
        assetKind: 'mcp',
        version: 3,
        manifest: SHA,
        origin: 'approved',
    };
    const agent = (id: string): IProjectAgent =>
        ({
            id,
            slug: 'nc-' + id,
            version: 1,
            enabled: true,
            description: '',
            prompt: '',
            mode: 'primary',
            permission: {},
        }) as unknown as IProjectAgent;

    it('attaches kits only to agents that have them and keeps other row references untouched', () => {
        const a = agent(AGENT);
        const b = agent('agent-qa1');
        const kits = new Map<string, IAgentExtension[]>([[AGENT, [entry]]]);
        const result = withExtensionKits([a, b], kits);
        expect(result[1]).toBe(b);
        expect(result[0]).not.toBe(a);
        expect(result[0]?.extensions).toEqual([entry]);
    });
    it('returns identical rows for an empty kit map (no spurious payload change)', () => {
        const a = agent(AGENT);
        const result = withExtensionKits([a], new Map());
        expect(result[0]).toBe(a);
    });
});

describe('agent audit contract', () => {
    it('exposes the experimental enable/revoke actions in the common journal', () => {
        expect(AGENT_AUDIT_ACTIONS).toContain('agent.extensions.experimental-enable');
        expect(AGENT_AUDIT_ACTIONS).toContain('agent.extensions.experimental-revoke');
    });
});

describe('resolveAgentExtensionKit', () => {
    it('resolves one agent kit through the shared kit read', async () => {
        const rows = [kitRow({ agent_id: AGENT }), kitRow({ agent_id: 'agent-qa1', asset_id: 'mcp-qa' })];
        const kit = await resolveAgentExtensionKit(fakeDb(rows) as never, PROJECT, 'agent-qa1');
        expect(kit).toEqual([{ assetId: 'mcp-qa', assetKind: 'mcp', version: 3, manifest: SHA, origin: 'approved' }]);
    });
});
