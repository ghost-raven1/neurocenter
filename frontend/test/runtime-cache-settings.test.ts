import { describe, expect, it, vi } from 'vitest';
import type { IBridgeJob, IBridgeJobInput, RuntimeCachePolicyResult } from '../src/features/McpBridge/api';
import { createRuntimeCacheSettings, initialRuntimeCacheSettings, runtimeCacheMiB, type RuntimeCacheSettingsState } from '../src/features/McpBridge/runtimeCacheSettingsController';

type Request = Extract<IBridgeJobInput, {kind: 'runtime-cache-policy'}>;
const report = (revision = 0, limitMiB = 2048): RuntimeCachePolicyResult => ({schemaVersion: 1, revision, limitBytes: limitMiB * runtimeCacheMiB,
    usedBytes: 1890 * runtimeCacheMiB, defaultBytes: 2048 * runtimeCacheMiB, minBytes: 1024 * runtimeCacheMiB,
    maxBytes: 16384 * runtimeCacheMiB, observedAt: '2026-10-24T10:00:00.000Z'});
const job = (deviceId: string, state = 'queued', result?: RuntimeCachePolicyResult): IBridgeJob => ({id: '12345678-1234-4234-8234-123456789abc',
    deviceId, projectId: null, kind: 'runtime-cache-policy', state, message: state === 'queued' ? 'Ожидает мост' : 'Лимит проверен',
    createdAt: '2026-10-24T10:00:00.000Z', updatedAt: '2026-10-24T10:00:00.000Z', result: result ? {...result} : undefined});
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
function fixture(cleanupSupported = false, targetSupported = false, currentOnlySupported = false) {
    let owner = 'alice:developer', setReason = '', cleanupReason = '', storageBlocked = false;
    const storage = new Map<string, string>(), create = vi.fn<(request: Request) => Promise<IBridgeJob>>(), jobs = vi.fn<() => Promise<IBridgeJob[]>>();
    const mount = (deviceId = 'device-a') => {
        const captured = owner; let state: RuntimeCacheSettingsState = initialRuntimeCacheSettings();
        const controller = createRuntimeCacheSettings({scope: captured, deviceId, captureOwner: () => () => owner === captured,
            storage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => {if (storageBlocked) throw new Error('Quota exceeded'); storage.set(key, value);}, removeItem: key => {storage.delete(key);}},
            create, jobs, inspectReason: () => '', setReason: () => setReason, cleanupSupported: () => cleanupSupported, targetSupported: () => targetSupported,
            currentOnlySupported: () => currentOnlySupported,
            cleanupReason: enabled => enabled ? cleanupReason : '', onChange: next => {state = next;}});
        controller.activate(); return {controller, state: () => state};
    };
    return {mount, storage, create, jobs, owner: (value: string) => {owner = value;}, disableSet: () => {setReason = 'Функция выключена';},
        disableCleanup: () => {cleanupReason = 'Очистка выключена';}, blockStorage: (value: boolean) => {storageBlocked = value;}};
}

describe('Owner-managed runtime cache settings', () => {
    it('uses the inspected revision and integer MiB, preserving a failed draft until the device confirms the saved limit', async () => {
        const f = fixture(), view = f.mount();
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', report(4)));
        f.blockStorage(true); await view.controller.inspect();
        expect(f.create).not.toHaveBeenCalled(); expect(view.state().intent).toBeUndefined(); expect(view.state().error).toContain('Разрешите хранилище сайта');
        f.blockStorage(false);
        await view.controller.inspect();
        expect(f.create.mock.calls[0][0]).toMatchObject({deviceId: 'device-a', kind: 'runtime-cache-policy', runtimeCachePolicy: {schemaVersion: 1, action: 'inspect'}});
        expect(f.create.mock.calls[0][0]).not.toHaveProperty('projectId');
        view.controller.edit(1024.5); await view.controller.set();
        expect(f.create).toHaveBeenCalledOnce(); expect(view.state().error).toContain('целое число');

        view.controller.edit(4096);
        f.create.mockRejectedValueOnce({isAxiosError: true, response: {status: 409, data: {message: 'Ревизия изменилась. Обновите данные.'}}});
        await view.controller.set();
        expect(f.create.mock.calls[1][0].runtimeCachePolicy).toEqual({schemaVersion: 1, action: 'set', expectedRevision: 4, limitBytes: 4096 * runtimeCacheMiB});
        expect(view.state()).toMatchObject({draftMiB: 4096, busy: false, error: 'Ревизия изменилась. Обновите данные.'});
        expect(view.state().status?.limitBytes).toBe(2048 * runtimeCacheMiB); expect(view.state().intent).toBeUndefined();

        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', report(5, 3072)));
        await view.controller.inspect();
        expect(view.state()).toMatchObject({draftMiB: 4096, status: {revision: 5, limitBytes: 3072 * runtimeCacheMiB}});
        f.create.mockResolvedValueOnce(job('device-a'));
        await view.controller.set();
        expect(f.create.mock.calls[3][0].runtimeCachePolicy).toEqual({schemaVersion: 1, action: 'set', expectedRevision: 5, limitBytes: 4096 * runtimeCacheMiB});
        expect(view.state().intent?.jobId).toBeTruthy(); expect(view.state().status?.limitBytes).toBe(3072 * runtimeCacheMiB);
        f.jobs.mockResolvedValueOnce([job('device-a', 'succeeded', report(8, 4096))]);
        await view.controller.refresh();
        expect(view.state().status?.revision).toBe(5); expect(view.state().intent).toBeDefined(); expect(view.state().error).toContain('Квитанция не подтверждает');
        f.jobs.mockResolvedValueOnce([job('device-a', 'succeeded', {...report(6, 4096), usedBytes: 4097 * runtimeCacheMiB})]);
        await view.controller.refresh();
        expect(view.state().status?.revision).toBe(5); expect(view.state().intent).toBeDefined();
        f.jobs.mockResolvedValueOnce([job('device-a', 'succeeded', report(6, 4096))]);
        await view.controller.refresh();
        expect(view.state()).toMatchObject({draftMiB: 4096, dirty: false, status: {revision: 6, limitBytes: 4096 * runtimeCacheMiB}, error: ''});
        expect(view.state().intent).toBeUndefined(); expect(f.storage.size).toBe(0);
        view.controller.dispose();
    });

    it('recovers a lost ACK with the same exact request while OFF, without automatic resends or leaking late replies across account, role or device', async () => {
        const f = fixture(); let view = f.mount();
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', report())); await view.controller.inspect();
        view.controller.edit(3072); f.create.mockRejectedValueOnce(new Error('Ответ потерян')); await view.controller.set();
        const original = f.create.mock.calls[1][0]; expect(view.state().intent?.request).toEqual(original);
        view.controller.dispose(); f.disableSet(); view = f.mount();
        expect(f.create).toHaveBeenCalledTimes(2); expect(view.state()).toMatchObject({draftMiB: 3072, intent: {request: original}});
        const pending = deferred<IBridgeJob>(); f.create.mockReturnValueOnce(pending.promise);
        const recovering = view.controller.recover(); expect(f.create.mock.calls[2][0]).toEqual(original);
        f.owner('alice:observer');
        const anotherRole = f.mount(); pending.resolve(job('device-a', 'succeeded', report(1, 3072))); await recovering;
        expect(anotherRole.state().status).toBeUndefined(); expect(anotherRole.state().intent).toBeUndefined();
        expect(view.state().status).toBeUndefined(); view.controller.dispose(); anotherRole.controller.dispose();

        f.owner('bob:developer'); const anotherAccount = f.mount();
        expect(anotherAccount.state().status).toBeUndefined(); expect(anotherAccount.state().intent).toBeUndefined(); anotherAccount.controller.dispose();
        f.owner('alice:developer'); const anotherDevice = f.mount('device-b');
        expect(anotherDevice.state().status).toBeUndefined(); expect(anotherDevice.state().intent).toBeUndefined(); anotherDevice.controller.dispose();
        view = f.mount(); expect(f.create).toHaveBeenCalledTimes(3);
        f.create.mockRejectedValueOnce({isAxiosError: true, response: {status: 403}}); await view.controller.recover();
        expect(view.state().intent?.request).toEqual(original);
        f.create.mockResolvedValueOnce(job('device-a')); await view.controller.recover();
        expect(f.create.mock.calls[4][0]).toEqual(original);
        view.controller.dispose(); f.jobs.mockResolvedValueOnce([job('device-a', 'succeeded', report(0, 3072))]);
        view = f.mount(); await vi.waitFor(() => expect(view.state().status?.limitBytes).toBe(3072 * runtimeCacheMiB));
        expect(f.create).toHaveBeenCalledTimes(5); expect(view.state().intent).toBeUndefined(); expect(f.storage.size).toBe(0);
        view.controller.dispose();
    });
});

const cleanup = {enabled: true, keepPrevious: 2, minAgeDays: 7};
const maxTargetMiB = Math.floor(Number.MAX_SAFE_INTEGER / runtimeCacheMiB);
const cleanupReport = (revision = 0, policy = cleanup, limitMiB = 2048): RuntimeCachePolicyResult => ({...report(revision, limitMiB), schemaVersion: 2,
    minBytes: runtimeCacheMiB, maxBytes: maxTargetMiB * runtimeCacheMiB, cleanup: {...policy}});

describe('Soft runtime cache targets on capable bridges', () => {
    it('keeps only the current bridge after its exact zero-retention receipt, recovering a lost ACK with the same request', async () => {
        const f = fixture(true, true, true); let view = f.mount();
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport(3))); await view.controller.inspect();
        view.controller.editCleanup({keepPrevious: 0, minAgeDays: 0});
        f.create.mockRejectedValueOnce(new Error('Lost retention ACK')); await view.controller.setCleanup();
        const accepted = f.create.mock.calls[1]?.[0];
        expect(accepted?.runtimeCachePolicy).toEqual({schemaVersion: 2, action: 'set-cleanup', expectedRevision: 3,
            cleanup: {enabled: true, keepPrevious: 0, minAgeDays: 0}});
        view.controller.dispose(); view = f.mount();
        expect(view.state().intent?.request).toEqual(accepted);
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport(4, {enabled: true, keepPrevious: 0, minAgeDays: 0})));
        await view.controller.recover();
        expect(f.create.mock.lastCall?.[0]).toEqual(accepted);
        expect(view.state()).toMatchObject({cleanupPolicy: {keepPrevious: 0, minAgeDays: 0}, cleanupDirty: false, error: ''});
        expect(view.state().intent).toBeUndefined(); view.controller.dispose();
    });

    it('offers an update before sending a current-only policy to an older cleanup-capable bridge', async () => {
        const f = fixture(true, true), view = f.mount();
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport(3))); await view.controller.inspect();
        view.controller.editCleanup({keepPrevious: 0, minAgeDays: 0}); await view.controller.setCleanup();
        expect(f.create).toHaveBeenCalledOnce(); expect(view.state().intent).toBeUndefined();
        expect(view.state().error).toContain('Обновите мост');
        expect(view.state().cleanupDraft).toMatchObject({keepPrevious: 0, minAgeDays: 0}); view.controller.dispose();
    });

    it('uses v2 inspection for the target capability even without retention controls', async () => {
        const f = fixture(false, true), view = f.mount();
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport(3))); await view.controller.inspect();
        expect(f.create.mock.calls[0][0].runtimeCachePolicy).toEqual({schemaVersion: 2, action: 'inspect'});
        expect(view.state().status?.revision).toBe(3); view.controller.dispose();
    });

    it('accepts positive safe MiB targets above 16 GiB and below current usage, without discarding a retention draft', async () => {
        const f = fixture(true, true), view = f.mount();
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport(4))); await view.controller.inspect();
        expect(f.create.mock.calls[0][0].runtimeCachePolicy).toEqual({schemaVersion: 2, action: 'inspect'});
        expect(view.state().status?.revision).toBe(4);
        view.controller.editCleanup({keepPrevious: 4});
        for (const [revision, target] of [[5, 20480], [6, 1], [7, maxTargetMiB]]) {
            view.controller.edit(target);
            f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport(revision, cleanup, target)));
            await view.controller.set();
            expect(f.create.mock.lastCall?.[0].runtimeCachePolicy).toEqual({schemaVersion: 2, action: 'set', expectedRevision: revision - 1, limitBytes: target * runtimeCacheMiB});
            expect(view.state()).toMatchObject({draftMiB: target, dirty: false, status: {revision, limitBytes: target * runtimeCacheMiB}, cleanupDraft: {keepPrevious: 4}, cleanupDirty: true, error: ''});
            expect(view.state().intent).toBeUndefined();
        }
        for (const target of [0, -1, 1.5, maxTargetMiB + 1, Number.MAX_SAFE_INTEGER]) {
            view.controller.edit(target); await view.controller.set();
            expect(f.create).toHaveBeenCalledTimes(4); expect(view.state().draftMiB).toBe(target); expect(view.state().error).toContain('целое число');
        }
        view.controller.dispose();
    });

    it('keeps an exact v2 target intent after lost ACK and reload, reconciling the original key while OFF', async () => {
        const f = fixture(true, true); let view = f.mount();
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport(9))); await view.controller.inspect();
        expect(view.state().status?.revision).toBe(9);
        view.controller.edit(20480); view.controller.editCleanup({minAgeDays: 14});
        f.create.mockRejectedValueOnce(new Error('Lost target ACK')); await view.controller.set();
        const original = f.create.mock.calls[1][0];
        expect(original.runtimeCachePolicy).toEqual({schemaVersion: 2, action: 'set', expectedRevision: 9, limitBytes: 20480 * runtimeCacheMiB});
        view.controller.dispose(); f.disableSet(); view = f.mount();
        expect(f.create).toHaveBeenCalledTimes(2);
        expect(view.state()).toMatchObject({draftMiB: 20480, cleanupDraft: {minAgeDays: 14}, cleanupDirty: true, intent: {request: original}});
        const other = f.mount('device-b'); expect(other.state().intent).toBeUndefined(); other.controller.dispose();
        f.create.mockResolvedValueOnce(job('device-a')); await view.controller.recover();
        expect(f.create.mock.calls[2][0]).toEqual(original);
        f.jobs.mockResolvedValueOnce([job('device-a', 'succeeded', cleanupReport(12, cleanup, 20480))]); await view.controller.refresh();
        expect(view.state().status).toBeUndefined(); expect(view.state().intent?.request).toEqual(original);
        f.jobs.mockResolvedValueOnce([job('device-a', 'succeeded', {...cleanupReport(10, cleanup, 20480), minBytes: 1024 * runtimeCacheMiB})]); await view.controller.refresh();
        expect(view.state().status).toBeUndefined(); expect(view.state().intent?.request).toEqual(original);
        f.jobs.mockResolvedValueOnce([job('device-a', 'succeeded', {...cleanupReport(10, cleanup, 20480), usedBytes: 25000 * runtimeCacheMiB})]); await view.controller.refresh();
        expect(view.state()).toMatchObject({draftMiB: 20480, dirty: false, cleanupDraft: {minAgeDays: 14}, cleanupDirty: true, status: {revision: 10}, busy: false, error: ''});
        expect(view.state().intent).toBeUndefined(); expect(f.storage.size).toBe(0); view.controller.dispose();
    });
});

describe('Update backup retention in the existing cache settings', () => {
    it('inspects v2 only on capable bridges, saves cleanup independently and keeps an unsaved cache limit', async () => {
        const f = fixture(true), view = f.mount();
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport(4)));
        await view.controller.inspect();
        expect(f.create.mock.calls[0][0].runtimeCachePolicy).toEqual({schemaVersion: 2, action: 'inspect'});
        expect(view.state()).toMatchObject({cleanupDraft: cleanup, cleanupDirty: false});
        view.controller.edit(4096); view.controller.editCleanup({keepPrevious: 3, minAgeDays: 14});
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport(5, {...cleanup, keepPrevious: 3, minAgeDays: 14})));
        await view.controller.setCleanup();
        expect(f.create.mock.calls[1][0].runtimeCachePolicy).toEqual({schemaVersion: 2, action: 'set-cleanup', expectedRevision: 4,
            cleanup: {enabled: true, keepPrevious: 3, minAgeDays: 14}});
        expect(view.state()).toMatchObject({draftMiB: 4096, dirty: true, cleanupDirty: false, status: {revision: 5, limitBytes: 2048 * runtimeCacheMiB}});
        view.controller.editCleanup({keepPrevious: 4});
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', report(6, 4096)));
        await view.controller.set();
        expect(f.create.mock.calls[2][0].runtimeCachePolicy).toEqual({schemaVersion: 1, action: 'set', expectedRevision: 5, limitBytes: 4096 * runtimeCacheMiB});
        expect(view.state()).toMatchObject({draftMiB: 4096, dirty: false, cleanupDraft: {keepPrevious: 4}, cleanupDirty: true});
        view.controller.dispose();
    });

    it('retains the exact cleanup intent and both drafts through lost ACK and reload, then reconciles without a new key while OFF', async () => {
        const f = fixture(true); let view = f.mount();
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport(9))); await view.controller.inspect();
        view.controller.edit(3072); view.controller.editCleanup({enabled: true, keepPrevious: 5, minAgeDays: 30});
        f.create.mockRejectedValueOnce(new Error('Lost ACK')); await view.controller.setCleanup();
        const accepted = f.create.mock.calls[1][0];
        view.controller.dispose(); f.disableCleanup(); view = f.mount();
        expect(f.create).toHaveBeenCalledTimes(2);
        expect(view.state()).toMatchObject({draftMiB: 3072, dirty: true, cleanupDraft: {enabled: true, keepPrevious: 5, minAgeDays: 30}, cleanupDirty: true, intent: {request: accepted}});
        const otherDevice = f.mount('device-b'); expect(otherDevice.state().intent).toBeUndefined(); otherDevice.controller.dispose();
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport(10, {enabled: true, keepPrevious: 5, minAgeDays: 30})));
        await view.controller.recover();
        expect(f.create.mock.calls[2][0]).toEqual(accepted);
        expect(view.state()).toMatchObject({draftMiB: 3072, dirty: true, cleanupDirty: false, busy: false, error: ''});
        expect(view.state().intent).toBeUndefined(); expect(f.storage.size).toBe(0);
        view.controller.dispose();
    });

    it('checks fresh availability when enabling, allows disabling while OFF and blocks cleanup writes on legacy bridges', async () => {
        const f = fixture(true), view = f.mount();
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport(2))); await view.controller.inspect();
        view.controller.editCleanup({minAgeDays: 8}); f.disableCleanup(); await view.controller.setCleanup();
        expect(f.create).toHaveBeenCalledOnce(); expect(view.state().error).toBe('Очистка выключена');
        view.controller.editCleanup({enabled: false});
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport(3, {...cleanup, enabled: false, minAgeDays: 8})));
        await view.controller.setCleanup();
        expect(f.create.mock.calls[1][0].runtimeCachePolicy).toMatchObject({schemaVersion: 2, action: 'set-cleanup', cleanup: {enabled: false}});
        view.controller.dispose();

        const old = fixture(), legacy = old.mount();
        old.create.mockResolvedValueOnce(job('device-a', 'succeeded', report(3))); await legacy.controller.inspect();
        expect(old.create.mock.calls[0][0].runtimeCachePolicy).toEqual({schemaVersion: 1, action: 'inspect'});
        legacy.controller.editCleanup({enabled: false}); await legacy.controller.setCleanup();
        expect(old.create).toHaveBeenCalledOnce(); expect(legacy.state().error).toContain('Обновите мост'); legacy.controller.dispose();
    });

    it('rejects mismatched and malformed cleanup receipts while preserving the accepted request until confirmation', async () => {
        const f = fixture(true), view = f.mount();
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport(4))); await view.controller.inspect();
        view.controller.editCleanup({keepPrevious: 6}); f.create.mockResolvedValueOnce(job('device-a')); await view.controller.setCleanup();
        const intent = view.state().intent!.request;
        for (const result of [report(5), cleanupReport(5), cleanupReport(8, {...cleanup, keepPrevious: 6}),
            {...cleanupReport(5, {...cleanup, keepPrevious: 6}), cleanup: {...cleanup, keepPrevious: 6, privatePath: '/private'}}]) {
            f.jobs.mockResolvedValueOnce([job('device-a', 'succeeded', result)]); await view.controller.refresh();
            expect(view.state().status?.revision).toBe(4); expect(view.state().intent?.request).toEqual(intent);
            expect(view.state().cleanupDraft.keepPrevious).toBe(6); expect(view.state().error).toBeTruthy();
        }
        f.jobs.mockResolvedValueOnce([job('device-a', 'succeeded', cleanupReport(5, {...cleanup, keepPrevious: 6}))]); await view.controller.refresh();
        expect(view.state().intent).toBeUndefined(); expect(view.state().cleanupDirty).toBe(false); view.controller.dispose();
    });

    it('keeps invalid retention drafts without sending and ignores late cleanup completion after an owner change', async () => {
        const f = fixture(true), view = f.mount();
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', cleanupReport())); await view.controller.inspect();
        for (const patch of [{keepPrevious: 0}, {keepPrevious: 11}, {keepPrevious: 1.5}, {keepPrevious: 2, minAgeDays: null}, {minAgeDays: 91}]) {
            view.controller.editCleanup(patch); await view.controller.setCleanup();
            expect(f.create).toHaveBeenCalledOnce(); expect(view.state().cleanupDraft).toMatchObject(patch); expect(view.state().error).toBeTruthy();
        }
        view.controller.editCleanup({keepPrevious: 2, minAgeDays: 7});
        const held = deferred<IBridgeJob>(); f.create.mockReturnValueOnce(held.promise); const sending = view.controller.setCleanup();
        const accepted = f.create.mock.calls[1][0]; f.owner('bob:developer'); const other = f.mount();
        held.resolve(job('device-a', 'succeeded', cleanupReport(1))); await sending;
        expect(other.state().status).toBeUndefined(); expect(other.state().intent).toBeUndefined();
        view.controller.dispose(); other.controller.dispose();
        f.owner('alice:developer'); const remounted = f.mount();
        expect(remounted.state().intent?.request).toEqual(accepted); expect(f.create).toHaveBeenCalledTimes(2); remounted.controller.dispose();
    });

    it('recovers a legacy stored limit intent without new draft fields using its original v1 request', async () => {
        const f = fixture(), view = f.mount();
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', report())); await view.controller.inspect();
        view.controller.edit(3072); f.create.mockRejectedValueOnce(new Error('Lost old ACK')); await view.controller.set();
        const original = f.create.mock.calls[1][0];
        for (const [key, bytes] of f.storage) {
            const saved = JSON.parse(bytes); delete saved.dirty; delete saved.cleanupDraft; delete saved.cleanupDirty; f.storage.set(key, JSON.stringify(saved));
        }
        view.controller.dispose(); const next = f.mount();
        expect(next.state()).toMatchObject({draftMiB: 3072, dirty: true, cleanupDraft: {enabled: true, keepPrevious: 0, minAgeDays: 0}, intent: {request: original}});
        f.create.mockResolvedValueOnce(job('device-a', 'succeeded', report(1, 3072))); await next.controller.recover();
        expect(f.create.mock.calls[2][0]).toEqual(original); expect(next.state().intent).toBeUndefined(); next.controller.dispose();
    });
});
