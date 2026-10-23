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
function fixture() {
    let owner = 'alice:developer', setReason = '', storageBlocked = false;
    const storage = new Map<string, string>(), create = vi.fn<(request: Request) => Promise<IBridgeJob>>(), jobs = vi.fn<() => Promise<IBridgeJob[]>>();
    const mount = (deviceId = 'device-a') => {
        const captured = owner; let state: RuntimeCacheSettingsState = initialRuntimeCacheSettings();
        const controller = createRuntimeCacheSettings({scope: captured, deviceId, captureOwner: () => () => owner === captured,
            storage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => {if (storageBlocked) throw new Error('Quota exceeded'); storage.set(key, value);}, removeItem: key => {storage.delete(key);}},
            create, jobs, inspectReason: () => '', setReason: () => setReason, onChange: next => {state = next;}});
        controller.activate(); return {controller, state: () => state};
    };
    return {mount, storage, create, jobs, owner: (value: string) => {owner = value;}, disableSet: () => {setReason = 'Функция выключена';}, blockStorage: (value: boolean) => {storageBlocked = value;}};
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
