import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useCodexSupply, codexSupply} from '../src/features/OpenCodeProviders/useCodexSupply';
import api from '../src/core/api/base';
import {packagingApi} from '../src/modules/Store/packaging/api';
import {adminSetupHooks, deferredSetup, flushSetup} from './admin-setup-hooks.fixture';
import {jobId, preparationId} from './opencode-provider.fixture';

let hooks = adminSetupHooks(), enabled = true, canBuild = true;
const actor = vi.hoisted(() => ({value: 'admin-a'}));
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: (value: unknown) => hooks.state(value), useRef: (value: unknown) => hooks.ref(value),
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => hooks.effect(effect, deps)}));
vi.mock('../src/core/api/base', () => ({default: {get: vi.fn()}}));
vi.mock('../src/modules/Store/packaging/api', () => ({packagingApi: {create: vi.fn()}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {const owner = actor.value; return {scope: owner, captureOwner: () => () => owner === actor.value};}}));
function render() {hooks.begin(); const view = useCodexSupply(enabled, canBuild, 'Сборки выключены'); hooks.commit(); return view;}
const missing = {data: {state: 'missing'}};
const accepted = {id: jobId, operationId: preparationId, state: 'QUEUED' as const, percent: 0, message: ''};
beforeEach(() => {hooks = adminSetupHooks(); enabled = true; canBuild = true; actor.value = 'admin-a'; vi.resetAllMocks();
    vi.mocked(api.get).mockResolvedValue(missing); vi.mocked(packagingApi.create).mockResolvedValue(accepted);});
afterEach(() => {hooks.dispose(); vi.useRealTimers();});

describe('Fixed Codex connector supply from existing packaging API', () => {
    it('Non-main or another provider never queries privileged connector readiness', async () => {
        enabled = false; render(); await flushSetup(); expect(api.get).not.toHaveBeenCalled(); render().build(); expect(packagingApi.create).not.toHaveBeenCalled();
    });
    it('Readiness is read-only with a finite deadline and no descriptor/credentials', async () => {
        render(); await flushSetup(); expect(api.get).toHaveBeenCalledExactlyOnceWith('/api/tool-builds/connectors/codex', {timeout: 10000, signal: expect.any(AbortSignal)});
        expect(render().supply?.state).toBe('missing'); expect(packagingApi.create).not.toHaveBeenCalled();
    });
    it('Only fresh missing supply posts the fixed immutable repository recipe', async () => {
        render(); await flushSetup(); await render().build(); const request = vi.mocked(packagingApi.create).mock.calls[0][0];
        expect(request).toEqual({requestKey: expect.stringMatching(/^[a-f0-9-]{36}$/), kind: 'plugin', name: 'OpenCode Codex Bridge', description: 'Локальный auth-only коннектор Codex для OpenCode.',
            source: {type: 'repository', url: 'https://github.com/ghost-raven1/opencode_codex_bridge', ref: 'de21db304bef59af6421079c10e8a43404fd09fa', subdirectory: 'packages/bridge', entrypoint: 'src/plugin.ts'}});
        expect(api.get).toHaveBeenCalledTimes(2); expect(render().supply?.state).toBe('building');
    });
    it.each(['ready', 'building', 'conflict'] as const)('Fresh %s prevents a duplicate build even if a previous render said missing', async state => {
        render(); await flushSetup(); vi.mocked(api.get).mockResolvedValue({data: {state}}); await render().build(); expect(packagingApi.create).not.toHaveBeenCalled(); expect(render().supply?.state).toBe(state);
    });
    it('OFF preserves inspection but blocks a new build', async () => {
        canBuild = false; render(); await flushSetup(); await render().build(); expect(api.get).toHaveBeenCalledOnce(); expect(packagingApi.create).not.toHaveBeenCalled(); expect(render().error).toBe('Сборки выключены');
    });
    it.each(['flag', 'actor', 'unmount', 'mode'])('%s during held fresh readiness prevents POST', async change => {
        render(); await flushSetup(); const held = deferredSetup<{data: {state: string}}>(); vi.mocked(api.get).mockReturnValueOnce(held.promise); const running = render().build();
        if (change === 'flag') {canBuild = false; render();} if (change === 'actor') actor.value = 'admin-b'; if (change === 'unmount') hooks.dispose(); if (change === 'mode') {enabled = false; render();}
        held.resolve(missing); await running; expect(packagingApi.create).not.toHaveBeenCalled();
    });
    it('Unknown build ACK retains exact original UUID/body on retry', async () => {
        vi.mocked(packagingApi.create).mockRejectedValueOnce(new Error('lost ACK')); render(); await flushSetup(); await render().build(); expect(render().unknown).toBe(true);
        await render().build(); expect(packagingApi.create).toHaveBeenCalledTimes(2); expect(vi.mocked(packagingApi.create).mock.calls[1][0]).toEqual(vi.mocked(packagingApi.create).mock.calls[0][0]);
    });
    it('Malformed build ACK never counts as a known job or loses its key', async () => {
        vi.mocked(packagingApi.create).mockResolvedValueOnce({...accepted, id: 'foreign'}); render(); await flushSetup(); await render().build(); expect(render().unknown).toBe(true); expect(render().supply).toBeUndefined();
        await render().build(); expect(vi.mocked(packagingApi.create).mock.calls[1][0]).toEqual(vi.mocked(packagingApi.create).mock.calls[0][0]);
    });
    it('Double click before render cannot start two supply writes', async () => {
        render(); await flushSetup(); const held = deferredSetup<{data: {state: string}}>(); vi.mocked(api.get).mockReturnValueOnce(held.promise); const view = render(); const first = view.build(); const second = view.build();
        held.resolve(missing); await Promise.all([first, second]); expect(packagingApi.create).toHaveBeenCalledOnce();
    });
    it('Failed build is actionable; a later deliberate retry uses a new key', async () => {
        vi.mocked(packagingApi.create).mockResolvedValueOnce({...accepted, state: 'FAILED'}); render(); await flushSetup(); await render().build(); expect(render().error).toContain('Сборка остановилась');
        await render().build(); expect(vi.mocked(packagingApi.create).mock.calls[1][0].requestKey).not.toBe(vi.mocked(packagingApi.create).mock.calls[0][0].requestKey);
    });
    it('Building polls read-only and stops after ready; disposal leaves no timer', async () => {
        vi.useFakeTimers(); vi.mocked(api.get).mockResolvedValueOnce({data: {state: 'building', buildId: jobId}}).mockResolvedValue({data: {state: 'ready', buildId: jobId, targets: ['win32-x64']}});
        render(); await flushSetup(); render(); expect(vi.getTimerCount()).toBe(1); await vi.advanceTimersByTimeAsync(3000); render(); expect(render().supply?.state).toBe('ready');
        hooks.dispose(); expect(vi.getTimerCount()).toBe(0); expect(packagingApi.create).not.toHaveBeenCalled();
    });
    it('StrictMode effect replay aborts the old read and cannot replace the new ready snapshot', async () => {
        const first = deferredSetup<{data: {state: string}}>(); vi.mocked(api.get).mockReturnValueOnce(first.promise).mockResolvedValue({data: {state: 'ready', buildId: jobId, targets: ['darwin-arm64']}});
        render(); const firstSignal = vi.mocked(api.get).mock.calls[0][1]!.signal as AbortSignal;
        hooks.replayEffects(); await flushSetup(); expect(firstSignal.aborted).toBe(true); expect(render().supply?.state).toBe('ready');
        first.resolve(missing); await flushSetup(); expect(render().supply?.state).toBe('ready'); expect(packagingApi.create).not.toHaveBeenCalled();
    });
    it('Read failure removes stale readiness and an explicit retry recovers', async () => {
        vi.mocked(api.get).mockRejectedValueOnce(new Error('offline')); render(); await flushSetup(); expect(render().supply).toBeUndefined(); expect(render().error).toContain('offline');
        await render().reload(); expect(render().supply?.state).toBe('missing'); expect(render().error).toBe('');
    });
    it.each([null, [], {state: ['missing']}, {state: 'ready', targets: ['windows-x64']}, {state: 'ready', targets: ['linux-x64']},
        {state: 'ready', targets: ['win32-x64', 'win32-x64']}, {state: 'building', buildId: 'wrong'}, {state: 'ready', descriptor: {baseUrl: 'private'}}])('Malformed public readiness fails closed: %j', value => {
        expect(() => codexSupply(value)).toThrow();
    });
});
