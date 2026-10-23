import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useProviderSetup} from '../src/features/OpenCodeProviders/useProviderSetup';
import {providerSetupApi} from '../src/features/OpenCodeProviders/api';
import type {IProviderSetupJob, IProviderSetupRequest, IProviderSetupSelection} from '../src/features/OpenCodeProviders/types';
import {ack, bridgeFixture, configured, descriptor, preparation, preparationId, selection} from './opencode-provider.fixture';
import {adminSetupHooks, deferredSetup, flushSetup} from './admin-setup-hooks.fixture';

const state = vi.hoisted(() => ({owner: 'actor-a', incarnation: 0}));
let hooks = adminSetupHooks();
vi.mock('react', async original => ({...await original<typeof import('react')>(), useRef: (value: unknown) => hooks.ref(value),
    useState: (value: unknown) => hooks.state(value), useEffect: (effect: () => void | (() => void), deps: unknown[]) => hooks.effect(effect, deps)}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => {
    const actor = state.owner, incarnation = state.incarnation; return {scope: actor, captureOwner: () => () => state.owner === actor && state.incarnation === incarnation};
}}));
vi.mock('../src/features/OpenCodeProviders/api', () => ({providerSetupApi: {create: vi.fn()}}));
let bridge = bridgeFixture(), chosen: IProviderSetupSelection | undefined, canRead = true, canWrite = true;
function render() {hooks.begin(); const value = useProviderSetup({bridge, selection: chosen, canRead, canWrite, writeReason: 'Функция выключена'}); hooks.commit(); return value;}
function requested(index = 0): IProviderSetupRequest {return vi.mocked(providerSetupApi.create).mock.calls[index][0];}
function complete(input: IProviderSetupRequest, result: Record<string, unknown>, id?: string): IProviderSetupJob {return ack(input, {id: id ?? '55555555-5555-4555-8555-555555555555', state: 'succeeded', result});}
async function finishPrepare(patch: Partial<IProviderSetupJob> = {}) {
    bridge.jobs = [complete(requested(), preparation(), undefined), ...bridge.jobs].map((job, index) => index ? job : {...job, id: ack(requested()).id, ...patch});
    render(); await flushSetup(); return render();
}
beforeEach(() => {hooks = adminSetupHooks(); state.owner = 'actor-a'; state.incarnation = 0; bridge = bridgeFixture(); chosen = {...selection}; canRead = true; canWrite = true;
    vi.resetAllMocks(); vi.mocked(providerSetupApi.create).mockImplementation(async input => ack(input));});
afterEach(() => hooks.dispose());

describe('Local provider request ownership and ACK recovery', () => {
    it('Ollama prepare→open→check preserves its catalog pin and requires a deliberate readiness check', async () => {
        chosen = {...selection, providerKind: 'ollama'};
        const providerId = 'neurocenter-ollama-0123456789abcdef';
        const ids = {'prepare-opencode-provider': '33333333-3333-4333-8333-333333333333', 'open-opencode-provider': '55555555-5555-4555-8555-555555555555', 'get-opencode-provider-status': '66666666-6666-4666-8666-666666666666'};
        vi.mocked(providerSetupApi.create).mockImplementation(async input => ack(input, {id: ids[input.kind], providerKind: 'ollama', providerId, state: 'succeeded',
            result: {...(input.kind === 'get-opencode-provider-status' ? configured() : preparation()), providerKind: 'ollama', providerId,
                ...(input.kind === 'open-opencode-provider' ? {opened: true} : {})}}));
        render().open(); await flushSetup(); render(); await flushSetup(); render(); let view = render();
        expect(providerSetupApi.create).toHaveBeenCalledTimes(2); expect(requested()).toMatchObject({...chosen, kind: 'prepare-opencode-provider'});
        expect(requested(1)).toMatchObject({...chosen, kind: 'open-opencode-provider', expectedProviderSchemaDigest: descriptor.schemaDigest});
        expect(view.opened?.providerKind).toBe('ollama'); expect(view.status).toBeUndefined();
        view.check(); await flushSetup(); render(); await flushSetup(); view = render();
        expect(requested(2)).toMatchObject({...chosen, kind: 'get-opencode-provider-status'}); expect(view.status?.ready).toBe(true);
    });
    it('A late Ollama ACK cannot open a local window after switching to OpenAI', async () => {
        chosen = {...selection, providerKind: 'ollama'};
        const held = deferredSetup<unknown>(); vi.mocked(providerSetupApi.create).mockReturnValue(held.promise); bridge.reload = vi.fn(async () => undefined);
        render().open(); chosen = {...selection}; render();
        held.resolve(ack(requested(), {providerKind: 'ollama', providerId: 'neurocenter-ollama-0123456789abcdef', state: 'succeeded',
            result: {...preparation(), providerKind: 'ollama', providerId: 'neurocenter-ollama-0123456789abcdef'}}));
        await flushSetup(); const view = render(); expect(view.opened).toBeUndefined(); expect(view.preparation).toBeUndefined();
        expect(bridge.reload).not.toHaveBeenCalled(); expect(providerSetupApi.create).toHaveBeenCalledOnce();
    });
    it('Prepare→open uses exact server preparation; successful open is not inference readiness', async () => {
        render().open(); await flushSetup(); expect(requested().kind).toBe('prepare-opencode-provider');
        await finishPrepare(); expect(providerSetupApi.create).toHaveBeenCalledTimes(2);
        expect(requested(1)).toMatchObject({kind: 'open-opencode-provider', preparationJobId: ack(requested()).id, expectedProviderSchemaDigest: descriptor.schemaDigest});
        const open = ack(requested(1), {id: '66666666-6666-4666-8666-666666666666', state: 'succeeded', result: {...preparation(), opened: true}});
        bridge.jobs = [open]; vi.mocked(providerSetupApi.create).mock.results[1];
        // The create ACK must have the same job ID as its terminal record.
        const value = render(); expect(value.status).toBeUndefined(); expect(value.opened).toBeUndefined();
    });
    it('A valid synchronous completed open is displayed, then explicit check grants config readiness', async () => {
        vi.mocked(providerSetupApi.create).mockImplementation(async input => input.kind === 'open-opencode-provider'
            ? complete(input, {...preparation(), opened: true}) : input.kind === 'get-opencode-provider-status' ? complete(input, configured()) : ack(input));
        render().open(); await flushSetup(); await finishPrepare(); render(); await flushSetup(); let view = render();
        expect(view.opened?.preparationId).toBe(preparationId); expect(view.status).toBeUndefined();
        bridge.jobs = []; view.check(); await flushSetup(); render(); await flushSetup(); view = render(); expect(view.status?.ready).toBe(true);
    });
    it.each(['network', 'malformed', 'foreign'])('Unknown %s ACK replays exact original request key', async failure => {
        vi.mocked(providerSetupApi.create).mockImplementationOnce(async input => {if (failure === 'network') throw new Error('offline');
            return failure === 'malformed' ? {id: 'incomplete'} : ack(input, {deviceId: 'foreign'});});
        render().open(); await flushSetup(); let view = render(); expect(view.unknown).toBe(true); expect(view.error).not.toBe('');
        view.retry(); await flushSetup(); view = render(); expect(requested(1)).toEqual(requested()); expect(view.pending).toBe(true);
    });
    it('A public terminal report with a private endpoint is never accepted; replay retains original key', async () => {
        vi.mocked(providerSetupApi.create).mockImplementation(async input => complete(input, {...preparation(), baseUrl: 'https://private.invalid'}));
        render().open(); await flushSetup(); render(); await flushSetup(); const view = render(); expect(view.unknown).toBe(true);
        view.retry(); await flushSetup(); expect(requested(1)).toEqual(requested()); expect(providerSetupApi.create).toHaveBeenCalledTimes(2);
    });
    it('Flag OFF between prepare ACK and result prevents a new open job', async () => {
        render().open(); await flushSetup(); canWrite = false; const view = await finishPrepare();
        expect(providerSetupApi.create).toHaveBeenCalledOnce(); expect(view.error).toBe('Функция выключена');
        canWrite = true; bridge.jobs = []; render().open(); await flushSetup(); expect(requested(1).kind).toBe('prepare-opencode-provider');
    });
    it.each(['read', 'selection'])('Current %s revocation while waiting prevents continuation', async change => {
        render().open(); await flushSetup(); if (change === 'read') canRead = false; else chosen = undefined;
        await finishPrepare(); expect(providerSetupApi.create).toHaveBeenCalledOnce();
    });
    it('Actor change before render discards late ACK and never reloads another account', async () => {
        const held = deferredSetup<unknown>(); vi.mocked(providerSetupApi.create).mockReturnValue(held.promise); const reload = vi.fn(async () => undefined); bridge.reload = reload;
        render().open(); state.owner = 'actor-b'; held.resolve(ack(requested())); await flushSetup(); expect(reload).not.toHaveBeenCalled(); expect(providerSetupApi.create).toHaveBeenCalledOnce();
    });
    it('A→B→A target roundtrip rejects old A result and old handler', async () => {
        const held = deferredSetup<unknown>(); vi.mocked(providerSetupApi.create).mockReturnValueOnce(held.promise); const old = render(); old.open();
        chosen = {...selection, projectId: 'prj-other'}; render(); chosen = {...selection}; render(); old.open(); held.resolve(ack(requested())); await flushSetup();
        expect(providerSetupApi.create).toHaveBeenCalledOnce(); expect(render().pending).toBe(false);
    });
    it('Selection A→B→A preserves original uncertain A key without applying its late result', async () => {
        vi.mocked(providerSetupApi.create).mockRejectedValueOnce(new Error('lost A'));
        render().open(); await flushSetup(); expect(render().unknown).toBe(true); const original = requested();
        chosen = {...selection, projectId: 'prj-other'}; render(); chosen = {...selection}; render();
        render().retry(); await flushSetup(); expect(providerSetupApi.create).toHaveBeenCalledTimes(2); expect(requested(1)).toEqual(original);
    });
    it('Unmount before ACK prevents reload and the follow-up open', async () => {
        const held = deferredSetup<unknown>(); vi.mocked(providerSetupApi.create).mockReturnValue(held.promise); bridge.reload = vi.fn(async () => undefined);
        render().open(); hooks.dispose(); held.resolve(complete(requested(), preparation())); await flushSetup(); expect(bridge.reload).not.toHaveBeenCalled(); expect(providerSetupApi.create).toHaveBeenCalledOnce();
    });
    it('Double primary click before render is one request', () => {const held = deferredSetup<unknown>(); vi.mocked(providerSetupApi.create).mockReturnValue(held.promise); const view = render(); view.open(); view.open(); expect(providerSetupApi.create).toHaveBeenCalledOnce();});
    it('Matching pending job survives modal remount and blocks duplicate requests', () => {bridge.jobs = [ack({...selection, kind: 'prepare-opencode-provider', requestKey: preparationId})]; const view = render(); expect(view.pending).toBe(true); view.open(); view.check(); expect(providerSetupApi.create).not.toHaveBeenCalled();});
    it('A different target pending job does not block this setup', async () => {bridge.jobs = [ack({...selection, kind: 'prepare-opencode-provider', requestKey: preparationId}, {expectedInstanceId: preparationId})]; render().open(); await flushSetup(); expect(providerSetupApi.create).toHaveBeenCalledOnce();});
    it('OFF keeps status and queue recovery available without allowing a write', async () => {canWrite = false; const view = render(); view.open(); expect(providerSetupApi.create).not.toHaveBeenCalled(); view.check(); await flushSetup(); expect(requested().kind).toBe('get-opencode-provider-status');});
    it('Checking status while a write ACK is unknown does not lose its original retry', async () => {
        vi.mocked(providerSetupApi.create).mockRejectedValueOnce(new Error('lost')).mockImplementation(async input => complete(input, configured()));
        render().open(); await flushSetup(); render().check(); await flushSetup(); render(); await flushSetup(); let view = render();
        expect(view.unknown).toBe(true); expect(view.status).toBeUndefined(); bridge.jobs = []; view.retry(); await flushSetup(); view = render();
        expect(requested(2)).toEqual(requested());
    });
    it.each(['failed', 'cancelled'])('Terminal %s permits a fresh deliberate attempt', async state => {
        render().open(); await flushSetup(); await finishPrepare({state}); bridge.jobs = []; const view = render(); expect(view.pending).toBe(false); expect(view.error).not.toBe(''); view.open(); await flushSetup(); expect(requested(1).requestKey).not.toBe(requested().requestKey);
    });
    it('Expired preparation never opens the browser; next primary obtains a fresh preparation', async () => {
        render().open(); await flushSetup(); await finishPrepare({result: {...preparation(), expiresAt: new Date(Date.now() - 1000).toISOString()}}); expect(providerSetupApi.create).toHaveBeenCalledOnce();
        bridge.jobs = []; render().open(); await flushSetup(); expect(requested(1).kind).toBe('prepare-opencode-provider'); expect(requested(1).requestKey).not.toBe(requested().requestKey);
    });
    it('Status rehydrates after remount but is hidden while a new wizard request is in flight', () => {
        const input = {...selection, kind: 'get-opencode-provider-status' as const, requestKey: preparationId}; bridge.jobs = [complete(input, configured())];
        let view = render(); expect(view.status?.ready).toBe(true); const held = deferredSetup<unknown>(); vi.mocked(providerSetupApi.create).mockReturnValue(held.promise); view.open(); view = render(); expect(view.status).toBeUndefined();
    });
    it('Queue read failure stays actionable and never clears a retained uncertain key', async () => {
        vi.mocked(providerSetupApi.create).mockRejectedValue(new Error('lost')); bridge.reload = vi.fn(async () => {throw new Error('read failed');}); render().open(); await flushSetup(); render().reload(); await flushSetup(); const view = render(); expect(view.unknown).toBe(true); expect(view.error).toContain('перечитать очередь');
    });
});
