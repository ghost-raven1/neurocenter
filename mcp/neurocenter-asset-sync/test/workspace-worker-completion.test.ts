import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, apiHub, stateDir, writeState } from '../src/bridge/state.js';
import { projectFolder, prepareProjectBinding } from '../src/bridge/workspace.js';
import * as completions from '../src/bridge/completions.js';
import { runWorker } from '../src/bridge/worker.js';
import { workspaceFixture } from './bridge-fixture.js';
import { idleSystemRoleMcpLane } from './worker-control-lane.fixture.js';
import { stopFixtureWorker } from './worker-lifecycle.fixture.js';

vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ auth: {}, on: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })) }));
vi.mock('../src/bridge/state.js', async original => ({ ...await original<typeof import('../src/bridge/state.js')>(), api: vi.fn() }));

describe('Worker не подменяет committed привязку ошибочным failed', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    let signals: Map<NodeJS.Signals, Set<(...args: unknown[]) => void>>;
    let controlLane: ReturnType<typeof idleSystemRoleMcpLane>;
    const job = { id: '11111111-1111-1111-1111-111111111111', lease: '22222222-2222-2222-2222-222222222222' };
    const deviceId = '33333333-3333-3333-3333-333333333333';
    beforeEach(async () => {
        fixture = await workspaceFixture(); vi.mocked(api).mockReset();
        signals = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal as NodeJS.Signals, new Set(process.listeners(signal).map(listener => listener as (...args: unknown[]) => void))]));
        controlLane = idleSystemRoleMcpLane(apiHub(), 'a'.repeat(64)); vi.stubGlobal('fetch', controlLane.network);
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    });
    afterEach(async () => {
        try { await stopFixtureWorker(signals); expect(controlLane.unexpected).toEqual([]); }
        finally {
            vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
            for (const [signal, previous] of signals) { for (const listener of process.listeners(signal)) { if (!previous.has(listener)) { process.off(signal, listener); } } }
            await fs.rm(fixture.temporary, { recursive: true, force: true });
        }
    });
    it.each([undefined, 1] as const)('Отказ привязки отдаёт безопасную причину только серверу с версией %s', async workspaceFailureVersion => {
        const marker = path.join(fixture.root, '.opencode/neurocenter.json');
        const raw = JSON.parse(await fs.readFile(marker, 'utf8')); raw.server = 'https://another.example.test';
        await fs.writeFile(marker, JSON.stringify(raw));
        await writeState('credentials', { token: 'a'.repeat(64), deviceId, email: 'fixture@example.test' });
        let claimed = false; const delivered: unknown[] = [];
        vi.mocked(api).mockImplementation(async (route, body) => {
            if (route === 'jobs/claim') {
                if (claimed) { return null as never; } claimed = true;
                return { ...job, project_id: 'test-project', kind: 'prepare-bind-project', payload: { folderName: path.basename(fixture.root), mode: 'new', workspaceFailureVersion } } as never;
            }
            if (route === `jobs/${job.id}/complete`) { delivered.push(body); }
            return {} as never;
        });
        vi.spyOn(process.stderr, 'write').mockReturnValue(true); vi.useFakeTimers(); await runWorker();
        expect(delivered).toEqual([expect.objectContaining({ ...job, state: 'failed',
            result: workspaceFailureVersion === 1 ? { workspaceFailure: 'foreign-binding' } : {} })]);
        expect(await fs.readFile(marker, 'utf8')).toBe(JSON.stringify(raw));
    });
    it.each([1, 2])('После %i сбоев durable success повторяет восстановление, не сохраняя failed', async failures => {
        const target = path.join(path.dirname(fixture.root), 'проверенная-копия'); await fs.cp(fixture.root, target, { recursive: true });
        const prepared = await prepareProjectBinding({ projectId: 'test-project', folderName: path.basename(target), mode: 'new-copy' });
        await writeState('credentials', { token: 'a'.repeat(64), deviceId, email: 'fixture@example.test' });
        const save = completions.saveCompletion; let attempts = 0; const states: string[] = [];
        vi.spyOn(completions, 'saveCompletion').mockImplementation(async completion => {
            states.push(completion.state); if (++attempts <= failures) { throw Object.assign(new Error('Диск временно заполнен.'), { code: 'ENOSPC' }); }
            return save(completion);
        });
        let claimed = false; const delivered: unknown[] = [];
        vi.mocked(api).mockImplementation(async (route, body) => {
            if (route === 'jobs/claim') {
                if (claimed) { return null as never; } claimed = true;
                return { ...job, project_id: 'test-project', kind: 'bind-project', payload: { preparation: prepared, mode: 'new-copy', folderName: path.basename(target), installations: [] } } as never;
            }
            if (route === `jobs/${job.id}/complete`) { delivered.push(body); }
            return {} as never;
        });
        vi.spyOn(process.stderr, 'write').mockReturnValue(true); vi.useFakeTimers(); await runWorker();
        if (failures === 2) {
            expect(delivered).toEqual([]); expect(await completions.pendingCompletions()).toEqual([]);
            expect(JSON.parse(await fs.readFile(path.join(stateDir(), 'workspace-identity-pending.json'), 'utf8')).state).toBe('committed');
            await vi.advanceTimersByTimeAsync(15000);
            await vi.waitFor(() => expect(delivered).toHaveLength(1));
        }
        expect(states.every(state => state === 'succeeded')).toBe(true); expect(delivered).toHaveLength(1);
        expect(delivered[0]).toMatchObject({ ...job, state: 'succeeded', result: { projectId: 'test-project', preparation: prepared.preparation } });
        expect(await projectFolder('test-project')).toBe(target); expect(await completions.pendingCompletions()).toEqual([]);
        await expect(fs.stat(path.join(stateDir(), 'workspace-identity-pending.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
