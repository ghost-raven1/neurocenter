import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { GgufImports } from '../gguf-import.service';
import { ggufFingerprint, ggufRequestHash } from '../gguf-import.repository';
import { ggufIntent } from '../gguf-import.model';
import type { IGgufImportPolicy } from '../../../../../shared/gguf-import-policy.cjs';
import { DEFAULT_GGUF_IMPORT_POLICY } from '../../../../../shared/gguf-import-policy.cjs';

const actor = { email: 'Admin@Example.com', activeRole: 'Главный админ' };
const email = 'admin@example.com';
const requestKey = '1d8fbf80-4dd6-49ac-ae54-c64ff7770990';
const validAdmin = { epoch: 'e1', enabled: true, is_main_admin: true };

const uploadRow = (overrides: Record<string, unknown> = {}) => ({
    id: '0e5f8b2c-9a7d-4c1e-8f3a-2b6d4e8c1f02',
    actor: email,
    request_key: requestKey,
    request_hash: 'c'.repeat(64),
    file_name: 'model.gguf',
    bytes: '512',
    expected_sha256: null,
    sha256: null,
    state: 'WAITING',
    auth_epoch: 'e1',
    lease_token: null,
    metadata: null,
    limits: { ...DEFAULT_GGUF_IMPORT_POLICY },
    model_id: null,
    accept_hash: null,
    expires_at: new Date(Date.now() + 3600_000),
    created_at: new Date(),
    updated_at: new Date(),
    cleaned_at: null,
    ...overrides,
});

/** Мини model_gguf_uploads + platform_users на месте PostgreSQL. */
function ggufFixture(opts: {
    user?: { epoch: string; enabled: boolean; is_main_admin: boolean };
    prior?: Record<string, unknown> | null;
    quota?: { bytes: string; pending: string };
    policy?: () => Promise<Readonly<IGgufImportPolicy>>;
}) {
    const state = {
        user: opts.user ?? validAdmin,
        prior: opts.prior ?? null,
        quota: opts.quota ?? { bytes: '0', pending: '0' },
        calls: [] as string[],
        inserted: [] as unknown[],
        committed: 0,
        rolledBack: 0,
    };
    const policy = opts.policy ?? (async () => ({ maximumBytes: 1024 }));
    const query = async (sql: string, args: unknown[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        state.calls.push(s);
        if (s === 'BEGIN') return { rows: [] };
        if (s === 'COMMIT') {
            state.committed += 1;
            return { rows: [] };
        }
        if (s === 'ROLLBACK') {
            state.rolledBack += 1;
            return { rows: [] };
        }
        if (s.startsWith('SELECT source_upload_auth_epoch'))
            return { rows: [state.user], rowCount: 1 };
        if (s.startsWith('SELECT * FROM model_gguf_uploads WHERE actor=$1 AND request_key=$2'))
            return { rows: state.prior ? [state.prior] : [] };
        if (s.startsWith('SELECT COALESCE(SUM(bytes),0)')) return { rows: [state.quota], rowCount: 1 };
        if (s.startsWith('INSERT INTO model_gguf_uploads')) {
            const [id, actorEmail, key, hash, fileName, bytes, expected, epoch, limitsJson, expiresAt] = args;
            const row = uploadRow({
                id,
                actor: actorEmail,
                request_key: key,
                request_hash: hash,
                file_name: fileName,
                bytes: String(bytes),
                expected_sha256: expected,
                auth_epoch: epoch,
                limits: JSON.parse(limitsJson as string),
                expires_at: expiresAt,
            });
            state.inserted.push(row);
            return { rows: [row], rowCount: 1 };
        }
        throw new Error('Непредвиденный SQL: ' + s);
    };
    const pool = { query, connect: async () => ({ query, release: vi.fn() }) };
    const root = path.join(os.tmpdir(), `gguf-test-${Math.random().toString(36).slice(2)}`);
    const imports = new GgufImports(pool as never, root, policy, async () => undefined);
    return { state, imports, policy };
}

describe('GgufImports', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('limits(actor) — нормализованная действующая политика, не дефолт', async () => {
        const { imports } = ggufFixture({});
        const limits = await imports.limits(actor);
        expect(limits.maximumBytes).toBe(1024);
        expect(limits.storageQuotaBytes).toBe(DEFAULT_GGUF_IMPORT_POLICY.storageQuotaBytes);
    });

    it('не главный администратор — 403', async () => {
        const { imports } = ggufFixture({ user: { ...validAdmin, is_main_admin: false } });
        const error: unknown = await imports
            .limits({ email: 'admin@example.com', activeRole: 'Разработчик' })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
    });

    it('create: bytes выше policy.maximumBytes — 400 и откат, файл не записан', async () => {
        const { state, imports } = ggufFixture({});
        const error: unknown = await imports
            .create(actor, { requestKey, fileName: 'model.gguf', bytes: 2048 })
            .catch((e: unknown) => e);
        expect(String((error as Error).message)).toContain('в пределах настроенного размера');
        expect(state.rolledBack).toBe(1);
        expect(state.committed).toBe(0);
        expect(state.inserted).toHaveLength(0);
    });

    it('create: квота хранилища исчерпана — 409', async () => {
        const { state, imports } = ggufFixture({
            quota: { bytes: String(DEFAULT_GGUF_IMPORT_POLICY.storageQuotaBytes - 100), pending: '0' },
        });
        const error: unknown = await imports
            .create(actor, { requestKey, fileName: 'model.gguf', bytes: 512 })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect(String(error)).toContain('Лимит хранилища');
        expect(state.rolledBack).toBe(1);
        expect(state.inserted).toHaveLength(0);
    });

    it('create: приёмка фиксирует действующую политику, а не дефолт', async () => {
        const { state, imports } = ggufFixture({});
        const receipt = await imports.create(actor, { requestKey, fileName: 'model.gguf', bytes: 512 });
        expect(receipt.bytes).toBe(512);
        expect(receipt.state).toBe('WAITING');
        expect(receipt.fileName).toBe('model.gguf');
        expect(receipt.limits).toEqual({ ...DEFAULT_GGUF_IMPORT_POLICY, maximumBytes: 1024 });
        expect(receipt.limits.maximumBytes).not.toBe(DEFAULT_GGUF_IMPORT_POLICY.maximumBytes);
        expect(state.committed).toBe(1);
        expect(state.inserted).toHaveLength(1);
        expect(state.inserted[0].limits).toEqual({ ...DEFAULT_GGUF_IMPORT_POLICY, maximumBytes: 1024 });
    });

    it('create: повтор с тем же ключом и хэшем идемпотентен', async () => {
        const intent = ggufIntent({ requestKey, fileName: 'model.gguf', bytes: 512 }, {
            ...DEFAULT_GGUF_IMPORT_POLICY,
            maximumBytes: Number.MAX_SAFE_INTEGER,
        });
        const prior = uploadRow({
            request_hash: ggufRequestHash(intent),
            bytes: '512',
            limits: { ...DEFAULT_GGUF_IMPORT_POLICY, maximumBytes: 1024 },
        });
        const { state, imports } = ggufFixture({ prior });
        const receipt = await imports.create(actor, { requestKey, fileName: 'model.gguf', bytes: 512 });
        expect(receipt.id).toBe(prior.id);
        expect(state.inserted).toHaveLength(0);
        expect(state.committed).toBe(1);
    });

    it('create: тот же ключ с другим хэшем — 409', async () => {
        const { state, imports } = ggufFixture({ prior: uploadRow({ request_hash: '0'.repeat(64) }) });
        const error: unknown = await imports
            .create(actor, { requestKey, fileName: 'model.gguf', bytes: 512 })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect(String(error)).toContain('уже принадлежит другому файлу');
        expect(state.inserted).toHaveLength(0);
    });

    it('fingerprint намерения стабилен для повторения', () => {
        const intent = { requestKey, fileName: 'model.gguf', bytes: 512 };
        expect(ggufRequestHash(intent)).toBe(ggufFingerprint(['model.gguf', 512, null]));
        expect(ggufRequestHash({ ...intent, bytes: 513 })).not.toBe(ggufRequestHash(intent));
    });
});
