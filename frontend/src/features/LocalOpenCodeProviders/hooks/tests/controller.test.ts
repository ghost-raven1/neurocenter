import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
    OPENCODE_GLOBAL_PROVIDERS_READ_JOB as READ,
    OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB as OPEN,
    OPENCODE_V2_ACCOUNTS_ADAPTER as ADAPTER,
} from '@neurocenter/opencode-local-providers';
import { createLocalProvidersController } from '../controller';
import { globalRequestFingerprint, readProviderJob } from '../../model';

const deviceId = '11111111-1111-4111-8111-111111111111';
const requestKey = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const time = '2026-11-01T00:00:00.000Z';
function job(adapter?: typeof ADAPTER, kind: typeof READ | typeof OPEN = READ) {
    return {
        id: jobId,
        deviceId,
        projectId: null,
        kind,
        state: 'succeeded',
        createdAt: time,
        updatedAt: time,
        ...(adapter ? { adapter } : {}),
        result: {
            schemaVersion: 1,
            scope: 'global',
            deviceId,
            jobId,
            kind,
            checkedAt: time,
            ...(adapter ? { adapter } : {}),
            ...(kind === OPEN
                ? { status: 'opened', expiresAt: '2026-11-01T00:10:00.000Z' }
                : {
                      status: 'checked',
                      ...(adapter
                          ? {
                                accountInventory: {
                                    accounts: [
                                        {
                                            integrationId: 'anthropic',
                                            hasApiKey: true,
                                            hasOAuth: false,
                                            hasExternal: false,
                                        },
                                    ],
                                    issues: [],
                                },
                            }
                          : {
                                inventory: {
                                    providers: [],
                                    configurationFound: false,
                                    authenticationFound: false,
                                    overrideDetected: false,
                                    issues: [],
                                },
                            }),
                  }),
        },
    };
}
function fixture(adapter?: typeof ADAPTER, canOpen = true) {
    const values = new Map<string, string>();
    const api = { list: vi.fn(async () => [] as unknown[]), request: vi.fn(), create: vi.fn(), cancel: vi.fn() };
    const controller = createLocalProvidersController({
        adapter,
        deviceId,
        owner: 'owner',
        role: 'Разработчик',
        storage: {
            getItem: (key) => values.get(key) ?? null,
            setItem: (key, value) => {
                values.set(key, value);
            },
        },
        lock: async (_key, work) => work(),
        api,
        captureOwner: () => () => true,
        canRead: () => true,
        canOpen: () => canOpen,
        requestKey: () => requestKey,
        onChange: vi.fn(),
    });
    controller.activate();
    return { controller, api, values };
}
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
it('keeps legacy journal identity and isolates V2 history and fingerprints', async () => {
    const v1 = fixture(),
        v2 = fixture(ADAPTER);
    expect(v1.controller.journalKey(READ)).toBe(
        'neurocenter:global-providers:' + JSON.stringify(['owner', deviceId, READ]),
    );
    expect(v2.controller.journalKey(READ)).not.toBe(v1.controller.journalKey(READ));
    v2.api.list.mockResolvedValue([job(), job(ADAPTER)]);
    await v2.controller.refresh();
    expect(v2.controller.state.inventory).toBeUndefined();
    expect(v2.controller.state.accountInventory?.accounts[0].integrationId).toBe('anthropic');
    const common = { deviceId, kind: READ, scope: 'global' as const, requestKey };
    expect(await globalRequestFingerprint(common, 'Разработчик')).not.toBe(
        await globalRequestFingerprint({ ...common, adapter: ADAPTER }, 'Разработчик'),
    );
});
it('replays an unacknowledged V2 request with the same UUID and adapter', async () => {
    const f = fixture(ADAPTER);
    f.api.create.mockRejectedValue(new Error('Lost ACK'));
    f.api.request.mockRejectedValue({ response: { status: 404 } });
    await f.controller.start(READ);
    expect(f.controller.state.canReplay).toBe(true);
    await f.controller.replay(READ);
    expect(f.api.create).toHaveBeenCalledTimes(2);
    expect(f.api.create.mock.calls[1][0]).toEqual(f.api.create.mock.calls[0][0]);
    expect(f.api.create.mock.calls[0][0]).toMatchObject({ adapter: ADAPTER, requestKey });
});
it('does not reopen an accepted V2 window when its receipt is unavailable', async () => {
    const f = fixture(ADAPTER);
    f.api.create.mockResolvedValue(job(ADAPTER, OPEN));
    f.api.request.mockRejectedValue({ response: { status: 404 } });
    await f.controller.start(OPEN);
    await f.controller.replay(OPEN);
    expect(f.api.create).toHaveBeenCalledOnce();
    expect(f.controller.state.canReplay).toBe(false);
    expect([...f.values.values()].join('')).toContain(jobId);
});
it('reads V2 account history with opening disabled and refuses OPEN', async () => {
    const f = fixture(ADAPTER, false);
    f.api.list.mockResolvedValue([job(ADAPTER)]);
    await f.controller.refresh();
    await f.controller.start(OPEN);
    expect(f.controller.state.accountInventory?.accounts).toHaveLength(1);
    expect(f.api.create).not.toHaveBeenCalled();
});
it('rejects a receipt from the other adapter instead of accepting its result', async () => {
    const f = fixture(ADAPTER);
    f.api.create.mockRejectedValue(new Error('Lost ACK'));
    f.api.request.mockResolvedValue({
        requestKey,
        requestFingerprint: await globalRequestFingerprint(
            { deviceId, kind: READ, scope: 'global', requestKey, adapter: ADAPTER },
            'Разработчик',
        ),
        job: job(),
    });
    await f.controller.start(READ);
    expect(f.controller.state.accountInventory).toBeUndefined();
    expect(f.controller.state.error).toContain('не подтверждено');
});

it('accepts a null adapter only for legacy jobs and rejects an unknown adapter', async () => {
    const f = fixture();
    f.api.list.mockResolvedValue([{ ...job(), adapter: null }]);
    await f.controller.refresh();
    expect(f.controller.state.inventory).toBeDefined();
    expect(() => readProviderJob({ ...job(), adapter: 'unknown-adapter' }, deviceId, READ)).toThrow();
});
