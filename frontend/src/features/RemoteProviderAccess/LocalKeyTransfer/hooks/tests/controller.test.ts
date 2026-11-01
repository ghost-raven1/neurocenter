import { beforeEach, expect, it, vi } from 'vitest';
import { createLocalKeyTransferController } from '../controller';
import { cliRequestFingerprint } from '../../../../ComputerSetup/hooks/receipt';
import type { ITransferControllerOptions } from '../../interfaces';
import { OPENCODE_PERSONAL_KEY_JOB } from '../../contract';
const deviceId = '11111111-1111-4111-8111-111111111111',
    jobId = '22222222-2222-4222-8222-222222222222';
const missing = () => Promise.reject({ response: { status: 404 } });
function fixture() {
    const data = new Map<string, string>();
    let enabled = true,
        owner = true;
    const target = {
        modelId: 'model',
        providerId: 'a'.repeat(64),
        providerUrl: 'https://api.openai.com/v1',
        connectionRevision: 1,
        credentialRevision: 0,
        authMode: 'required' as const,
        canStoreKey: true,
        hasKey: false,
        updatedAt: null,
        legacySharedKeyRetained: false,
    };
    const api = { open: vi.fn(), request: vi.fn(), receipt: vi.fn() };
    const options: ITransferControllerOptions = {
        owner: 'owner',
        role: 'Разработчик',
        deviceId,
        modelId: 'model',
        storage: {
            getItem: (key) => data.get(key) ?? null,
            setItem: (key, value) => {
                data.set(key, value);
            },
            removeItem: (key) => {
                data.delete(key);
            },
        },
        lock: async (_key, change) => change(),
        api,
        captureOwner: () => () => owner,
        canOpen: () => enabled,
        target: () => target,
        onChange: vi.fn(),
        onSaved: vi.fn(),
    };
    const controller = createLocalKeyTransferController(options);
    const job = { id: jobId, deviceId, projectId: null, kind: OPENCODE_PERSONAL_KEY_JOB };
    api.open.mockResolvedValue(job);
    api.request.mockImplementation(async () => ({
        requestKey: controller.state.intent!.request.requestKey,
        requestFingerprint: await cliRequestFingerprint({
            role: options.role,
            request: controller.state.intent!.request,
        }),
        job,
    }));
    api.receipt.mockResolvedValue({ receipt: null, canStartNew: false });
    const receipt = () => ({
        schemaVersion: 1,
        jobId,
        requestKey: controller.state.intent!.request.requestKey,
        modelId: 'model',
        providerId: target.providerId,
        connectionRevision: 1,
        credentialRevision: 1,
        hasKey: true,
        acceptedAt: '2026-11-01T00:00:00.000Z',
    });
    controller.activate();
    return {
        controller,
        api,
        options,
        target,
        data,
        job,
        receipt,
        disable: () => {
            enabled = false;
        },
        loseOwner: () => {
            owner = false;
        },
    };
}
beforeEach(() => vi.restoreAllMocks());
it('opens only explicitly and publishes recipient metadata without credentials', async () => {
    const f = fixture();
    await f.controller.refresh();
    expect(f.api.open).not.toHaveBeenCalled();
    await f.controller.open();
    expect(f.api.open).toHaveBeenCalledTimes(1);
    expect(f.api.open.mock.calls[0][0]).toEqual({
        kind: OPENCODE_PERSONAL_KEY_JOB,
        scope: 'global',
        deviceId,
        modelId: 'model',
        providerId: 'a'.repeat(64),
        expectedConnectionRevision: 1,
        expectedCredentialRevision: 0,
        requestKey: expect.any(String),
    });
    expect(f.options.onSaved).not.toHaveBeenCalled();
});
it('lost ACK replays the same public intent and never allocates a replacement UUID', async () => {
    const f = fixture();
    f.api.open.mockRejectedValue(Error('offline'));
    f.api.request.mockImplementation(missing);
    await f.controller.open();
    const request = f.controller.state.intent!.request;
    expect(f.controller.state.canReplay).toBe(true);
    await f.controller.replay();
    expect(f.api.open.mock.calls[1][0]).toEqual(request);
    expect(f.controller.state.intent!.request.requestKey).toBe(request.requestKey);
});
it('accepted window cannot be reopened when its receipt is unavailable', async () => {
    const f = fixture();
    f.api.request.mockImplementation(missing);
    f.api.receipt.mockImplementation(missing);
    await f.controller.open();
    await f.controller.replay();
    expect(f.controller.state.intent!.jobId).toBe(jobId);
    expect(f.controller.state.canReplay).toBe(false);
    expect(f.api.open).toHaveBeenCalledTimes(1);
});
it('OFF permits receipt recovery but denies new opening and replay', async () => {
    const f = fixture();
    await f.controller.open();
    f.disable();
    f.api.receipt.mockResolvedValue({ receipt: f.receipt(), canStartNew: true });
    await f.controller.refresh();
    expect(f.options.onSaved).toHaveBeenCalledTimes(1);
    expect(f.controller.state.receipt?.hasKey).toBe(true);
    await f.controller.beginAgain();
    await f.controller.open();
    expect(f.api.open).toHaveBeenCalledTimes(1);
});
it('does not replay an unknown request after recipient revision changes', async () => {
    const f = fixture();
    f.api.open.mockRejectedValue(Error('lost'));
    f.api.request.mockImplementation(missing);
    await f.controller.open();
    f.target.connectionRevision = 2;
    await f.controller.replay();
    expect(f.api.open).toHaveBeenCalledTimes(1);
});
it('ignores a late receipt after the current user changes', async () => {
    const f = fixture();
    await f.controller.open();
    let resolve!: (value: unknown) => void;
    f.api.receipt.mockImplementation(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    const pending = f.controller.refresh();
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    f.loseOwner();
    resolve({ receipt: f.receipt(), canStartNew: true });
    await pending;
    expect(f.options.onSaved).not.toHaveBeenCalled();
    expect(f.controller.state.receipt).toBeUndefined();
});
it('rejects a foreign recipient receipt without claiming a saved key', async () => {
    const f = fixture();
    await f.controller.open();
    f.api.receipt.mockResolvedValue({ receipt: { ...f.receipt(), modelId: 'other' }, canStartNew: true });
    await f.controller.refresh();
    expect(f.controller.state.error).toContain('другому получателю');
    expect(f.options.onSaved).not.toHaveBeenCalled();
});
it('requires explicit new attempt after a confirmed save and does not auto-open', async () => {
    const f = fixture();
    await f.controller.open();
    f.api.receipt.mockResolvedValue({ receipt: f.receipt(), canStartNew: true });
    await f.controller.refresh();
    await f.controller.beginAgain();
    expect(f.controller.state.intent).toBeUndefined();
    expect(f.api.open).toHaveBeenCalledTimes(1);
    expect(f.data.size).toBe(0);
});
it('restores its journal on remount without opening another window', async () => {
    const f = fixture();
    await f.controller.open();
    f.controller.dispose();
    const next = createLocalKeyTransferController(f.options);
    next.activate();
    await next.refresh();
    expect(next.state.intent?.jobId).toBe(jobId);
    expect(f.api.open).toHaveBeenCalledTimes(1);
});
it('accepted window stays non-replayable when recording its ID fails', async () => {
    const f = fixture();
    const write = f.options.storage!.setItem;
    f.options.storage!.setItem = (key, value) => {
        if (JSON.parse(value).jobId) throw Error('disk full');
        write(key, value);
    };
    await f.controller.open();
    await f.controller.replay();
    expect(f.controller.state.intent?.jobId).toBe(jobId);
    expect(f.controller.state.journalError).not.toBe('');
    expect(f.api.open).toHaveBeenCalledTimes(1);
});
it('confirmed failed window permits an explicit new attempt, not an automatic retry', async () => {
    const f = fixture();
    Object.assign(f.job, {
        result: {
            schemaVersion: 1,
            scope: 'global',
            deviceId,
            jobId,
            kind: OPENCODE_PERSONAL_KEY_JOB,
            checkedAt: '2026-11-01T00:00:00.000Z',
            status: 'failed',
            issue: 'unsupported-version',
        },
    });
    f.api.receipt.mockResolvedValue({ receipt: null, canStartNew: true });
    await f.controller.open();
    expect(f.controller.state.canRestart).toBe(true);
    await f.controller.beginAgain();
    expect(f.controller.state.intent).toBeUndefined();
    expect(f.api.open).toHaveBeenCalledTimes(1);
});
it('opened result reports only a window and never confirms key storage', async () => {
    const f = fixture();
    Object.assign(f.job, {
        result: {
            schemaVersion: 1,
            scope: 'global',
            deviceId,
            jobId,
            kind: OPENCODE_PERSONAL_KEY_JOB,
            checkedAt: '2026-11-01T00:00:00.000Z',
            status: 'opened',
            expiresAt: '2026-11-01T00:10:00.000Z',
        },
    });
    await f.controller.open();
    expect(f.controller.state.result?.status).toBe('opened');
    expect(f.controller.state.canRestart).toBe(false);
    expect(f.options.onSaved).not.toHaveBeenCalled();
});
it('server-confirmed expired window permits a new attempt without browser clock inference', async () => {
    const f = fixture();
    Object.assign(f.job, {
        result: {
            schemaVersion: 1,
            scope: 'global',
            deviceId,
            jobId,
            kind: OPENCODE_PERSONAL_KEY_JOB,
            checkedAt: '2026-11-01T00:00:00.000Z',
            status: 'opened',
            expiresAt: '2026-11-01T00:10:00.000Z',
        },
    });
    await f.controller.open();
    expect(f.controller.state.canRestart).toBe(false);
    f.api.receipt.mockResolvedValue({ receipt: null, canStartNew: true });
    await f.controller.refresh();
    expect(f.controller.state.canRestart).toBe(true);
    await f.controller.beginAgain();
    expect(f.controller.state.intent).toBeUndefined();
    expect(f.api.open).toHaveBeenCalledTimes(1);
});
it('missing server restart authority preserves the accepted window', async () => {
    const f = fixture();
    await f.controller.open();
    f.api.receipt.mockResolvedValue({ receipt: null });
    await f.controller.refresh();
    expect(f.controller.state.error).not.toBe('');
    await f.controller.beginAgain();
    expect(f.controller.state.intent?.jobId).toBe(jobId);
    expect(f.controller.state.canRestart).toBe(false);
});
