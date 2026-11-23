import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotCommands } from '../snapshot-commands';
import { SnapshotRepository } from '../snapshot-repository';
import { snapshotManifestHash } from '../../../../shared/project-snapshot.cjs';
import type { ISnapshotRow } from '../snapshot-interfaces';

const projectId = '12345678-123456-4234-8234-123456789abc';
const snapshotId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const commandKey = '12345678-1234-4234-8234-123456789abc';
const actor = { email: 'owner@example.test', activeRole: 'Главный админ' };
const STAGING_EXCEEDED =
    'Лимит объёма подготовки проекта превышен. Операция не начата. Обратитесь к администратору.';

const sha = (seed: string) => createHash('sha256').update(seed).digest('hex');
/** Валидная опись полного снимка: один файл 100 байт → in-flight объём публикации = 100. */
const manifestInput = {
    format: 'neurocenter.lancedb-snapshot',
    schemaVersion: 1,
    sdkVersion: '0.29.0',
    tables: [{ name: 'items', version: 1, rows: 2, schemaSha256: sha('schema') }],
    files: [{ path: 'items.lance/data.lance', size: 100, sha256: sha('file'), chunks: [{ sha256: sha('chunk'), size: 100 }] }],
};
const expectedHash = snapshotManifestHash(manifestInput);

const UPDATE_MANIFEST = 'UPDATE project_snapshots SET manifest=$2,manifest_sha256=$3,total_bytes=$4 WHERE id=$1';
const USAGE_INSERT =
    'INSERT INTO project_quota_usage(project_id,dimension,used_bytes) VALUES($1,$2,GREATEST(0,$3)) ON CONFLICT(project_id,dimension) DO UPDATE SET used_bytes=GREATEST(0,project_quota_usage.used_bytes+$3),updated_at=clock_timestamp()';
const STAGING_USAGE_READ = "SELECT used_bytes FROM project_quota_usage WHERE project_id=$1 AND dimension='staging'";

interface IState {
    project: Record<string, unknown>;
    snapshot: ISnapshotRow;
    usage: Record<string, string>;
    receipts: Map<string, string>;
    calls: string[];
    committed: number;
    rolledBack: number;
}

const makeState = (quota: unknown): IState => ({
    project: {
        id: projectId,
        quota,
        retention: '10',
        head_snapshot_id: null,
        head_revision: '0',
        active_profile_id: null,
        active_profile_revision: '0',
    },
    snapshot: {
        id: snapshotId,
        project_id: projectId,
        email: actor.email,
        role: 'Главный админ',
        device_id: 'device-1',
        binding_id: 'b'.repeat(64),
        parent_id: null,
        expected_head_id: null,
        expected_head_revision: '0',
        status: 'UPLOADING',
        manifest: null,
        manifest_sha256: null,
        signature: null,
        total_bytes: '0',
        job_id: null,
        upload_completed_at: null,
        created_at: new Date('2026-11-01T00:00:00Z'),
        verified_at: null,
        error: null,
    },
    usage: {},
    receipts: new Map(),
    calls: [],
    committed: 0,
    rolledBack: 0,
});

/** Мини-ledger project_quota_usage + снапшоты проектов на месте PostgreSQL. */
const makeRepository = (state: IState) => {
    const norm = (sql: string) => String(sql).replace(/\s+/g, ' ').trim();
    const usageRow = (dimension: string) => {
        const value = state.usage[dimension];
        return value === undefined ? [] : [{ used_bytes: value }];
    };
    const query = async (sql: string, args: unknown[] = []) => {
        const s = norm(sql);
        state.calls.push(s);
        if (s === 'BEGIN') return { rows: [] };
        if (s === 'COMMIT') {
            state.committed++;
            return { rows: [] };
        }
        if (s === 'ROLLBACK') {
            state.rolledBack++;
            return { rows: [] };
        }
        if (s === "SELECT pg_advisory_xact_lock_shared(hashtextextended('neurocenter:snapshot-signing-identity',0))") return { rows: [] };
        if (s === 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))') return { rows: [] };
        if (s === 'SELECT * FROM projects WHERE id=$1 FOR UPDATE') return { rows: [state.project], rowCount: 1 };
        if (s === 'SELECT is_main_admin,enabled FROM platform_users WHERE email=$1 FOR SHARE') return { rows: [{ is_main_admin: true, enabled: true }] };
        if (s === 'SELECT 1 FROM projects WHERE id=$1') return { rows: [{}], rowCount: 1 };
        if (s === 'SELECT * FROM project_snapshots WHERE project_id=$1 AND id=$2 FOR UPDATE') return { rows: [state.snapshot], rowCount: 1 };
        if (s === "SELECT COALESCE(sum(total_bytes),0)::text AS bytes FROM project_snapshots WHERE project_id=$1 AND id<>$2 AND status<>'DELETED'") return { rows: [{ bytes: '0' }] };
        if (s === STAGING_USAGE_READ) return { rows: usageRow('staging'), rowCount: usageRow('staging').length };
        if (s === UPDATE_MANIFEST) {
            state.snapshot.manifest = JSON.parse(String(args[1]));
            state.snapshot.manifest_sha256 = String(args[2]);
            state.snapshot.total_bytes = String(args[3]);
            return { rows: [{ id: args[0] }] };
        }
        if (s.startsWith('INSERT INTO project_snapshot_blob_refs')) return { rows: [] };
        if (s === 'INSERT INTO project_quota_usage_requests(project_id,dimension,request_key,delta_bytes) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,dimension,request_key) DO NOTHING') {
            const [, dimension, requestKey, deltaBytes] = args as [string, string, string, number];
            const key = dimension + ':' + requestKey;
            if (state.receipts.has(key)) return { rows: [], rowCount: 0 };
            state.receipts.set(key, String(deltaBytes));
            return { rows: [], rowCount: 1 };
        }
        if (s === 'SELECT used_bytes FROM project_quota_usage WHERE project_id=$1 AND dimension=$2 FOR UPDATE') {
            const rows = usageRow(String(args[1]));
            return { rows, rowCount: rows.length };
        }
        if (s === USAGE_INSERT) {
            const [, dimension, deltaBytes] = args as [string, string, number];
            const next = BigInt(state.usage[dimension] ?? '0') + BigInt(deltaBytes);
            state.usage[dimension] = String(next < 0n ? 0n : next);
            return { rows: [] };
        }
        if (s === 'SELECT used_bytes FROM project_quota_usage WHERE project_id=$1 AND dimension=$2') {
            const rows = usageRow(String(args[1]));
            return { rows, rowCount: rows.length };
        }
        if (s.startsWith('SELECT r.sha256,r.bytes::float8 AS size FROM project_snapshot_blob_refs')) return { rows: [] };
        if (s === 'SELECT * FROM project_snapshots WHERE id=$1') return { rows: [state.snapshot], rowCount: 1 };
        if (s === "UPDATE project_snapshots SET status='VERIFIED',signature=$3,verified_at=now(),verifier_owner=NULL,verifier_lease_until=NULL WHERE id=$1 AND status='VERIFYING' AND verifier_owner=$2 AND verifier_lease_until>now() RETURNING id") {
            if (state.snapshot.status === 'VERIFYING') {
                state.snapshot.status = 'VERIFIED';
                return { rows: [{ id: args[0] }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }
        if (s.startsWith('INSERT INTO security_events')) return { rows: [] };
        if (s === 'SELECT 1 FROM project_snapshot_cancelled_commands WHERE email=$1 AND request_key=$2') return { rows: [], rowCount: 0 };
        if (s === 'SELECT request_hash,result FROM project_snapshot_commands WHERE email=$1 AND request_key=$2') return { rows: [], rowCount: 0 };
        if (s === "UPDATE project_snapshots SET status='REJECTED',error='Публикация отменена пользователем.',verifier_owner=NULL,verifier_lease_until=NULL WHERE id=$1") {
            state.snapshot.status = 'REJECTED';
            return { rows: [{ id: args[0] }], rowCount: 1 };
        }
        if (s.startsWith('INSERT INTO project_snapshot_commands')) return { rows: [] };
        throw new Error('Непредвиденный SQL: ' + s);
    };
    const pool = {
        query: vi.fn(query),
        connect: vi.fn(async () => ({ query: vi.fn(query), release: vi.fn() })),
    };
    return { pool, repository: new SnapshotRepository(pool as never) };
};

const expectQuotaError = async (promise: Promise<unknown>, statusCode: number, message: string): Promise<void> => {
    const error = await promise.catch((value) => value);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(statusCode);
    expect((error as HttpException).message).toBe(message);
};

describe('SnapshotRepository.beginManifest: enforcement stagingBytesLimit (AD-D4, OQ-1)', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('сверх stagingBytesLimit — 507, опись не закреплена, кредита нет, транзакция откатана', async () => {
        const state = makeState(JSON.stringify({ stagingBytesLimit: 50 }));
        const { repository } = makeRepository(state);
        await expectQuotaError(repository.beginManifest(projectId, snapshotId, actor, manifestInput), 507, STAGING_EXCEEDED);
        expect(state.calls).not.toContain(UPDATE_MANIFEST);
        expect(state.calls).not.toContain(USAGE_INSERT);
        expect(state.rolledBack).toBe(1);
        expect(state.committed).toBe(0);
        expect(state.usage.staging).toBeUndefined();
    });

    it('в пределах stagingBytesLimit — опись закреплена, in-flight объём закредитован (staging)', async () => {
        const state = makeState(JSON.stringify({ stagingBytesLimit: 1000 }));
        const { repository } = makeRepository(state);
        const result = await repository.beginManifest(projectId, snapshotId, actor, manifestInput);
        expect(result).toEqual({ manifestSha256: expectedHash, missing: [] });
        expect(state.committed).toBe(1);
        expect(state.rolledBack).toBe(0);
        expect(state.snapshot.manifest_sha256).toBe(expectedHash);
        expect(state.snapshot.total_bytes).toBe('100');
        expect(state.usage.staging).toBe('100');
        expect(state.receipts.get('staging:snapshot-staging:' + snapshotId)).toBe('100');
    });

    it('quota=NULL (stagingBytesLimit=0) — безлимит: used не читается, запись и кредит проходят', async () => {
        const state = makeState(null);
        const { repository } = makeRepository(state);
        const result = await repository.beginManifest(projectId, snapshotId, actor, manifestInput);
        expect(result.manifestSha256).toBe(expectedHash);
        expect(state.calls).not.toContain(STAGING_USAGE_READ);
        expect(state.usage.staging).toBe('100');
    });

    it('повтор beginManifest — идемпотентен: кредит не дублируется', async () => {
        const state = makeState(JSON.stringify({ stagingBytesLimit: 1000 }));
        const { repository } = makeRepository(state);
        await repository.beginManifest(projectId, snapshotId, actor, manifestInput);
        await repository.beginManifest(projectId, snapshotId, actor, manifestInput);
        expect(state.committed).toBe(2);
        expect(state.usage.staging).toBe('100');
        expect([...state.receipts.keys()]).toEqual(['staging:snapshot-staging:' + snapshotId]);
    });

    it('verified() — публикация больше не in-flight: staging списан в ноль', async () => {
        const state = makeState(JSON.stringify({ stagingBytesLimit: 1000 }));
        const { repository } = makeRepository(state);
        await repository.beginManifest(projectId, snapshotId, actor, manifestInput);
        state.snapshot.status = 'VERIFYING';
        await repository.verified(snapshotId, 'verifier', {
            algorithm: 'Ed25519',
            keyId: 'k1',
            publicKey: 'pk',
            value: 'sig',
        });
        expect(state.usage.staging).toBe('0');
        expect(state.receipts.get('staging:snapshot-verified:' + snapshotId)).toBe('-100');
    });
});

describe('SnapshotCommands.cancel: списание in-flight объёма отменённой публикации', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('отмена публикации с закреплённой описью — staging debit, снимок REJECTED', async () => {
        const state = makeState(JSON.stringify({ stagingBytesLimit: 1000 }));
        // Публикация уже закреплена: опись и в-flight кредит существуют.
        state.snapshot.manifest_sha256 = expectedHash;
        state.snapshot.total_bytes = '100';
        state.usage.staging = '100';
        const { repository } = makeRepository(state);
        const commands = new SnapshotCommands(repository, {} as never, {} as never);
        const result = await commands.cancel(projectId, snapshotId, actor, { requestKey: commandKey });
        expect(result).toEqual({ snapshotId, status: 'REJECTED' });
        expect(state.snapshot.status).toBe('REJECTED');
        expect(state.committed).toBe(1);
        expect(state.usage.staging).toBe('0');
        expect(state.receipts.get('staging:snapshot-rejected:' + snapshotId)).toBe('-100');
    });

    it('отмена публикации без описи (кредита не было) — без списания', async () => {
        const state = makeState(JSON.stringify({ stagingBytesLimit: 1000 }));
        state.snapshot.total_bytes = '0';
        const { repository } = makeRepository(state);
        const commands = new SnapshotCommands(repository, {} as never, {} as never);
        await commands.cancel(projectId, snapshotId, actor, { requestKey: commandKey });
        expect(state.usage).toEqual({});
        expect(state.committed).toBe(1);
    });
});
