import { describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
    C2_INTERIM_TARGET_MS,
    firstUsefulChatAt,
    measureFirstUsefulOperation,
    persistAgentOnboarding,
    readAgentOnboarding,
    resolveAgentOnboarding,
} from '../agent-onboarding';
import { ProjectAgentRepository } from '../project-agent.repository';
import { agentManifest } from '../agent-validation';
import type { IProjectAgentAssignment } from '../agent.interfaces';
import { AGENT_AUDIT_ACTIONS } from '../agent-audit';
import type { IAgentDefinition, IAgentExtension } from '../../../../shared/project-agents.cjs';

const SHA = 'a'.repeat(64);
const KIT_SHA = 'b'.repeat(64);
const PROJECT = 'prj-1';
const AGENT = 'agent-dev1';
const SLUG = 'nc-dev';
const NAME = 'Dev Agent';
const ACTOR = 'admin@example.test';
const REQUEST_KEY = '11111111-2222-4333-8444-555555555555';
const EXPECTED_REVISION = 0;
const HYPOTHESIS = '11111111-2222-4333-8444-555555555555';
const CHECK = '22222222-2222-4333-8444-555555555555';
const definition: IAgentDefinition = {
    description: 'Dev agent',
    prompt: 'Do tasks',
    mode: 'primary',
    permission: { read: 'allow' },
};
const MANIFEST = agentManifest({ id: AGENT, slug: SLUG, name: NAME, definition, version: 1 });

interface IRecorded {
    sql: string;
    params: unknown[];
}
type TDb = Pick<PoolClient, 'query'>;
/** Fake PoolClient routed by SQL shape; handler returns rows or undefined for the empty default. */
function queryDb(handler?: (sql: string, params: unknown[]) => { rows: unknown[] } | undefined) {
    const recorded: IRecorded[] = [];
    const db = {
        query: async (sql: string, params: unknown[] = []) => {
            recorded.push({ sql, params });
            return handler?.(sql, params) ?? { rows: [] };
        },
    } as unknown as TDb;
    return { db, recorded };
}

const learningCandidate = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
    id: '33333333-3333-4333-8444-555555555555',
    project_id: PROJECT,
    data: { kind: 'lesson', title: 'Урок', content: 'Содержание', ...data },
    created_by: ACTOR,
    created_at: new Date(),
    revision: '1',
    hypothesis_id: HYPOTHESIS,
    check_id: CHECK,
    key: 'ctx-1',
    version: 1,
    status: 'approved',
    active: true,
    approved_by: ACTOR,
    approved_at: new Date(),
    reason: null,
    ...overrides,
});
const kitRow = (overrides: Record<string, unknown> = {}) => ({
    agent_id: AGENT,
    asset_id: 'mcp-search',
    asset_kind: 'mcp',
    asset_version: 3,
    asset_manifest: KIT_SHA,
    origin: 'approved',
    ...overrides,
});
const kitEntry: IAgentExtension = {
    assetId: 'mcp-search',
    assetKind: 'mcp',
    version: 3,
    manifest: KIT_SHA,
    origin: 'approved',
};
/** Router for the onboarding read path: kit, learning heads, learning revision. */
function onboardingDb({ learningRows = [], kitRows = [] }: { learningRows?: unknown[]; kitRows?: unknown[] }) {
    const { db, recorded } = queryDb((sql) => {
        if (/agent_extension_experiments/.test(sql)) return { rows: kitRows };
        if (/FROM project_learning_heads/.test(sql)) return { rows: learningRows };
        if (/FROM project_learning_state/.test(sql)) return { rows: [{ revision: '5' }] };
        return undefined;
    });
    return { db, recorded };
}
type TAssignment = Pick<IProjectAgentAssignment, 'effective' | 'enabled' | 'removed'>;
const assignment = (overrides: Partial<TAssignment> = {}): TAssignment => ({
    effective: definition,
    enabled: true,
    removed: false,
    ...overrides,
});

describe('resolveAgentOnboarding (FR-307 self-configured settings)', () => {
    it('resolves role from the pinned card, empty context, no tools and active public chat', async () => {
        const { db } = onboardingDb({});
        const config = await resolveAgentOnboarding(db, {} as Pool, PROJECT, AGENT, assignment());
        expect(config.role).toBe('primary');
        expect(config.roleSource).toBe('pinned-card');
        expect(config.context).toEqual({ status: 'empty', digest: null, revision: 5, entries: 0 });
        expect(config.tools).toEqual({ count: 0, extensions: [] });
        expect(config.publicChat).toEqual({ enabled: true, status: 'active' });
    });

    it('includes only approved entries into the agent-scoped context and digests the scoped bundle', async () => {
        const { db } = onboardingDb({ learningRows: [learningCandidate()] });
        const config = await resolveAgentOnboarding(db, {} as Pool, PROJECT, AGENT, assignment());
        expect(config.context.status).toBe('approved');
        expect(config.context.entries).toBe(1);
        expect(config.context.revision).toBe(5);
        expect(config.context.digest).toMatch(/^[a-f0-9]{64}$/);
    });

    it('scopes the context to the agent: entries targeting another agent do not enter this agent digest', async () => {
        const { db } = onboardingDb({
            learningRows: [learningCandidate({}, { targetAgentId: 'agent-other' })],
        });
        const config = await resolveAgentOnboarding(db, {} as Pool, PROJECT, AGENT, assignment());
        expect(config.context.status).toBe('empty');
    });

    it('marks the context blocked when an active candidate lacks a valid approval', async () => {
        const { db } = onboardingDb({ learningRows: [learningCandidate({ status: 'proposed', approved_at: null })] });
        const config = await resolveAgentOnboarding(db, {} as Pool, PROJECT, AGENT, assignment());
        expect(config.context).toEqual({ status: 'blocked', digest: null, revision: null, entries: 0 });
    });

    it('consumes the agt-08 kit as the tool profile', async () => {
        const { db } = onboardingDb({ kitRows: [kitRow()] });
        const config = await resolveAgentOnboarding(db, {} as Pool, PROJECT, AGENT, assignment());
        expect(config.tools).toEqual({ count: 1, extensions: [kitEntry] });
    });

    it('reports disabled public chat when the assignment is not enabled', async () => {
        const { db } = onboardingDb({});
        const config = await resolveAgentOnboarding(db, {} as Pool, PROJECT, AGENT, assignment({ enabled: false }));
        expect(config.publicChat).toEqual({ enabled: false, status: 'disabled' });
    });
});

describe('persistAgentOnboarding', () => {
    it('writes the snapshot with ON CONFLICT DO NOTHING so the first onboarding stays the C2 t0 anchor', async () => {
        const { db, recorded } = onboardingDb({});
        const config = await resolveAgentOnboarding(db, {} as Pool, PROJECT, AGENT, assignment());
        await persistAgentOnboarding(
            db,
            PROJECT,
            AGENT,
            { version: 1, manifest: MANIFEST, enabled: true, removed: false },
            config,
            ACTOR,
        );
        const insert = recorded.find((row) => /INSERT INTO agent_onboarding/.test(row.sql));
        expect(insert).toBeTruthy();
        expect(insert!.sql).toMatch(/ON CONFLICT\(project_id,agent_id\) DO NOTHING/);
        const params = insert!.params;
        expect(params[0]).toBe(PROJECT);
        expect(params[1]).toBe(AGENT);
        expect(params[2]).toBe(1);
        expect(params[3]).toBe(MANIFEST);
        expect(params[4]).toBe('primary');
        expect(params[5]).toBe('pinned-card');
        expect(params[6]).toBe('empty');
        expect(params[7]).toBe(null);
        expect(params[8]).toBe(5);
        expect(params[9]).toBe(0);
        expect(params[10]).toBe(0);
        expect(params[11]).toBe('[]');
        expect(params[12]).toBe(true);
        expect(params[13]).toBe('active');
        expect(params[14]).toBe(ACTOR);
    });
});

describe('readAgentOnboarding', () => {
    it('maps the stored row to the API record', async () => {
        const row = {
            project_id: PROJECT,
            agent_id: AGENT,
            agent_version: 1,
            agent_manifest: MANIFEST,
            role: 'primary',
            role_source: 'pinned-card',
            context_status: 'empty',
            context_digest: null,
            context_revision: 5,
            context_entries: 0,
            tools_count: 0,
            tools: [],
            public_chat_enabled: true,
            public_chat_status: 'active',
            onboarded_at: new Date('2026-01-01T00:00:00Z'),
            added_by: ACTOR,
        };
        const { db } = queryDb((sql) => (/FROM agent_onboarding/.test(sql) ? { rows: [row] } : undefined));
        const record = await readAgentOnboarding(db, PROJECT, AGENT);
        expect(record).toEqual({
            projectId: PROJECT,
            agentId: AGENT,
            agentVersion: 1,
            agentManifest: MANIFEST,
            role: 'primary',
            roleSource: 'pinned-card',
            context: { status: 'empty', digest: null, revision: 5, entries: 0 },
            tools: { count: 0, extensions: [] },
            publicChat: { enabled: true, status: 'active' },
            onboardedAt: '2026-01-01T00:00:00.000Z',
            addedBy: ACTOR,
        });
    });

    it('returns null when the agent was never onboarded', async () => {
        const { db } = queryDb();
        expect(await readAgentOnboarding(db, PROJECT, AGENT)).toBeNull();
    });
});

describe('firstUsefulChatAt (C2 t1)', () => {
    it('reads the first completed project-chat response without writing anything', async () => {
        const at = new Date('2026-01-01T00:04:00Z');
        const { db, recorded } = queryDb((sql) =>
            /model_chat_agent_responses/.test(sql) ? { rows: [{ first_useful_at: at }] } : undefined,
        );
        expect(await firstUsefulChatAt(db, PROJECT, AGENT)).toEqual(at);
        expect(recorded.every((row) => /SELECT/.test(row.sql))).toBe(true);
        expect(recorded[0].sql).toMatch(/MIN\(r\.updated_at\)/);
        expect(recorded[0].sql).toMatch(/r\.status='done'/);
        expect(recorded[0].sql).toMatch(/c\.project_id=\$1/);
    });

    it('is null while no completed response exists', async () => {
        const { db } = queryDb();
        expect(await firstUsefulChatAt(db, PROJECT, AGENT)).toBeNull();
    });
});

describe('measureFirstUsefulOperation (C2, OQ-1 interim target 5 minutes)', () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    it('is within target at 4 minutes', () => {
        const result = measureFirstUsefulOperation(t0, new Date('2026-01-01T00:04:00Z'));
        expect(result).toEqual({
            onboardedAt: t0.toISOString(),
            firstUsefulAt: '2026-01-01T00:04:00.000Z',
            deltaMs: 4 * 60 * 1000,
            withinTarget: true,
            targetMs: C2_INTERIM_TARGET_MS,
        });
    });
    it('is over target at 6 minutes', () => {
        const result = measureFirstUsefulOperation(t0, new Date('2026-01-01T00:06:00Z'));
        expect(result.deltaMs).toBe(6 * 60 * 1000);
        expect(result.withinTarget).toBe(false);
    });
    it('stays unresolved (null) until the first useful operation happens', () => {
        const result = measureFirstUsefulOperation(t0, null);
        expect(result.firstUsefulAt).toBeNull();
        expect(result.deltaMs).toBeNull();
        expect(result.withinTarget).toBeNull();
        expect(result.targetMs).toBe(C2_INTERIM_TARGET_MS);
    });
    it('never reports within target for a negative delta (clock anomaly)', () => {
        const result = measureFirstUsefulOperation(new Date('2026-01-01T00:05:00Z'), new Date('2026-01-01T00:04:00Z'));
        expect(result.deltaMs).toBe(-60 * 1000);
        expect(result.withinTarget).toBe(false);
    });
    it('accepts the exact interim boundary', () => {
        const result = measureFirstUsefulOperation(t0, new Date('2026-01-01T00:05:00Z'));
        expect(result.deltaMs).toBe(C2_INTERIM_TARGET_MS);
        expect(result.withinTarget).toBe(true);
    });
});

describe('assign() self-onboarding integration (zero operator steps)', () => {
    const headRow = {
        id: AGENT,
        slug: SLUG,
        name: NAME,
        definition,
        version: 1,
        manifest: MANIFEST,
        archived_at: null,
        created_at: new Date(),
        updated_at: new Date(),
    };
    const cardRow = { ...headRow, archived_at: null };
    const assignedRow = {
        project_id: PROJECT,
        agent_id: AGENT,
        version: 1,
        manifest: MANIFEST,
        overrides: {},
        enabled: true,
        removed: false,
    };
    const snapshotItem = {
        id: AGENT,
        slug: SLUG,
        name: NAME,
        version: 1,
        manifest: MANIFEST,
        definition,
        overrides: {},
        enabled: true,
    };
    /** Full assign() transaction routed by SQL shape; the project_agents select is stateful (old check, then saved row). */
    function assignPool(overrides: { learningRows?: unknown[]; kitRows?: unknown[] } = {}) {
        const { learningRows = [], kitRows = [] } = overrides;
        const recorded: IRecorded[] = [];
        let projectAgentSelects = 0;
        const client = {
            query: async (sql: string, params: unknown[] = []) => {
                recorded.push({ sql, params });
                if (/^BEGIN/.test(sql.trim())) return { rows: [] };
                if (/^(COMMIT|ROLLBACK)/.test(sql.trim())) return { rows: [] };
                if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
                if (/FROM platform_users/.test(sql)) return { rows: [{ enabled: true, is_main_admin: false }] };
                if (/FROM project_members/.test(sql)) return { rows: [{ role: 'Админ проекта' }] };
                if (/SELECT request_hash,result FROM agent_mutation_requests/.test(sql)) return { rows: [] };
                if (/INSERT INTO project_agent_sets/.test(sql)) return { rows: [] };
                if (/SELECT revision FROM project_agent_sets WHERE project_id=\$1 FOR UPDATE/.test(sql))
                    return { rows: [{ revision: EXPECTED_REVISION }] };
                if (/SELECT \* FROM agent_catalog WHERE id=/.test(sql)) return { rows: [headRow] };
                if (/FROM agent_catalog_versions v WHERE/.test(sql)) return { rows: [cardRow] };
                if (/SELECT \* FROM project_agents WHERE project_id=\$1 AND agent_id=/.test(sql)) {
                    projectAgentSelects += 1;
                    return { rows: projectAgentSelects === 1 ? [] : [assignedRow] };
                }
                if (/INSERT INTO project_agents/.test(sql)) return { rows: [] };
                if (/UPDATE project_agent_sets SET revision=revision\+1/.test(sql))
                    return { rows: [{ revision: EXPECTED_REVISION + 1 }] };
                if (/SELECT s\.revision/.test(sql))
                    return { rows: [{ revision: EXPECTED_REVISION + 1, items: [snapshotItem] }] };
                if (/agent_extension_experiments/.test(sql)) return { rows: kitRows };
                if (/FROM project_learning_heads/.test(sql)) return { rows: learningRows };
                if (/FROM project_learning_state/.test(sql)) return { rows: [{ revision: '5' }] };
                if (/INSERT INTO agent_onboarding/.test(sql)) return { rows: [] };
                if (/INSERT INTO security_events/.test(sql)) return { rows: [] };
                if (/INSERT INTO agent_mutation_requests/.test(sql)) return { rows: [] };
                return { rows: [] };
            },
            release: () => {},
        };
        const pool = { connect: async () => client } as unknown as Pool;
        return { pool, recorded };
    }
    const actor = { email: ACTOR, activeRole: 'Админ проекта' };
    const raw = {
        requestKey: REQUEST_KEY,
        expectedRevision: EXPECTED_REVISION,
        agentId: AGENT,
        version: 1,
        manifest: MANIFEST,
    };

    it('auto-enables the agent, records the onboarding snapshot (t0) and leaves both audit rows in one transaction', async () => {
        const { pool, recorded } = assignPool();
        const result = await new ProjectAgentRepository(pool).assign(actor, PROJECT, raw);
        expect(result.revision).toBe(EXPECTED_REVISION + 1);
        expect(result.assignment.enabled).toBe(true);
        expect(result.assignment.removed).toBe(false);
        // The assignment write itself enables the agent — no separate operator step.
        const insertAssignment = recorded.find((row) => /INSERT INTO project_agents/.test(row.sql));
        expect(insertAssignment).toBeTruthy();
        expect(insertAssignment!.sql).toContain('enabled');
        expect(insertAssignment!.params).toEqual([PROJECT, AGENT, 1, MANIFEST, ACTOR]);
        // Onboarding snapshot (C2 t0) is written in the same transaction.
        const insertOnboarding = recorded.find((row) => /INSERT INTO agent_onboarding/.test(row.sql));
        expect(insertOnboarding).toBeTruthy();
        expect(insertOnboarding!.params[4]).toBe('primary');
        expect(insertOnboarding!.params[5]).toBe('pinned-card');
        expect(insertOnboarding!.params[6]).toBe('empty');
        expect(insertOnboarding!.params[12]).toBe(true);
        expect(insertOnboarding!.params[13]).toBe('active');
        // Audit: assign + onboard.
        const audits = recorded.filter((row) => /INSERT INTO security_events/.test(row.sql));
        expect(audits).toHaveLength(2);
        expect(audits.map((row) => row.params[2]).sort()).toEqual(['project.agent.assign', 'project.agent.onboard']);
        expect(recorded[recorded.length - 1].sql).toBe('COMMIT');
    });

    it('captures the approved learning context and the kit in the onboarding snapshot', async () => {
        const { pool, recorded } = assignPool({ learningRows: [learningCandidate()], kitRows: [kitRow()] });
        await new ProjectAgentRepository(pool).assign(actor, PROJECT, raw);
        const insertOnboarding = recorded.find((row) => /INSERT INTO agent_onboarding/.test(row.sql));
        expect(insertOnboarding!.params[6]).toBe('approved');
        expect(insertOnboarding!.params[7]).toMatch(/^[a-f0-9]{64}$/);
        expect(insertOnboarding!.params[9]).toBe(1);
        expect(insertOnboarding!.params[10]).toBe(1);
        expect(JSON.parse(insertOnboarding!.params[11] as string)).toEqual([kitEntry]);
        const onboardAudit = recorded.find(
            (row) => /INSERT INTO security_events/.test(row.sql) && row.params[2] === 'project.agent.onboard',
        );
        const after = JSON.parse(onboardAudit!.params[5] as string);
        expect(after.contextStatus).toBe('approved');
        expect(after.contextEntries).toBe(1);
        expect(after.toolsCount).toBe(1);
        expect(after.publicChatEnabled).toBe(true);
    });
});

describe('agent audit contract (FR-307)', () => {
    it('exposes the onboarding action in the common journal', () => {
        expect(AGENT_AUDIT_ACTIONS).toContain('project.agent.onboard');
    });
});
