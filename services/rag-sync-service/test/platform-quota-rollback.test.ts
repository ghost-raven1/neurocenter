import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { applyPlatformQuotaPolicy, platformQuotaPolicy } from '../src/rag/quota/platform-quota';
import { ownedQuotaRollbackUrl, quotaFaultPool, quotaRollbackFixture } from './platform-quota-rollback.fixture';

const connection = process.env.RAG_CONTRACT_TEST_PG_URL, fixtures: Array<Awaited<ReturnType<typeof quotaRollbackFixture>>> = [];
const cleanup: unknown[] = [], observations: unknown[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) cleanup.push(await fixture.dispose()); });
afterAll(async () => {
    if (process.env.RAG_QUOTA_ROLLBACK_EVIDENCE_FILE) await writeFile(process.env.RAG_QUOTA_ROLLBACK_EVIDENCE_FILE,
        JSON.stringify({ cleanup, observations }, null, 2) + '\n');
});

const policy = { defaultBytes: 150, maximumBytes: 300, expectedRevision: 0 };
const applied = { defaultBytes: 150, maximumBytes: 300, revision: 1, updatedAt: '2026-10-22T00:00:00.000Z', updatedBy: 'quota@test' };
const run = (pool: Pool, kind: 'policy' | 'applied') => kind === 'policy'
    ? platformQuotaPolicy(pool, policy, 'quota@test') : applyPlatformQuotaPolicy(pool, applied);
async function fixture() { const value = await quotaRollbackFixture(connection!); fixtures.push(value); return value; }
async function state(pool: Pool) {
    return { policy: (await pool.query('SELECT default_bytes,maximum_bytes,revision FROM rag_platform_quota_policy')).rows[0],
        applied: (await pool.query('SELECT default_bytes,maximum_bytes,revision FROM rag_platform_quota_applied')).rows[0],
        settings: (await pool.query('SELECT default_bytes,maximum_bytes FROM rag_storage_settings')).rows[0],
        events: Number((await pool.query('SELECT count(*) AS n FROM rag_platform_quota_events')).rows[0].n) };
}
async function nextBorrower(f: Awaited<ReturnType<typeof fixture>>) {
    const client = await f.pool.connect();
    try {
        const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        // On the old implementation this unrelated borrower commits the failed caller's still-open UPDATE.
        await client.query('COMMIT'); return pid;
    } finally { client.release(); }
}

it('rejects unowned PostgreSQL URLs and libpq overrides before fixture I/O', async () => {
    expect(ownedQuotaRollbackUrl('postgresql://qa:synthetic@127.0.0.1:59616/postgres').port).toBe('59616');
    for (const value of ['', 'not-url', 'file:///postgres', 'https://127.0.0.1:59616/postgres', 'postgresql://127.0.0.1/postgres',
        'postgresql://127.0.0.1:5432/postgres', 'postgresql://localhost:59616/postgres', 'postgresql://remote.invalid:59616/postgres',
        'postgresql://127.0.0.1:59616/application', 'postgresql://127.0.0.1:59616/postgres?host=127.0.0.1&port=5432',
        'postgresql://127.0.0.1:59616/postgres#fragment']) await expect(quotaRollbackFixture(value)).rejects.toThrow();
});

describe.skipIf(connection === undefined).sequential('Quota policy rollback ownership on real disposable PostgreSQL', () => {
    for (const kind of ['policy', 'applied'] as const) {
        it(kind + ': drops an unconfirmed rollback session instead of allowing another borrower to commit its failed update', async () => {
            const f = await fixture(), before = await state(f.observer), fault = quotaFaultPool(f.pool, kind, 'update', true);
            await expect(run(fault.pool, kind)).rejects.toBe(fault.failure); expect(fault.fired()).toBe(true);
            const beforeUnrelatedCommit = await state(f.observer), borrowedPid = await nextBorrower(f), after = await state(f.observer);
            observations.push({ kind, boundary: 'update', pid: fault.pid(), borrowedPid, before, beforeUnrelatedCommit, after, released: fault.release() });
            expect(beforeUnrelatedCommit).toEqual(before); expect(after).toEqual(before);
            expect(borrowedPid).not.toBe(fault.pid()); expect(fault.release()).toBe(true);
            expect(fault.sql).toContain('ROLLBACK');
        });
        it(kind + ': a confirmed rollback preserves the primary error and reuses its healthy backend', async () => {
            const f = await fixture(), before = await state(f.observer), fault = quotaFaultPool(f.pool, kind, 'update', false);
            await expect(run(fault.pool, kind)).rejects.toBe(fault.failure);
            const borrowedPid = await nextBorrower(f); expect(borrowedPid).toBe(fault.pid()); expect(await state(f.observer)).toEqual(before);
            expect(fault.release()).not.toBe(true); expect(fault.sql).toContain('ROLLBACK');
        });
        it(kind + ': a committed-but-lost ACK remains durable after discard and exact retry adds no duplicate audit', async () => {
            const f = await fixture(), fault = quotaFaultPool(f.pool, kind, 'commit', true);
            await expect(run(fault.pool, kind)).rejects.toBe(fault.failure); expect(fault.fired()).toBe(true);
            const committed = await state(f.observer), borrowedPid = await nextBorrower(f);
            expect(await state(f.observer)).toEqual(committed); expect(borrowedPid).not.toBe(fault.pid()); expect(fault.release()).toBe(true);
            await run(f.pool, kind); expect(await state(f.observer)).toEqual(committed);
            if (kind === 'policy') { expect(committed.policy).toEqual({ default_bytes: '150', maximum_bytes: '300', revision: '1' }); expect(committed.events).toBe(1); }
            else { expect(committed.applied).toEqual({ default_bytes: '150', maximum_bytes: '300', revision: '1' }); expect(committed.settings).toEqual({ default_bytes: '150', maximum_bytes: '300' }); }
            observations.push({ kind, boundary: 'commit', pid: fault.pid(), borrowedPid, committed, released: fault.release() });
        });
        it(kind + ': normal success commits the intended policy and retains a reusable connection', async () => {
            const f = await fixture(), fault = quotaFaultPool(f.pool, kind, 'none', false);
            await run(fault.pool, kind); const saved = await state(f.observer);
            expect(await nextBorrower(f)).toBe(fault.pid()); expect(fault.release()).not.toBe(true);
            expect(fault.sql).toContain('COMMIT'); expect(fault.sql).not.toContain('ROLLBACK');
            if (kind === 'policy') { expect(saved.policy).toEqual({ default_bytes: '150', maximum_bytes: '300', revision: '1' }); expect(saved.events).toBe(1); }
            else { expect(saved.applied).toEqual({ default_bytes: '150', maximum_bytes: '300', revision: '1' }); expect(saved.settings).toEqual({ default_bytes: '150', maximum_bytes: '300' }); }
        });
    }
});
