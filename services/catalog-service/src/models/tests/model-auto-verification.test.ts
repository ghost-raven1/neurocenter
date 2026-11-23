import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelAutoVerification } from '../model-auto-verification';
import { RemoteConnectionController } from '../remote-connection.controller';
import { RemoteProviderAccessController } from '../../remote-providers/remote-provider.controller';
import { OpenCodePersonalKeyService } from '../../opencode-personal-key/service';

const modelId = 'openai-test',
    adminEmail = 'admin@example.test',
    userEmail = 'user@example.test';
const model = { id: modelId, name: 'OpenAI test', runtime: 'remote-openai', revision: 1 };
const connectionRow = (revokedAt: string | null = null) => ({
    model_id: modelId,
    revision: 3,
    base_url: 'https://api.example.test/v1',
    request_dimensions: false,
    options: {},
    timeout_ms: 60000,
    auth_mode: 'required',
    credential_kind: 'none',
    credential: null,
    credential_env: null,
    semantic_sha: null,
    verified_at: null,
    failure_message: null,
    revoked_at: revokedAt,
});
const claimsFor = (roles: string[]) => ({
    email: adminEmail,
    userRoles: roles,
    projects: [],
    pluginIds: [],
    skillPaths: [],
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture(
    options: {
        model?: Record<string, unknown>;
        roles?: string[];
        head?: ReturnType<typeof connectionRow> | null;
        check?: ReturnType<typeof vi.fn>;
    } = {},
) {
    const card = options.model ?? model;
    const check = options.check ?? vi.fn(async () => undefined);
    const service = new ModelAutoVerification(
        { get: vi.fn(async () => card) } as never,
        { claims: vi.fn(async () => claimsFor(options.roles ?? ['Главный админ'])) } as never,
        {
            repository: { head: vi.fn(async () => (options.head === undefined ? connectionRow() : options.head)) },
            check,
        } as never,
    );
    return { service, check };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('ModelAutoVerification (8.19 P2-3)', () => {
    it('runs a server check with the saved model and the acting admin', async () => {
        const { service, check } = fixture();
        service.schedule(modelId, adminEmail);
        await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
        expect(check.mock.calls[0][0]).toBe(model);
        expect(check.mock.calls[0][1]).toBe(adminEmail);
        expect(typeof check.mock.calls[0][2]).toBe('function');
        expect(check.mock.calls[0][3]).toBeInstanceOf(AbortSignal);
    });
    it('skips non-remote, archived, revoked and missing connections', async () => {
        const cases = [
            { model: { ...model, runtime: 'gguf' } },
            { model: { ...model, archivedAt: '2026-01-01T00:00:00.000Z' } },
            { head: null },
            { head: connectionRow('2026-01-01T00:00:00.000Z') },
        ];
        for (const options of cases) {
            const { service, check } = fixture(options);
            service.schedule(modelId, adminEmail);
            await flush();
            expect(check, JSON.stringify(options)).not.toHaveBeenCalled();
        }
    });
    it('skips actors without the main admin role', async () => {
        const { service, check } = fixture({ roles: ['Наблюдатель'] });
        service.schedule(modelId, adminEmail);
        await flush();
        expect(check).not.toHaveBeenCalled();
    });
    it('keeps at most one check in flight per model', async () => {
        let release!: () => void;
        const { service, check } = fixture({
            check: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
        });
        service.schedule(modelId, adminEmail);
        await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
        service.schedule(modelId, adminEmail);
        expect(check).toHaveBeenCalledTimes(1);
        release();
        await flush();
        service.schedule(modelId, adminEmail);
        await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    });
    it('logs a failed check and frees the slot for a retry', async () => {
        // AD-O8: лог — через shared-логгер: stdout-JSON, err только allowlist, message не уходит.
        const lines: Record<string, unknown>[] = [];
        const original = process.stdout.write;
        process.stdout.write = ((chunk: unknown) => {
            const text = String(chunk).trim();
            if (text.startsWith('{')) lines.push(JSON.parse(text));
            return true;
        }) as unknown as typeof process.stdout.write;
        try {
            const failing = vi.fn().mockRejectedValueOnce(new Error('provider down')).mockResolvedValueOnce(undefined);
            const { service, check } = fixture({ check: failing });
            service.schedule(modelId, adminEmail);
            await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
            const expected = `Автопроверка модели ${modelId} не выполнена`;
            await vi.waitFor(() => expect(lines.some((line) => line.msg === expected)).toBe(true));
            const line = lines.find((candidate) => candidate.msg === expected)!;
            expect(line.level).toBe('warn');
            expect(line.err).toEqual({ name: 'Error' });
            expect(JSON.stringify(line)).not.toContain('provider down');
            service.schedule(modelId, adminEmail);
            await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2));
            await expect(check.mock.results[0].value).rejects.toThrow('provider down');
        } finally {
            process.stdout.write = original;
        }
    });
    it('aborts a check that outlives the bounded timeout', async () => {
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;
        const stuck = vi.fn((_model: unknown, _actor: unknown, _authorize: unknown, current: AbortSignal) => {
            signal = current;
            return new Promise<void>(() => undefined);
        });
        const { service, check } = fixture({ check: stuck });
        service.schedule(modelId, adminEmail);
        await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
        expect(check).toHaveBeenCalledTimes(1);
        expect(signal?.aborted).toBe(true);
    });
});

describe('auto-verification hook points (8.19 P2-3)', () => {
    it('connection save schedules a check for the acting admin', async () => {
        const schedule = vi.fn();
        const controller = new RemoteConnectionController(
            { requireMain: vi.fn(async () => adminEmail) } as never,
            { save: vi.fn(async () => ({ saved: true })) } as never,
            {} as never,
            { schedule } as never,
        );
        const result = await controller.save(modelId, {} as never, {} as never);
        expect(result).toEqual({ saved: true });
        expect(schedule).toHaveBeenCalledTimes(1);
        expect(schedule).toHaveBeenCalledWith(modelId, adminEmail);
    });
    it('connection save failure does not schedule a check', async () => {
        const schedule = vi.fn();
        const controller = new RemoteConnectionController(
            { requireMain: vi.fn(async () => adminEmail) } as never,
            {
                save: vi.fn(async () => {
                    throw new Error('save failed');
                }),
            } as never,
            {} as never,
            { schedule } as never,
        );
        await expect(controller.save(modelId, {} as never, {} as never)).rejects.toThrow('save failed');
        expect(schedule).not.toHaveBeenCalled();
    });
    it('personal key save and revoke schedule a check for the acting user', async () => {
        const schedule = vi.fn();
        const controller = new RemoteProviderAccessController(
            { mutate: vi.fn(async () => ({ done: true })) } as never,
            { actor: vi.fn(async () => ({ email: userEmail, activeRole: 'Главный админ' })) } as never,
            { schedule } as never,
        );
        await controller.save({} as never, modelId, {});
        expect(schedule).toHaveBeenLastCalledWith(modelId, userEmail);
        await controller.remove({} as never, modelId, {});
        expect(schedule).toHaveBeenCalledTimes(2);
        expect(schedule).toHaveBeenLastCalledWith(modelId, userEmail);
    });
    it('personal key transfer schedules a check for the device owner', async () => {
        const jobId = '22222222-2222-4222-8222-222222222222',
            requestKey = '33333333-3333-4333-8333-333333333333',
            providerId = 'b'.repeat(64);
        const payload = {
            schemaVersion: 1,
            scope: 'global',
            deviceId: '11111111-1111-4111-8111-111111111111',
            modelId,
            providerId,
            expectedConnectionRevision: 3,
            expectedCredentialRevision: 0,
            requestKey,
            expiresAt: '2099-01-01T00:00:00.000Z',
        };
        const receipt = {
            modelId,
            providerId,
            requestKey,
            requestHash: 'c'.repeat(64),
            connectionRevision: 3,
            credentialRevision: 1,
            hasKey: true,
            acceptedAt: '2026-01-01T00:00:00.000Z',
        };
        const schedule = vi.fn();
        const service = new OpenCodePersonalKeyService(
            {} as never,
            { get: vi.fn(async () => model) } as never,
            { repository: { mutate: vi.fn(async () => receipt) } } as never,
            { schedule } as never,
        );
        vi.spyOn(service as any, 'transaction').mockResolvedValue({
            job: { id: jobId, role: 'Главный админ' },
            payload,
            expired: false,
            actor: { email: userEmail, activeRole: 'Главный админ' },
        });
        const result = await service.save('a'.repeat(64), { jobId, apiKey: 'synthetic-personal-key' });
        expect(schedule).toHaveBeenCalledTimes(1);
        expect(schedule).toHaveBeenCalledWith(modelId, userEmail);
        expect(result).toMatchObject({ jobId, modelId, hasKey: true });
    });
});
