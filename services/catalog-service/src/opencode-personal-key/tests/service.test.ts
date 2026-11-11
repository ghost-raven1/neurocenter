import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { OpenCodePersonalKeyService } from '../service';
import { RemoteProviderRepository } from '../../remote-providers/remote-provider.repository';
import { remoteProviderId, openUserCredential } from '../../remote-providers/remote-provider.identity';
import {
    OPENCODE_PERSONAL_KEY_JOB,
    OPENCODE_PERSONAL_KEY_CAPABILITY,
} from '../../../../shared/opencode-personal-key.cjs';
import { requireFeaturesEnabled } from '../../features/require-feature-enabled';
vi.mock('../../features/require-feature-enabled', () => ({
    requireFeaturesEnabled: vi.fn(async () => {}),
    requireFeatureEnabled: vi.fn(async () => {}),
}));
const jobId = '22222222-2222-4222-8222-222222222222',
    deviceId = '11111111-1111-4111-8111-111111111111',
    requestKey = '33333333-3333-4333-8333-333333333333',
    email = 'owner@example.test',
    secret = 'synthetic-personal-key',
    bearer = 'a'.repeat(64);
function fixture(baseUrl = 'https://api.openai.com/v1') {
    const model = { id: 'openai-test', name: 'OpenAI test', runtime: 'remote-openai' },
        connection = {
            model_id: model.id,
            revision: 3,
            base_url: baseUrl,
            credential_kind: 'none',
            auth_mode: 'required',
            revoked_at: null,
        };
    const providerId = remoteProviderId(model as never, connection as never),
        payload = {
            schemaVersion: 1,
            scope: 'global',
            deviceId,
            modelId: model.id,
            providerId,
            expectedConnectionRevision: 3,
            expectedCredentialRevision: 0,
            requestKey,
            expiresAt: '2099-01-01T00:00:00.000Z',
        };
    const job = {
        id: jobId,
        device_id: deviceId,
        email,
        role: 'Главный админ',
        project_id: null,
        kind: OPENCODE_PERSONAL_KEY_JOB,
        payload,
        state: 'succeeded',
    };
    const device = {
        id: deviceId,
        email,
        role: 'Главный админ',
        report: { capabilities: [OPENCODE_PERSONAL_KEY_CAPABILITY] },
    };
    let credential: any,
        receipt: any,
        revoked = false,
        commits = 0,
        writes = 0,
        loseAck = false,
        revokeAfterContext = false;
    const calls: string[] = [];
    const query = vi.fn(async (sql: string, args: any[] = []) => {
        calls.push(sql);
        if (sql.startsWith('COMMIT')) {
            commits++;
            if (revokeAfterContext && commits === 1) revoked = true;
            if (loseAck && writes) {
                loseAck = false;
                throw Error('ACK lost');
            }
            return { rows: [] };
        }
        if (sql.startsWith('SELECT clock_timestamp()'))
            return { rows: [{ expired: Date.parse(String(args[0])) <= Date.now() }] };
        if (sql.startsWith('SELECT device.*'))
            return { rows: revoked || (args[2] && args[2] !== email) ? [] : [device] };
        if (sql.startsWith('SELECT * FROM bridge_devices')) return { rows: revoked ? [] : [device] };
        if (sql.startsWith('SELECT * FROM bridge_jobs')) return { rows: [job] };
        if (sql.startsWith('SELECT enabled,is_main_admin')) return { rows: [{ enabled: true, is_main_admin: true }] };
        if (sql.startsWith('SELECT archived_at')) return { rows: [{ archived_at: null }] };
        if (sql.startsWith('SELECT * FROM model_catalog'))
            return {
                rows: [
                    {
                        ...model,
                        descriptor: { runtime: model.runtime },
                        revision: 1,
                        created_at: '2026-01-01T00:00:00.000Z',
                        updated_at: '2026-01-01T00:00:00.000Z',
                    },
                ],
            };
        if (sql.startsWith('SELECT * FROM model_remote_connections')) return { rows: [connection] };
        if (sql.startsWith('SELECT * FROM remote_provider_user_credentials'))
            return { rows: credential ? [credential] : [] };
        if (sql.includes('FROM remote_provider_user_requests')) return { rows: receipt ? [receipt] : [] };
        if (sql.includes('INSERT INTO remote_provider_user_credentials')) {
            writes++;
            credential = {
                model_id: args[0],
                provider_id: args[1],
                owner_email: args[2],
                revision: args[3],
                credential: JSON.parse(args[4]),
                updated_at: '2026-01-01T00:00:00.000Z',
            };
            return { rows: [{ updated_at: credential.updated_at }] };
        }
        if (sql.includes('INSERT INTO remote_provider_user_requests')) {
            receipt = { model_id: args[2], request_hash: args[3], result: JSON.parse(args[4]) };
            return { rows: [] };
        }
        return { rows: [] };
    });
    const db = { query, release: vi.fn() },
        pool = { connect: async () => db, query };
    const repository = new RemoteProviderRepository(pool as never);
    const service = new OpenCodePersonalKeyService(
        { pool } as never,
        {
            get: async () => model,
            actor: async () => ({ email, activeRole: 'Главный админ' }),
            getAccessible: async () => model,
        } as never,
        { repository } as never,
    );
    return {
        service,
        repository,
        model,
        connection,
        payload,
        job,
        calls,
        query,
        get credential() {
            return credential;
        },
        get receipt() {
            return receipt;
        },
        get writes() {
            return writes;
        },
        revoke: () => {
            revoked = true;
        },
        revokeAtMutation: () => {
            revokeAfterContext = true;
        },
        loseAck: () => {
            loseAck = true;
        },
        replaceReceiptSource: () => {
            receipt.result.transferJobId = '44444444-4444-4444-8444-444444444444';
        },
    };
}
beforeEach(() => {
    vi.stubEnv('NEUROCENTER_MODEL_CREDENTIAL_KEY', Buffer.alloc(32, 7).toString('base64'));
    vi.mocked(requireFeaturesEnabled).mockReset();
});
afterEach(() => vi.unstubAllEnvs());
it('pins the exact recipient, encrypts only personal storage, and projects no key or hash', async () => {
    const f = fixture(),
        context = await f.service.context(bearer, { jobId });
    expect(context.recipient).toMatchObject({
        ownerEmail: email,
        providerUrl: 'https://api.openai.com/v1',
        connectionRevision: 3,
        credentialRevision: 0,
    });
    const result = await f.service.save(bearer, { jobId, apiKey: secret });
    expect(result).toEqual({
        schemaVersion: 1,
        jobId,
        requestKey,
        modelId: f.model.id,
        providerId: f.payload.providerId,
        connectionRevision: 3,
        credentialRevision: 1,
        hasKey: true,
        acceptedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).not.toHaveProperty('requestHash');
    expect(JSON.stringify(f.credential)).not.toContain(secret);
    expect(openUserCredential(f.credential.credential, email, f.payload.providerId, 1)).toBe(secret);
    expect(f.receipt.result.transferJobId).toBe(jobId);
    expect(f.writes).toBe(1);
});
it('unknown commit ACK resolves by the same job receipt and never writes twice', async () => {
    const f = fixture();
    f.loseAck();
    await expect(f.service.save(bearer, { jobId, apiKey: secret })).rejects.toThrow();
    const observed = await f.service.receipt(bearer, { jobId });
    expect(observed.receipt?.hasKey).toBe(true);
    await f.service.save(bearer, { jobId, apiKey: secret });
    expect(f.writes).toBe(1);
    await expect(f.service.save(bearer, { jobId, apiKey: 'different-key' })).rejects.toThrow();
    expect(f.writes).toBe(1);
});
it('receipt lookup remains available after OFF and expiry without mutating or returning the private request hash', async () => {
    const f = fixture();
    await f.service.save(bearer, { jobId, apiKey: secret });
    f.payload.expiresAt = '2000-01-01T00:00:00.000Z';
    vi.mocked(requireFeaturesEnabled).mockRejectedValue(Error('flag OFF'));
    expect((await f.service.receipt(bearer, { jobId })).receipt?.hasKey).toBe(true);
    await expect(f.service.save(bearer, { jobId, apiKey: secret })).rejects.toThrow();
    expect(f.writes).toBe(1);
});
it('does not mistake an unrelated request receipt for this transfer', async () => {
    const f = fixture();
    await f.service.save(bearer, { jobId, apiKey: secret });
    f.replaceReceiptSource();
    expect(await f.service.receipt(bearer, { jobId })).toEqual({ receipt: null });
});
it('a device revoked between preflight and mutation cannot commit a personal key', async () => {
    const f = fixture();
    f.revokeAtMutation();
    await expect(f.service.save(bearer, { jobId, apiKey: secret })).rejects.toThrow();
    expect(f.writes).toBe(0);
});
it.each(['provider', 'revision', 'protocol'])('rejects changed recipient %s before saving', async (change) => {
    const f = fixture();
    if (change === 'provider') f.connection.base_url = 'https://other.example/v1';
    else if (change === 'revision') f.connection.revision++;
    else f.model.runtime = 'remote-ollama';
    await expect(f.service.save(bearer, { jobId, apiKey: secret })).rejects.toThrow();
    expect(f.writes).toBe(0);
});
it('accepts the model own OpenAI-compatible endpoint and canonicalizes the recipient url', async () => {
    const f = fixture('https://ai-gateway.ehd-zr.cbr.ru/'),
        context = await f.service.context(bearer, { jobId });
    expect(context.recipient.providerUrl).toBe('https://ai-gateway.ehd-zr.cbr.ru');
    const result = await f.service.save(bearer, { jobId, apiKey: secret });
    expect(result?.hasKey).toBe(true);
    expect(f.writes).toBe(1);
});
it('rejects a plain http recipient before saving', async () => {
    const f = fixture('http://x.example/v1');
    await expect(f.service.context(bearer, { jobId })).rejects.toThrow();
    await expect(f.service.save(bearer, { jobId, apiKey: secret })).rejects.toThrow();
    expect(f.writes).toBe(0);
});
it('rejects owner/body injection and revoked receipt reads', async () => {
    const f = fixture();
    await expect(f.service.save(bearer, { jobId, apiKey: secret, ownerEmail: 'other@example.test' })).rejects.toThrow();
    f.revoke();
    await expect(f.service.receipt(bearer, { jobId })).rejects.toThrow();
    expect(f.writes).toBe(0);
});

it('the manual receipt route cannot expose transfer provenance or its private HMAC', async () => {
    const f = fixture();
    await f.service.save(bearer, { jobId, apiKey: secret });
    expect(await f.repository.receipt(f.model.id, { email, activeRole: 'Главный админ' }, requestKey)).toBeNull();
});

it('browser recovery waits for the exclusive job fence before classifying an admitted save', async () => {
    const f = fixture(),
        original = f.query.getMockImplementation()!;
    let entered!: () => void,
        release!: () => void,
        settled = false;
    const reached = new Promise<void>((resolve) => {
            entered = resolve;
        }),
        held = new Promise<void>((resolve) => {
            release = resolve;
        });
    f.query.mockImplementation(async (sql, args = []) => {
        if (sql.startsWith('SELECT * FROM bridge_jobs') && sql.endsWith('FOR UPDATE')) {
            entered();
            await held;
        }
        return original(sql, args);
    });
    const pending = f.service.browserReceipt({} as never, f.model.id, jobId).then((result) => {
        settled = true;
        return result;
    });
    await reached;
    expect(settled).toBe(false);
    // External DB lock delivery is controlled here; the save represents the transaction holding SHARE.
    await f.service.save(bearer, { jobId, apiKey: secret });
    release();
    const result = await pending;
    expect(result.receipt?.hasKey).toBe(true);
    expect(result.canStartNew).toBe(true);
    expect(f.writes).toBe(1);
});
it('browser retry permission uses server database expiry and never grants retry for a live unresolved window', async () => {
    const f = fixture(),
        original = f.query.getMockImplementation()!;
    let expired = false;
    f.query.mockImplementation(async (sql, args = []) =>
        sql.startsWith('SELECT clock_timestamp()') ? { rows: [{ expired }] } : original(sql, args),
    );
    expect(await f.service.browserReceipt({} as never, f.model.id, jobId)).toEqual({
        receipt: null,
        canStartNew: false,
    });
    expired = true;
    expect(await f.service.browserReceipt({} as never, f.model.id, jobId)).toEqual({
        receipt: null,
        canStartNew: true,
    });
    expect(await f.service.receipt(bearer, { jobId })).toEqual({ receipt: null });
    expect(f.writes).toBe(0);
});
