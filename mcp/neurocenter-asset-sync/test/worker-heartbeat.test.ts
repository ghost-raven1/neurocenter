import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as state from '../src/bridge/state.js';
import * as workspace from '../src/bridge/workspace.js';
import { prepareJobRuntimeArtifacts } from '../src/bridge/job-runtime-artifacts.js';
import { install } from '../src/bridge/installer.js';
import { runWorker } from '../src/bridge/worker.js';
import { packageFixture, workspaceFixture } from './bridge-fixture.js';
import { idleSystemRoleMcpLane } from './worker-control-lane.fixture.js';
import { stopFixtureWorker } from './worker-lifecycle.fixture.js';

const socket = vi.hoisted(() => ({ auth: {}, on: vi.fn(), disconnect: vi.fn(), connect: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: vi.fn(() => socket) }));
vi.mock('../src/bridge/state.js', async original => ({ ...await original<typeof import('../src/bridge/state.js')>(), api: vi.fn() }));
vi.mock('../src/bridge/job-runtime-artifacts.js', () => ({ prepareJobRuntimeArtifacts: vi.fn() }));
vi.mock('../src/bridge/installer.js', async original => ({ ...await original<typeof import('../src/bridge/installer.js')>(), install: vi.fn() }));

const originalReadState = state.readState;
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe('Heartbeat сохраняется во время длительной установки', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>> | undefined;
    let previousSignals: Map<NodeJS.Signals, Set<(...args: unknown[]) => void>>;
    let gate: ReturnType<typeof deferred>;
    let entered: ReturnType<typeof deferred>;
    let releases: Array<() => void>;
    let setup: Promise<void> | undefined;
    let worker: Promise<void> | undefined;
    let lastSeen: number;
    let heartbeat: () => Promise<unknown>;
    let revoked: boolean;
    let credentials: state.Credentials;
    let controlLane: ReturnType<typeof idleSystemRoleMcpLane>;
    let controlLanes: Array<ReturnType<typeof idleSystemRoleMcpLane>>;
    const jobId = '11111111-1111-1111-1111-111111111111';
    const paused = () => { const pending = deferred(); releases.push(pending.resolve); return pending; };
    beforeEach(context => {
        fixture = undefined; worker = undefined; setup = undefined; releases = []; controlLanes = []; vi.clearAllMocks();
        previousSignals = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal as NodeJS.Signals, new Set(process.listeners(signal))]));
        gate = paused(); entered = paused();
        setup = (async () => {
            fixture = await workspaceFixture(); context.signal.throwIfAborted();
            credentials = { token: 'fixture-token', deviceId: '33333333-3333-3333-3333-333333333333', email: 'fixture@example.test' };
            controlLane = idleSystemRoleMcpLane(state.apiHub(), credentials.token); controlLanes.push(controlLane);
            vi.stubGlobal('fetch', (...args: Parameters<typeof fetch>) => controlLane.network(...args));
            socket.disconnect.mockReturnValue(socket); socket.connect.mockReturnValue(socket);
            await state.writeState('credentials', credentials); context.signal.throwIfAborted();
            vi.spyOn(state, 'readState').mockImplementation(async name => name === 'credentials' ? credentials as never : originalReadState(name));
            const report = await workspace.workspaceReport(); context.signal.throwIfAborted();
            vi.spyOn(workspace, 'workspaceReport').mockResolvedValue(report);
            vi.spyOn(process.stderr, 'write').mockReturnValue(true);
            vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
            lastSeen = 0; revoked = false;
            heartbeat = async () => { lastSeen = Date.now(); return {}; };
            vi.mocked(prepareJobRuntimeArtifacts).mockImplementation(async () => { entered.resolve(); await gate.promise; });
            vi.mocked(install).mockImplementation(async (_project, _pkg, authorize) => { await authorize?.(); return {} as never; });
            const bindingId = await workspace.projectBindingId('test-project'); context.signal.throwIfAborted();
            let claimed = false;
            vi.mocked(state.api).mockImplementation(async route => {
                if (route === 'heartbeat') return await heartbeat() as never;
                if (route.endsWith('/authorize') && revoked) throw new Error('Права отозваны');
                if (route === 'jobs/claim') {
                    if (claimed) return null as never;
                    claimed = true;
                    return { id: jobId, lease: '22222222-2222-2222-2222-222222222222', kind: 'install', project_id: 'test-project',
                        payload: { package: packageFixture(), bindingId } } as never;
                }
                return {} as never;
            });
            vi.useFakeTimers();
            worker = runWorker(); await entered.promise; context.signal.throwIfAborted();
        })();
        return setup;
    });
    const calls = (route: string) => vi.mocked(state.api).mock.calls.filter(([value]) => value === route).length;
    async function stop(): Promise<void> {
        await stopFixtureWorker(previousSignals);
    }
    afterEach(async () => {
        try {
            for (const release of releases) { release(); }
            await setup?.catch(() => undefined);
            for (const release of releases) { release(); }
            await worker;
        } finally {
            try { await stop(); for (const lane of controlLanes) expect(lane.unexpected).toEqual([]); }
            finally {
                if (vi.isFakeTimers()) { vi.clearAllTimers(); vi.useRealTimers(); }
                vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
                for (const [signal, previous] of previousSignals) for (const listener of process.listeners(signal)) if (!previous.has(listener)) process.off(signal, listener);
                if (fixture) { await fs.rm(fixture.temporary, { recursive: true, force: true }); }
            }
        }
    });

    it('После 90 секунд heartbeat и renew свежие, а claim и установка остаются последовательными', async () => {
        await vi.advanceTimersByTimeAsync(90_000);
        expect(Date.now() - lastSeen).toBeLessThan(40_000);
        expect(calls('heartbeat')).toBeGreaterThanOrEqual(7);
        expect(calls(`jobs/${jobId}/progress`)).toBe(3);
        for (const [, callback] of socket.on.mock.calls.filter(([event]) => event === 'bridge:work')) callback();
        expect(calls('jobs/claim')).toBe(1);
        expect(prepareJobRuntimeArtifacts).toHaveBeenCalledOnce();
        expect(install).not.toHaveBeenCalled();
        gate.resolve(); await worker;
        expect(install).toHaveBeenCalledOnce();
        expect(calls('jobs/claim')).toBe(2);
        await stop();
        const count = vi.mocked(state.api).mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(vi.mocked(state.api).mock.calls).toHaveLength(count);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('Медленный heartbeat не запускается параллельно повторным timer или завершению job', async () => {
        const pending = paused();
        heartbeat = async () => { await pending.promise; lastSeen = Date.now(); return {}; };
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calls('heartbeat')).toBe(2);
        expect(calls('jobs/claim')).toBe(1);
        gate.resolve();
        pending.resolve(); await worker;
        expect(install).toHaveBeenCalledOnce();
        expect(calls('heartbeat')).toBeLessThanOrEqual(3);
    });

    it('Ошибка авторизации heartbeat видна оператору и не отменяет повторную авторизацию перед установкой', async () => {
        revoked = true;
        heartbeat = async () => { throw new Error('Heartbeat HTTP 401: права отозваны'); };
        await vi.advanceTimersByTimeAsync(45_000);
        expect(calls('heartbeat')).toBe(4);
        expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('Heartbeat HTTP 401'));
        gate.resolve(); await worker;
        const completion = vi.mocked(state.api).mock.calls.find(([route]) => route === `jobs/${jobId}/complete`)?.[1];
        expect(completion).toMatchObject({ state: 'failed' });
        expect(calls(`jobs/${jobId}/authorize`)).toBeGreaterThanOrEqual(2);
        expect(calls('jobs/claim')).toBe(1);
    });

    it('Смена подключения во время heartbeat не меняет владельца уже полученного задания', async () => {
        const deviceId = credentials.deviceId;
        expect(vi.mocked(state.api).mock.calls.find(([route]) => route === 'jobs/claim'))
            .toEqual(['jobs/claim', undefined, credentials.token]);
        credentials = { ...credentials, token: 'new-fixture-token', deviceId: '44444444-4444-4444-4444-444444444444' };
        controlLane = idleSystemRoleMcpLane(state.apiHub(), credentials.token); controlLanes.push(controlLane);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(socket.auth).toEqual({ token: credentials.token });
        gate.resolve(); await worker;
        const completion = JSON.parse(await fs.readFile(path.join(state.stateDir(), 'completions', 'previous-devices', jobId + '.json'), 'utf8'));
        expect(completion).toMatchObject({ state: 'succeeded', deviceId });
        expect(calls(`jobs/${jobId}/complete`)).toBe(0);
    });

    it('Stop во время job прекращает heartbeat и не позволяет claim после завершения текущей работы', async () => {
        await stop();
        const before = calls('heartbeat');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calls('heartbeat')).toBe(before);
        gate.resolve(); await worker;
        expect(calls('heartbeat')).toBe(before);
        expect(calls('jobs/claim')).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('Stop во время подготовки отчёта не отправляет отложенный heartbeat', async () => {
        const report = await workspace.workspaceReport();
        const pending = paused();
        vi.mocked(workspace.workspaceReport).mockImplementation(async () => { await pending.promise; return report; });
        await vi.advanceTimersByTimeAsync(15_000);
        expect(calls('heartbeat')).toBe(1);
        await stop(); pending.resolve(); gate.resolve(); await worker;
        expect(calls('heartbeat')).toBe(1);
        expect(calls('jobs/claim')).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('Повторяемый 409 квитанции не делает работающий компьютер offline и не повторяет установку', async () => {
        const originalApi = vi.mocked(state.api).getMockImplementation()!;
        const completeRoute = `jobs/${jobId}/complete`;
        vi.mocked(state.api).mockImplementation(async (...args) => {
            if (args[0] === completeRoute) { throw new Error('HTTP 409: completion conflict'); }
            return originalApi(...args);
        });
        gate.resolve(); await worker;
        const completionFile = path.join(state.stateDir(), 'completions', jobId + '.json');
        const bytes = await fs.readFile(completionFile);
        const before = await fs.stat(completionFile, { bigint: true });
        expect(JSON.parse(bytes.toString())).toMatchObject({ id: jobId, state: 'succeeded' });
        const initialAttempts = calls(completeRoute);
        for (let tick = 1; tick <= 6; tick++) {
            await vi.advanceTimersByTimeAsync(15_000);
            await vi.waitFor(() => expect(calls(completeRoute)).toBeGreaterThanOrEqual(initialAttempts + tick));
        }
        expect(Date.now() - lastSeen).toBeLessThan(40_000);
        expect(await fs.readFile(completionFile)).toEqual(bytes);
        const after = await fs.stat(completionFile, { bigint: true });
        expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.mtimeNs, before.ctimeNs]);
        expect(prepareJobRuntimeArtifacts).toHaveBeenCalledOnce();
        expect(install).toHaveBeenCalledOnce();
        expect(calls('jobs/claim')).toBe(1);
        expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('HTTP 409'));
    });

    it('Отказ восстановления до доставки не блокирует heartbeat простаивающего worker', async () => {
        gate.resolve(); await worker;
        const recovery = vi.spyOn(workspace, 'recoverPendingWorkspaceIdentity')
            .mockRejectedValue(new Error('Controlled workspace recovery failure'));
        const claims = calls('jobs/claim');
        for (let tick = 1; tick <= 6; tick++) {
            await vi.advanceTimersByTimeAsync(15_000);
            await vi.waitFor(() => expect(recovery).toHaveBeenCalledTimes(tick));
        }
        expect(Date.now() - lastSeen).toBeLessThan(40_000);
        expect(calls('jobs/claim')).toBe(claims);
        expect(install).toHaveBeenCalledOnce();
        expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('Controlled workspace recovery failure'));
    });
});
