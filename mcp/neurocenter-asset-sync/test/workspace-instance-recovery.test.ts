import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitProjectBinding, prepareProjectBinding, projectFolder, projectInstanceId, recoverPendingWorkspaceIdentity } from '../src/bridge/workspace.js';
import { jobContext, stateDir } from '../src/bridge/state.js';
import * as completions from '../src/bridge/completions.js';
import * as atomic from '../src/bridge/atomic-file.js';
import { registryFile } from '../src/bridge/workspace-identity-state.js';
import { workspaceFixture } from './bridge-fixture.js';

describe('Восстановление идентичности после остановки MCP', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    const job = { id: '11111111-1111-1111-1111-111111111111', lease: '22222222-2222-2222-2222-222222222222', deviceId: '33333333-3333-3333-3333-333333333333' };
    const marker = (root: string) => path.join(root, '.opencode/neurocenter.json');
    const pending = () => path.join(stateDir(), 'workspace-identity-pending.json');
    const prepareCopy = async () => {
        const target = path.join(path.dirname(fixture.root), 'Копия'); await fs.cp(fixture.root, target, { recursive: true });
        return { target, prepared: await prepareProjectBinding({ projectId: 'test-project', folderName: path.basename(target), mode: 'new-copy' }) };
    };
    beforeEach(async () => { fixture = await workspaceFixture(); });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });

    it.each(['prepared', 'committed'] as const)('Настоящий SIGKILL в состоянии %s не теряет событие и не переписывает неизвестные файлы', async phase => {
        const { target, prepared } = await prepareCopy(); const oldMarker = await fs.readFile(marker(target), 'utf8');
        const workspaceModule = path.resolve('src/bridge/workspace.ts'); const stateModule = path.resolve('src/bridge/state.ts');
        const source = `import fs from 'node:fs/promises';
            import {commitProjectBinding} from ${JSON.stringify(workspaceModule)};
            import {jobContext} from ${JSON.stringify(stateModule)};
            const rename=fs.rename.bind(fs); let pendingWrites=0;
            fs.rename=async(from,to)=>{await rename(from,to);
                if(to===${JSON.stringify(pending())}) pendingWrites++;
                if(${JSON.stringify(phase)}==='committed'&&to===${JSON.stringify(pending())}&&pendingWrites===2
                    ||${JSON.stringify(phase)}==='prepared'&&to===${JSON.stringify(marker(target))}) process.kill(process.pid,'SIGKILL');
            };
            await jobContext.run(${JSON.stringify(job)},()=>commitProjectBinding(${JSON.stringify(prepared)},async()=>{}));`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
        const [, signal] = await once(child, 'exit'); expect(signal, stderr).toBe('SIGKILL');
        const raw = await fs.readFile(pending(), 'utf8'); expect(JSON.parse(raw).state).toBe(phase);
        expect(await completions.pendingCompletions()).toEqual([]);
        const mutations = [vi.spyOn(fs, 'writeFile'), vi.spyOn(fs, 'rename'), vi.spyOn(fs, 'rm'), vi.spyOn(fs, 'mkdir')];
        await expect(projectFolder('test-project')).rejects.toThrow('Незавершённая привязка');
        await expect(prepareProjectBinding(prepared)).rejects.toThrow('Незавершённая привязка');
        expect(await fs.readFile(pending(), 'utf8')).toBe(raw);
        for (const mutation of mutations) { expect(mutation).not.toHaveBeenCalled(); mutation.mockRestore(); }
        const recovered = await recoverPendingWorkspaceIdentity();
        const stored = await completions.pendingCompletions(); expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ ...job, state: phase === 'committed' ? 'succeeded' : 'failed' });
        if (phase === 'committed') {
            expect(recovered).toMatchObject({ preparation: prepared.preparation });
            expect(await projectFolder('test-project')).toBe(target);
            expect(await projectInstanceId('test-project')).toBe(recovered!.instanceId);
            expect(stored[0]!.result).toEqual(recovered);
        } else {
            expect(recovered).toBeUndefined(); expect(stored[0]!.message).toBe('Привязка прервана и восстановлена.');
            expect(stored[0]!.result).toEqual({}); expect(await projectFolder('test-project')).toBe(fixture.root);
            expect(await fs.readFile(marker(target), 'utf8')).toBe(oldMarker);
        }
        expect(JSON.stringify(stored)).not.toContain(fixture.temporary);
        expect(await fs.readdir(stateDir())).not.toContain('workspace-identity-pending.json');
    });

    it('Ошибка durable completion оставляет committed journal; повтор возвращает прежний result без новой identity и scanner', async () => {
        const { target, prepared } = await prepareCopy(); const save = completions.saveCompletion;
        const failure = vi.spyOn(completions, 'saveCompletion').mockRejectedValue(new Error('Диск временно недоступен.'));
        await expect(jobContext.run(job, () => commitProjectBinding(prepared, async () => undefined))).rejects.toMatchObject({localChangesCommitted:true,cause:expect.objectContaining({message:'Диск временно недоступен.'})});
        const journal = JSON.parse(await fs.readFile(pending(), 'utf8')); expect(journal.state).toBe('committed');
        const published = await fs.readFile(marker(target), 'utf8'); failure.mockImplementation(save);
        const verifier = vi.fn(async () => undefined);
        const recovered = await jobContext.run(job, () => commitProjectBinding(prepared, verifier));
        expect(recovered).toEqual(journal.result); expect(verifier).not.toHaveBeenCalled();
        expect(await fs.readFile(marker(target), 'utf8')).toBe(published);
        expect((await completions.pendingCompletions())[0]!.result).toEqual(recovered);
    });

    it('Недостаток свободного места блокирует identity до marker и pending journal', async () => {
        const { target, prepared } = await prepareCopy(); const before = await fs.readFile(marker(target), 'utf8');
        const statfs = await fs.statfs(target, { bigint: true }); vi.spyOn(fs, 'statfs').mockResolvedValue({ ...statfs, bavail: 0n });
        await expect(commitProjectBinding(prepared, async () => undefined)).rejects.toThrow('Недостаточно свободного места');
        expect(await fs.readFile(marker(target), 'utf8')).toBe(before); expect(await projectFolder('test-project')).toBe(fixture.root);
        expect(await fs.readdir(stateDir())).not.toContain('workspace-identity-pending.json');
    });
    it('Prepared recovery не начинает undo без резерва на обоих дисках и повторяется после освобождения места', async () => {
        const { target, prepared } = await prepareCopy(); const before = await fs.readFile(marker(target), 'utf8');
        const originalStatfs = fs.statfs.bind(fs); const write = atomic.atomicText; let lowSpace = false;
        vi.spyOn(fs, 'statfs').mockImplementation(async (...args: Parameters<typeof fs.statfs>) => {
            const stat = await originalStatfs(...args); return lowSpace ? { ...stat, bavail: 0n } : stat;
        });
        vi.spyOn(atomic, 'atomicText').mockImplementation(async (file, text, mode, encoding) => {
            if (file === registryFile() && !lowSpace) { lowSpace = true; throw new Error('Запись registry прервана.'); }
            return write(file, text, mode, encoding);
        });
        await expect(jobContext.run(job, () => commitProjectBinding(prepared, async () => undefined))).rejects.toThrow('Недостаточно свободного места');
        const partial = await fs.readFile(marker(target), 'utf8'); const raw = await fs.readFile(pending(), 'utf8');
        expect(partial).not.toBe(before); expect(JSON.parse(raw).state).toBe('prepared');
        const privateBefore = await Promise.all([fs.readFile(registryFile(), 'utf8'), fs.readFile(path.join(stateDir(), 'workspace.json'), 'utf8')]);
        await expect(recoverPendingWorkspaceIdentity()).rejects.toThrow('Недостаточно свободного места');
        expect(await fs.readFile(marker(target), 'utf8')).toBe(partial); expect(await fs.readFile(pending(), 'utf8')).toBe(raw);
        expect(await Promise.all([fs.readFile(registryFile(), 'utf8'), fs.readFile(path.join(stateDir(), 'workspace.json'), 'utf8')])).toEqual(privateBefore);
        expect(await completions.pendingCompletions()).toEqual([]);
        lowSpace = false; vi.mocked(atomic.atomicText).mockImplementation(write);
        await recoverPendingWorkspaceIdentity(); expect(await fs.readFile(marker(target), 'utf8')).toBe(before);
        expect(await projectFolder('test-project')).toBe(fixture.root); expect((await completions.pendingCompletions())[0]!.state).toBe('failed');
    });
});
