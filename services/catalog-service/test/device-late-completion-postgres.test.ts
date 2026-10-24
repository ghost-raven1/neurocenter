import { readFile, stat, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAGS } from '../../shared/feature-flags.cjs';
import { previousDeviceCompletions } from '../../../mcp/neurocenter-asset-sync/src/bridge/completions';
import { lateCompletionFixture } from './device-late-completion.fixture';

const adminUrl = process.env.DEVICE_LATE_COMPLETION_TEST_ADMIN_URL;
describe.skipIf(!adminUrl).sequential('Accepted bridge work: durable history differs from current authorization', () => {
    let fixture: Awaited<ReturnType<typeof lateCompletionFixture>>;
    const evidence: unknown[] = [];
    beforeAll(async () => {
        // Only flags/events and model execution are controlled; no model provider or working API is contacted.
        vi.stubGlobal('fetch', async () => Response.json({ flags: Object.fromEntries(FEATURE_FLAGS.map(flag => [flag.key, true])) }));
        fixture = await lateCompletionFixture(adminUrl!);
    }, 30000);
    afterAll(async () => {
        try {
            if (!fixture) return;
            const cleanup = await fixture.close();
            if (process.env.DEVICE_LATE_COMPLETION_TEST_RECEIPT) await writeFile(process.env.DEVICE_LATE_COMPLETION_TEST_RECEIPT,
                JSON.stringify({ evidence, cleanup, boundary: 'Actual migration schema, controller authentication, device authorization, SQL revocation and worker durable completion delivery; worker effect is a real synthetic committed file, not native LanceDB or model inference.' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
            expect(cleanup).toEqual({ dropped: true, originalDatabasesPreserved: true, newDatabasesRemaining: [] });
        } finally { vi.unstubAllGlobals(); }
    });
    async function unchanged(file: string, before: { bytes: Buffer; mtime: number }) {
        expect(await readFile(file)).toEqual(before.bytes); expect((await stat(file)).mtimeMs).toBe(before.mtime);
    }

    it('An expired lease reconciles its exact committed receipt once without executing the file effect again', async () => {
        const run = await fixture.begin(); expect((await run.embed()).data[0].embedding).toEqual([1, 2, 3]);
        const before = await run.commit(); await run.expire();
        expect(await run.job()).toMatchObject({ state: 'reconciling', lease: run.receipt.lease });
        await run.deliver(); expect(await run.pending()).toEqual([]);
        expect(await run.job()).toMatchObject({ state: 'succeeded', result: run.receipt.result });
        const journal = await run.journal(); expect(journal).toHaveLength(1); expect(journal[0].state).toBe('SUCCEEDED');
        expect(await run.complete()).toEqual({ ok: true, repeated: true }); expect(await run.journal()).toEqual(journal);
        expect((await run.grant()).revoked_at).toBeNull(); await unchanged(run.file, before);
        evidence.push({ scenario: 'expired-lease', historicalState: 'succeeded', replay: 'read-only receipt', grantRevoked: false, fileUnchanged: true });
    });

    it.each(['membership', 'binding'] as const)('A late receipt after %s revocation preserves history and bytes without reviving permission', async change => {
        const run = await fixture.begin(); await run.embed(); const calls = fixture.inferenceCalls(), before = await run.commit();
        if (change === 'membership') await run.revokeMembership(); else await run.rebind();
        await expect(run.authorize()).rejects.toMatchObject({ status: change === 'membership' ? 403 : 409 });
        await expect(run.embed()).rejects.toMatchObject({ status: change === 'membership' ? 403 : 409 });
        expect((await run.grant()).revoked_at).not.toBeNull();
        await run.deliver(); expect(await run.pending()).toEqual([]);
        expect(await run.job()).toMatchObject({ state: 'succeeded', result: run.receipt.result });
        const journal = await run.journal(); expect(journal).toHaveLength(1); expect(journal[0].state).toBe('SUCCEEDED');
        expect(await run.complete()).toEqual({ ok: true, repeated: true }); expect(await run.journal()).toEqual(journal);
        if (change === 'membership') {
            expect((await run.list()).some((job: { id: string }) => job.id === run.id)).toBe(false);
            await run.restoreMembership();
        } else await run.restoreBinding();
        // Recreating the former identity cannot resurrect an authorization revoked before the late ACK.
        await expect(run.embed()).rejects.toMatchObject({ status: 409 }); expect(fixture.inferenceCalls()).toBe(calls);
        expect((await run.grant()).revoked_at).not.toBeNull(); await unchanged(run.file, before);
        evidence.push({ scenario: change, historicalState: 'succeeded', freshAuthorizeDenied: true, grantRevokedAfterReplay: true, fileUnchanged: true });
    });

    it('A revoked device keeps its receipt pending; replacement credentials quarantine it while preserving committed bytes', async () => {
        const run = await fixture.begin(), before = await run.commit(); await run.revokeDevice();
        await expect(run.deliver()).rejects.toMatchObject({ status: 401 });
        expect(await run.pending()).toEqual([run.receipt]); expect(await run.job()).toMatchObject({ state: 'failed' });
        await run.replaceCredentials(); await run.deliver();
        expect(await run.pending()).toEqual([]); expect(await previousDeviceCompletions()).toBe(1);
        expect(await run.job()).toMatchObject({ state: 'failed' }); expect((await run.grant()).revoked_at).not.toBeNull();
        await unchanged(run.file, before);
        evidence.push({ scenario: 'device-replacement', historicalState: 'failed', refusedStatus: 401, pendingThenQuarantined: true, fileUnchanged: true });
    });
});
