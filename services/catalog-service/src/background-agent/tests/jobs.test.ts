import { beforeEach, describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AGENT_METHOD_VERSIONS } from '../../../../shared/agent-method-workflow.cjs';
import {
    BACKGROUND_AGENT_OPENCODE_VERSION,
    BACKGROUND_AGENT_WORKFLOW_JOB,
    backgroundAgentJobPayload,
    assertBackgroundAgentJob,
    assertBackgroundAgentCompletionAccess,
    type IBackgroundAgentJobRow,
} from '../jobs';

const REQUEST_KEY = '11111111-1111-4111-8111-111111111111';
const okCheck = { command: 'node', args: ['-e', 'process.exit(0)'] };
const input = (overrides: Record<string, unknown> = {}) =>
    ({
        requestKey: REQUEST_KEY,
        projectId: 'prj-bg',
        method: 'openspec',
        instruction: 'Фоновая задача',
        checks: [okCheck],
        ...overrides,
    }) as Parameters<typeof backgroundAgentJobPayload>[0];

describe('background-agent job machine (FR-305 phase B: kind, admission, completion access)', () => {
    it('exports the job-machine kind and the single pinned OpenCode version (OQ-2)', () => {
        expect(BACKGROUND_AGENT_WORKFLOW_JOB).toBe('run-background-agent-workflow');
        expect(BACKGROUND_AGENT_OPENCODE_VERSION).toBe('1.14.48');
    });

    it('admission pins the immutable task: server-fixed version, deadline and ids', () => {
        const before = Date.now();
        const payload = backgroundAgentJobPayload(input());
        const after = Date.now();
        expect(payload.protocol).toBe('background-agent-v1');
        expect(payload.workflowId).toBe(REQUEST_KEY);
        expect(payload.requestId).toBe(REQUEST_KEY);
        expect(payload.projectId).toBe('prj-bg');
        // The method version is the server-fixed one, never a client value.
        expect(payload.methodVersion).toBe(AGENT_METHOD_VERSIONS.openspec);
        expect(payload.runtime).toBe('opencode');
        // The deadline is fixed by the server: now + 30 minutes (agent-method pattern).
        const deadline = Date.parse(payload.deadlineAt);
        expect(deadline).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
        expect(deadline).toBeLessThanOrEqual(after + 30 * 60 * 1000);
        expect(payload.checks).toEqual([okCheck]);
    });

    it('admission keeps optional context and passes it through the shared contract', () => {
        const payload = backgroundAgentJobPayload(input({ context: { project: {}, web: {} } }));
        expect(payload.context).toEqual({ project: {}, web: {} });
    });

    it('admission refuses unknown input fields, unknown methods and malformed tasks (BadRequest)', () => {
        expect(() => backgroundAgentJobPayload(input({ runtime: 'opencode' }))).toThrow(BadRequestException);
        expect(() => backgroundAgentJobPayload(input({ projectId: '' }))).toThrow(BadRequestException);
        expect(() => backgroundAgentJobPayload(input({ checks: [{ command: 'bad command', args: [] }] }))).toThrow(
            BadRequestException,
        );
        expect(() => backgroundAgentJobPayload(input({ method: 'unknown-method' }))).toThrow(BadRequestException);
        expect(() => backgroundAgentJobPayload(input({ requestKey: 'not-a-uuid' }))).toThrow(BadRequestException);
        expect(() => backgroundAgentJobPayload(input({ instruction: '' }))).toThrow(BadRequestException);
    });

    it('claim rechecks the stored payload: kind, immutability and owning project', () => {
        const payload = backgroundAgentJobPayload(input());
        const row = (): IBackgroundAgentJobRow => ({
            kind: BACKGROUND_AGENT_WORKFLOW_JOB,
            payload,
            project_id: 'prj-bg',
            email: 'owner@example.com',
            role: 'Админ проекта',
        });
        expect(assertBackgroundAgentJob(row())).toEqual(payload);
        // Another kind is not this machine's row.
        expect(assertBackgroundAgentJob({ ...row(), kind: 'other-job' })).toBeUndefined();
        // A row recorded for another project cannot be claimed here.
        expect(() => assertBackgroundAgentJob({ ...row(), project_id: 'prj-other' })).toThrow(ConflictException);
        // A tampered payload (client method version) fails re-normalization.
        const tampered = { ...payload, methodVersion: '9.9.9' };
        expect(() => assertBackgroundAgentJob({ ...row(), payload: tampered })).toThrow(ConflictException);
    });

    describe('completion access (late success cannot outlive the grant)', () => {
        let rows: Array<{ sql: string; params: unknown[] }>;
        let data: Record<string, unknown[]>;
        const db = () =>
            ({
                query: async (sql: string, params: unknown[]) => {
                    rows.push({ sql, params });
                    return { rows: data[sql] ?? [] };
                },
            }) as unknown as PoolClient;
        const job = { project_id: 'prj-bg', email: 'owner@example.com', role: 'Админ проекта' };
        const USER_SQL = 'SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE';
        const GRANT_SQL = 'SELECT role FROM project_members WHERE project_id=$1 AND lower(principal_name)=$2 FOR SHARE';

        beforeEach(() => {
            rows = [];
            data = {};
        });

        const seed = (enabled: boolean, is_main_admin: boolean, grantRole: string | null) => {
            data[USER_SQL] = [{ enabled, is_main_admin }];
            data[GRANT_SQL] = grantRole ? [{ role: grantRole }] : [];
        };

        it('allows an enabled owner whose project grant still matches the recorded role', async () => {
            seed(true, false, 'Админ проекта');
            await expect(assertBackgroundAgentCompletionAccess(db(), job)).resolves.toBeUndefined();
            expect(rows.map((row) => row.sql)).toEqual([USER_SQL, GRANT_SQL]);
            expect(rows[0].params).toEqual(['owner@example.com']);
            expect(rows[1].params).toEqual(['prj-bg', 'owner@example.com']);
        });

        it('allows a main admin by the platform flag (grant row not required)', async () => {
            seed(true, true, null);
            await expect(
                assertBackgroundAgentCompletionAccess(db(), { ...job, role: 'Главный админ' }),
            ).resolves.toBeUndefined();
        });

        it('refuses a disabled owner, a stripped grant and a main-admin flag that is not set', async () => {
            seed(false, true, 'Админ проекта');
            await expect(assertBackgroundAgentCompletionAccess(db(), job)).rejects.toThrow(ForbiddenException);
            seed(true, false, null);
            await expect(assertBackgroundAgentCompletionAccess(db(), job)).rejects.toThrow(ForbiddenException);
            seed(true, false, null);
            await expect(
                assertBackgroundAgentCompletionAccess(db(), { ...job, role: 'Главный админ' }),
            ).rejects.toThrow(ForbiddenException);
        });

        it('refuses a missing user row outright', async () => {
            data[USER_SQL] = [];
            await expect(assertBackgroundAgentCompletionAccess(db(), job)).rejects.toThrow(ForbiddenException);
        });
    });
});
