import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, apiHub, writeState } from '../src/bridge/state.js';
import { commitProjectBinding, prepareProjectBinding, projectBindingId } from '../src/bridge/workspace.js';
import * as workspace from '../src/bridge/workspace.js';
import { install } from '../src/bridge/installer.js';
import { runWorker } from '../src/bridge/worker.js';
import { pendingCompletions } from '../src/bridge/completions.js';
import * as inspection from '../src/bridge/installation-inspection.js';
import { assertInspectionIdentity } from '../src/bridge/inspection-identity.js';
import { packageFixture, workspaceFixture } from './bridge-fixture.js';
import type { InstallationInspection } from '../src/bridge/installation-inspection.model.js';
import { idleSystemRoleMcpLane } from './worker-control-lane.fixture.js';
import { stopFixtureWorker } from './worker-lifecycle.fixture.js';

vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ auth: {}, on: vi.fn(), disconnect: vi.fn(), connect: vi.fn() })) }));
vi.mock('../src/bridge/state.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/bridge/state.js')>(), api: vi.fn() }));

describe('Идентичность результата инспекции закреплена за исходным заданием', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    let signals: Map<NodeJS.Signals, Set<(...args: unknown[]) => void>>;
    let controlLane: ReturnType<typeof idleSystemRoleMcpLane>;
    const pkg = packageFixture();
    const jobId = '11111111-1111-1111-1111-111111111111';
    const lease = '22222222-2222-2222-2222-222222222222';
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
    it('Переключение A → B внутри scanner доставляет failed completion с binding A без зависшего pending', async () => {
        await install('test-project', pkg, async () => undefined, async () => undefined);
        const bindingA = await projectBindingId('test-project');
        const other = path.join(path.dirname(fixture.root), 'папка-B'); await fs.mkdir(path.join(other, '.opencode'), { recursive: true });
        await fs.writeFile(path.join(other, '.opencode/neurocenter.json'), await fs.readFile(path.join(fixture.root, '.opencode/neurocenter.json')));
        await commitProjectBinding(await prepareProjectBinding({ projectId: 'test-project', folderName: path.basename(other), mode: 'new-copy' }), async () => undefined);
        await install('test-project', pkg, async () => undefined, async () => undefined);
        const bindingB = await projectBindingId('test-project'); expect(bindingB).not.toBe(bindingA);
        await writeState('workspace', { root: fixture.temporary, bindings: { 'test-project': fixture.root } });
        await writeState('credentials', { token: 'a'.repeat(64), deviceId, email: 'fixture@example.test' });
        const projectFolder = workspace.projectFolder; let switched = false;
        vi.spyOn(workspace, 'projectFolder').mockImplementation(async projectId => {
            const folder = await projectFolder(projectId);
            if (!switched) {
                switched = true;
                await writeState('workspace', { root: fixture.temporary, bindings: { 'test-project': other } });
            }
            return folder;
        });
        const inspect = inspection.inspectInstallation;
        vi.spyOn(inspection, 'inspectInstallation').mockImplementation(async (projectId, frozen) => {
            const result = await inspect(projectId, frozen);
            expect(result.bindingId).toBe(bindingB); expect(result.issues).toEqual(['binding-changed']); return result;
        });
        let claimed = false; let delivered: Record<string, unknown> | undefined;
        vi.mocked(api).mockImplementation(async (route, body) => {
            if (route === 'jobs/claim') {
                if (claimed) { return null as never; } claimed = true;
                return { id: jobId, lease, project_id: 'test-project', kind: 'inspect-installation', payload: { package: pkg, bindingId: bindingA } } as never;
            }
            if (route === `jobs/${jobId}/complete`) {
                const completion = body as { state: string; result: Record<string, unknown> };
                if (completion.result.bindingId !== bindingA) { throw new Error('HTTP 409: результат относится к другой папке'); }
                delivered = completion as unknown as Record<string, unknown>; return {} as never;
            }
            return {} as never;
        });
        vi.useFakeTimers();
        await runWorker();
        expect(delivered).toMatchObject({ state: 'failed', result: { projectId: 'test-project', bindingId: bindingA, assetId: pkg.plugin.id,
            assetKind: pkg.plugin.kind, version: pkg.plugin.version, manifest: pkg.manifest.sha256, state: 'checked', status: 'unknown', issues: ['inspection-failed'] } });
        expect(await pendingCompletions()).toEqual([]);
        expect(JSON.stringify(delivered)).not.toContain(other); expect(JSON.stringify(delivered)).not.toContain(bindingB);
    });
    it.each(['projectId', 'bindingId', 'assetId', 'assetKind', 'version', 'manifest'] as const)('Не принимает подмену поля %s', field => {
        const value: InstallationInspection = { schemaVersion: 1, projectId: 'test-project', bindingId: 'a'.repeat(64), assetId: pkg.plugin.id,
            assetKind: pkg.plugin.kind, version: pkg.plugin.version, manifest: pkg.manifest.sha256, checkedAt: new Date().toISOString(), readiness: 'unverified',
            state: 'checked', status: 'synced', issues: [] };
        expect(() => assertInspectionIdentity(value, 'test-project', 'a'.repeat(64), pkg)).not.toThrow();
        const changed = { ...value, [field]: field === 'version' ? 2 : 'Подмена' };
        expect(() => assertInspectionIdentity(changed, 'test-project', 'a'.repeat(64), pkg)).toThrow('исходному заданию');
    });
});
