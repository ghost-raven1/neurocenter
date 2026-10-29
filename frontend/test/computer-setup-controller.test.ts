import {webcrypto} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cliRequestFingerprint, readCliReceipt} from '../src/features/ComputerSetup/receipt';
import {cliStorageKey} from '../src/features/ComputerSetup/storage';
import {createCliObservationController} from '../src/features/ComputerSetup/controller';
import type {CliJournalLock} from '../src/features/ComputerSetup/journalLock';
import {completed, deferred, deviceId, email, envelope, fixture, httpError, intent, job, jobId, journal, request, requestKey, role} from './computer-setup.fixture';

beforeEach(() => {vi.stubGlobal('crypto', webcrypto);});
afterEach(() => {vi.unstubAllGlobals();});

describe('Exact observation receipt', () => {
    it('matches the independent UTF-8 role/four-field hash and rejects null or changed bindings', async () => {
        expect(await cliRequestFingerprint(intent)).toBe(envelope().requestFingerprint);
        await expect(readCliReceipt(envelope(intent, completed()), intent)).resolves.toMatchObject({id: jobId, observation: {version: '1.14.48'}});
        for (const value of [{...envelope(), requestKey: jobId}, {...envelope(), requestFingerprint: null}, {...envelope(), requestFingerprint: 'a'.repeat(64)}, envelope({...intent, role: 'Разработчик'})]) {
            await expect(readCliReceipt(value, intent)).rejects.toThrow();
        }
    });
    it('rejects uppercase device/job identities and a previously accepted different job', async () => {
        await expect(readCliReceipt(envelope(intent, job({id: jobId.toUpperCase()})), intent)).rejects.toThrow();
        await expect(readCliReceipt(envelope(intent, job({deviceId: deviceId.toUpperCase()})), intent)).rejects.toThrow();
        await expect(readCliReceipt(envelope(), {...intent, jobId: requestKey})).rejects.toThrow();
    });
});

describe('Single automatic fixed observation', () => {
    it('starts without a project exactly once and retains the accepted key for later reads', async () => {
        const h = fixture(); await h.initialize(); await h.controller.automatic(); await h.controller.automatic();
        expect(h.api.create).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal));
        expect(Object.keys(vi.mocked(h.api.create).mock.calls[0][0]).sort()).toEqual(['deviceId', 'kind', 'requestKey', 'scope']);
        expect(h.state().intent?.jobId).toBe(jobId); expect(h.state().job?.state).toBe('queued');
        await h.controller.check(); expect(h.api.create).toHaveBeenCalledOnce(); h.dispose();
    });
    it.each(['installed', 'missing', 'failed', 'timed-out'])('exposes only the exact %s observation', async status => {
        const h = fixture({api: {create: vi.fn().mockResolvedValue(completed(status)), request: vi.fn().mockResolvedValue(envelope(intent, completed(status)))}});
        await h.initialize(); await h.controller.automatic();
        expect(h.state().job?.observation?.status).toBe(status);
        expect(h.state().job?.observation && 'version' in h.state().job!.observation!).toBe(status === 'installed'); h.dispose();
    });
    it('a failed job without observation is unknown, never CLI missing or a fabricated check time', async () => {
        const value = job({state: 'failed', result: {}}), h = fixture({api: {create: vi.fn().mockResolvedValue(value), request: vi.fn().mockResolvedValue(envelope(intent, value))}});
        await h.initialize(); await h.controller.automatic(); expect(h.state().job?.observation).toBeUndefined(); h.dispose();
    });
    it('does not enqueue over a saved intent, server history or unavailable WebLock', async () => {
        for (const patch of [{raw: JSON.stringify(intent)}, {api: {list: vi.fn().mockResolvedValue([completed()])}}, {lock: null}] as const) {
            const h = fixture(patch); await h.initialize(); await h.controller.automatic(); expect(h.api.create).not.toHaveBeenCalled(); h.dispose();
        }
    });
    it('a later empty history snapshot cannot erase the terminal observation or enable automatic enqueue', async () => {
        const h = fixture({api: {list: vi.fn().mockResolvedValueOnce([completed()]).mockResolvedValue([])}});
        await h.initialize(); expect(h.state().job?.observation?.status).toBe('installed');
        await h.controller.refresh(); await h.controller.automatic();
        expect(h.state().job?.id).toBe(jobId); expect(h.state().job?.observation?.status).toBe('installed');
        expect(h.api.create).not.toHaveBeenCalled(); h.dispose();
    });
    it('keeps the later updated job when an older different ID shares its creation time', async () => {
        const h = fixture({api: {list: vi.fn().mockResolvedValueOnce([completed()]).mockResolvedValue([job({id: requestKey})])}});
        await h.initialize(); await h.controller.refresh();
        expect(h.state().job?.id).toBe(jobId); expect(h.state().job?.observation?.status).toBe('installed');
        await h.controller.automatic(); expect(h.api.create).not.toHaveBeenCalled(); h.dispose();
    });
    it('rechecks OFF after waiting for a lock and never saves a new intent', async () => {
        const waiting = deferred<void>(), reached = deferred<void>(), h = fixture({lock: async (_key, change) => {reached.resolve(); await waiting.promise; return change();}});
        await h.initialize(); const pending = h.controller.automatic(); await reached.promise; h.controls.enabled = false; waiting.resolve(); await pending;
        expect(h.api.create).not.toHaveBeenCalled(); expect(h.storage.raw()).toBeNull(); h.dispose();
    });
    it('only explicit New after a confirmed terminal receipt creates another key and job', async () => {
        const nextKey = 'd4444444-4444-4444-8444-444444444444', nextJob = 'e5555555-5555-4555-8555-555555555555';
        const next = {...intent, request: {...request, requestKey: nextKey}};
        const h = fixture({requestKey: vi.fn().mockReturnValueOnce(requestKey).mockReturnValueOnce(nextKey), api: {
            create: vi.fn().mockResolvedValueOnce(completed()).mockResolvedValueOnce(job({id: nextJob})),
            request: vi.fn().mockResolvedValueOnce(envelope(intent, completed())).mockResolvedValueOnce(envelope(next, job({id: nextJob}))),
        }});
        await h.initialize(); await h.controller.automatic(); await h.controller.automatic(); expect(h.api.create).toHaveBeenCalledOnce();
        await h.controller.start(); expect(vi.mocked(h.api.create).mock.calls.map(([input]) => input.requestKey)).toEqual([requestKey, nextKey]);
        expect(h.state().intent?.jobId).toBe(nextJob); h.dispose();
    });
});

describe('Unknown ACK and context recovery', () => {
    it('lost POST ACK is reconciled by GET, and remount only reads the same accepted job', async () => {
        const h = fixture({api: {create: vi.fn().mockRejectedValue(Error('ACK lost'))}});
        await h.initialize(); await h.controller.automatic(); expect(h.state().intent?.jobId).toBe(jobId); expect(h.api.create).toHaveBeenCalledOnce();
        const raw = h.storage.raw()!; h.dispose(); const next = fixture({raw}); await next.initialize(); await next.controller.automatic();
        expect(next.api.request).toHaveBeenCalledExactlyOnceWith(requestKey, expect.any(AbortSignal)); expect(next.api.create).not.toHaveBeenCalled(); next.dispose();
    });
    it('a real 404 permits only explicit replay of the identical saved body and key', async () => {
        const h = fixture({api: {create: vi.fn().mockRejectedValueOnce(Error('ACK lost')).mockResolvedValue(job()), request: vi.fn().mockRejectedValueOnce(httpError(404)).mockResolvedValue(envelope())}});
        await h.initialize(); await h.controller.automatic(); expect(h.state().canReplay).toBe(true);
        await h.controller.automatic(); expect(h.api.create).toHaveBeenCalledOnce(); await h.controller.replay();
        expect(vi.mocked(h.api.create).mock.calls.map(([input]) => input)).toEqual([request, request]); expect(h.state().intent?.jobId).toBe(jobId); h.dispose();
    });
    it('a missing previously accepted job never replays after reset or missing history', async () => {
        const h = fixture({raw: JSON.stringify({...intent, jobId}), api: {request: vi.fn().mockRejectedValue(httpError(404))}});
        await h.initialize(); expect(h.state().canReplay).toBe(false); await h.controller.replay(); await h.controller.start();
        expect(h.api.create).not.toHaveBeenCalled(); expect(h.storage.raw()).toContain(jobId); h.dispose();
    });
    it('a terminal receipt which later becomes 404 cannot authorize a new request from cached state', async () => {
        const h = fixture({raw: JSON.stringify({...intent, jobId}), api: {request: vi.fn().mockResolvedValueOnce(envelope(intent, completed())).mockRejectedValue(httpError(404))}});
        await h.initialize(); expect(h.state().job?.state).toBe('succeeded'); await h.controller.check(); await h.controller.start();
        expect(h.api.create).not.toHaveBeenCalled(); expect(h.state().canReplay).toBe(false); h.dispose();
    });
    it('role changes retain read-only recovery but cannot replay under the new role', async () => {
        const h = fixture({role: 'Разработчик', raw: JSON.stringify(intent), api: {request: vi.fn().mockRejectedValue(httpError(404))}});
        await h.initialize(); expect(h.state().canReplay).toBe(false); await h.controller.replay();
        expect(h.api.create).not.toHaveBeenCalled(); expect(h.storage.raw()).toBe(JSON.stringify(intent)); h.dispose();
    });
    it('late accepted POST after dispose does not mutate the journal or the next context', async () => {
        const ack = deferred<unknown>(), sent = deferred<void>(), h = fixture({api: {create: vi.fn().mockImplementation(() => {sent.resolve(); return ack.promise;})}});
        await h.initialize(); const pending = h.controller.automatic();
        await sent.promise;
        h.dispose(); const before = h.changed.mock.calls.length, raw = h.storage.raw(); ack.resolve(job()); await pending;
        expect(h.changed).toHaveBeenCalledTimes(before); expect(h.storage.raw()).toBe(raw); expect(h.api.request).not.toHaveBeenCalled();
    });
    it('flags OFF still reads history and cancels a pending inspection without POST', async () => {
        const h = fixture({raw: JSON.stringify({...intent, jobId})}); h.controls.enabled = false;
        await h.initialize(); await h.controller.automatic(); vi.mocked(h.api.request).mockResolvedValue(envelope(intent, job({state: 'cancelled'})));
        await h.controller.cancel(); expect(h.api.cancel).toHaveBeenCalledExactlyOnceWith(jobId, expect.any(AbortSignal));
        expect(h.state().job?.state).toBe('cancelled'); expect(h.api.create).not.toHaveBeenCalled(); h.dispose();
    });
    it('denied reads clear the private version while preserving the recovery key', async () => {
        const h = fixture({raw: JSON.stringify({...intent, jobId}), api: {request: vi.fn().mockResolvedValueOnce(envelope(intent, completed())).mockRejectedValue(httpError(403))}});
        await h.initialize(); expect(h.state().job?.observation).toBeTruthy(); await h.controller.check();
        expect(h.state().job).toBeUndefined(); expect(h.state().denied).toBe(true); expect(h.storage.raw()).toContain(requestKey); h.dispose();
    });
});

describe('Storage and cross-tab ownership', () => {
    it.each(['{broken', 'null', '[]'])('corrupt journal %s is preserved and never admitted', async raw => {
        const h = fixture({raw}); await h.initialize(); await h.controller.automatic(); await h.controller.start();
        expect(h.storage.raw()).toBe(raw); expect(h.state().storageError).not.toBe(''); expect(h.api.create).not.toHaveBeenCalled(); h.dispose();
    });
    it('storage write failure or another tab changing bytes never reaches POST', async () => {
        const h = fixture(); await h.initialize(); h.storage.setItem.mockImplementation(() => {throw Error('storage denied');}); await h.controller.automatic();
        expect(h.api.create).not.toHaveBeenCalled(); expect(h.state().storageError).not.toBe(''); h.dispose();
    });
    it('a second tab sees the first initial intent under the short lock and only reads its receipt', async () => {
        const storage = journal(), api = {list: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue(job()), request: vi.fn().mockResolvedValue(envelope()), cancel: vi.fn().mockResolvedValue(undefined)};
        let insideLock = false;
        const lock: CliJournalLock = async (_key, change) => {insideLock = true; try {return change();} finally {insideLock = false;}};
        const create = api.create; api.create = vi.fn(async (...args) => {expect(insideLock).toBe(false); return create(...args);});
        const make = () => createCliObservationController({email, role, deviceId, api, storage, lock, captureOwner: () => () => true, canStart: () => true, canCancel: () => true, requestKey: () => requestKey, onChange: () => undefined});
        const first = make(), second = make(); first.activate(); second.activate(); await Promise.all([first.refresh(), second.refresh()]);
        await Promise.all([first.automatic(), second.automatic()]); expect(api.create).toHaveBeenCalledOnce(); expect(storage.raw()).toContain(requestKey);
        first.dispose(); second.dispose();
    });
    it('a late receipt cannot replace a different pending request written by another tab', async () => {
        const ack = deferred<unknown>(), sent = deferred<void>(), h = fixture({api: {create: vi.fn().mockImplementation(() => {sent.resolve(); return ack.promise;})}}); await h.initialize();
        const pending = h.controller.automatic(); await sent.promise;
        const foreign = JSON.stringify({...intent, request: {...request, requestKey: jobId}}); h.storage.foreign(foreign); h.controller.storageChanged();
        ack.resolve(job()); await pending; expect(h.storage.raw()).toBe(foreign); expect(h.state().canReplay).toBe(false); h.dispose();
    });
    it('an exact same journal key is isolated from a different account/device', () => {
        expect(cliStorageKey(email, deviceId)).not.toBe(cliStorageKey('other@example.test', deviceId));
        expect(cliStorageKey(email, deviceId)).not.toBe(cliStorageKey(email, jobId));
    });
});
