import { describe, expect, it, vi } from 'vitest';
import { collectRoleDiagnostic, composeContainerState } from '../src/system-roles/system-role.diagnostics';
const checkedAt = '2026-10-23T00:00:00.000Z', now = Date.parse(checkedAt), env = { SYSTEM_ROLE_COMPOSE_PROJECT: 'owned', SNAPSHOT_VERIFIER_IMAGE_DIGEST: 'sha256:' + 'a'.repeat(64) };
const report = { schema: 1, project: 'owned', checkedAt, available: true, items: [{ service: 'catalog', state: 'running', health: 'healthy' }] };
describe('Safe system role diagnostics', () => {
    it('requires a fresh authenticated runner observation with pinned image and exact configured Compose scope', async () => {
        const query = vi.fn(async () => ({ rows: [{ container_observation: report }] }));
        expect(await composeContainerState({ query } as never, env, now)).toMatchObject({ available: true, checkedAt, items: report.items });
        expect(query.mock.calls[0][1]).toEqual([env.SNAPSHOT_VERIFIER_IMAGE_DIGEST, 'owned']);
        expect(query.mock.calls[0][0]).toContain("last_seen>now()-interval '60 seconds'");
        expect(query.mock.calls[0][0]).toContain("container_observation->>'project'=$2");
    });
    it('marks stale, absent, future, invalid or unconfigured observations unavailable', async () => {
        const db = (value: unknown) => ({ query: vi.fn(async () => ({ rows: value === null ? [] : [{ container_observation: value }] })) });
        expect(await composeContainerState(db(report) as never, env, now + 60001)).toMatchObject({ available: false, reason: 'container-observation-stale', checkedAt });
        expect(await composeContainerState(db(report) as never, env, now - 6000)).toMatchObject({ available: false });
        expect(await composeContainerState(db(null) as never, env, now)).toMatchObject({ available: false, reason: 'container-runner-unavailable' });
        expect(await composeContainerState(db({ ...report, logs: 'private' }) as never, env, now)).toMatchObject({ available: false, reason: 'container-observation-invalid' });
        const missing = db(report); expect(await composeContainerState(missing as never, {}, now)).toMatchObject({ available: false, reason: 'container-inspector-not-configured' }); expect(missing.query).not.toHaveBeenCalled();
    });
    it('does not observe system containers from a project-scoped or nonmain run', async () => {
        const query = vi.fn();
        for (const context of [{ main: false, projectId: null }, { main: true, projectId: 'prj-one' }]) {
            const fact = await collectRoleDiagnostic('containers', { db: { query } as never, actor: 'user@example.test', ready: async () => undefined, ...context }, new AbortController().signal);
            expect(fact.status).toBe('unavailable'); expect(fact.data).toMatchObject({ available: false });
        }
        expect(query).not.toHaveBeenCalled();
    });
    it('does not turn liveness or an exception into measured readiness', async () => {
        const context = { db: {} as never, actor: 'user@example.test', projectId: null, main: true, ready: async () => { throw Error('password in raw cause'); } };
        const fact = await collectRoleDiagnostic('health', context, new AbortController().signal);
        expect(fact.status).toBe('unavailable'); expect(JSON.stringify(fact)).not.toContain('password');
    });
});
