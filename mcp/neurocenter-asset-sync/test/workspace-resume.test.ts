import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindProject, commitProjectBinding, prepareProjectBinding, projectBindingId, projectFolder, projectInstanceId, recoverPendingWorkspaceIdentity, workspaceInstanceAt } from '../src/bridge/workspace.js';
import { install } from '../src/bridge/installer.js';
import { inspectInstallation } from '../src/bridge/installation-inspection.js';
import { assertInspectionIdentity } from '../src/bridge/inspection-identity.js';
import { verifyWorkspaceInstallations } from '../src/bridge/workspace-installations.js';
import { applyLocalChange, prepareLocalChange } from '../src/bridge/local-change-plan.js';
import { assetBase, receiptPath } from '../src/bridge/installation-receipt.js';
import { pendingCompletions } from '../src/bridge/completions.js';
import { readInstanceRegistry, registryFile } from '../src/bridge/workspace-identity-state.js';
import { stateDir } from '../src/bridge/state.js';
import { packageFixture, workspaceFixture } from './bridge-fixture.js';

describe('Явный возврат к ранее подключённой физической папке', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    const projectId = 'test-project';
    const marker = (root: string) => path.join(root, '.opencode/neurocenter.json');
    const sibling = (name: string) => path.join(path.dirname(fixture.root), name);
    const prepareResume = () => prepareProjectBinding({ projectId, folderName: path.basename(fixture.root), mode: 'resume' });
    beforeEach(async () => { fixture = await workspaceFixture(); });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });
    async function selectCopy() {
        const target = sibling('Папка B'); await fs.cp(fixture.root, target, { recursive: true });
        const prepared = await prepareProjectBinding({ projectId, folderName: path.basename(target), mode: 'new-copy' });
        await commitProjectBinding(prepared, context => verifyWorkspaceInstallations(context, []));
        return target;
    }

    it.each(['skill', 'mcp', 'plugin'])('A → B → A сохраняет instance A и версии %s обеих папок, меняя binding', async kind => {
        const a = packageFixture(kind, 1); await install(projectId, a, async () => undefined, async () => undefined);
        const instanceA = await projectInstanceId(projectId); const bindingA = await projectBindingId(projectId);
        const oldPlan = await prepareLocalChange(projectId, a, undefined, async () => undefined);
        const target = sibling('Папка B'); await fs.cp(fixture.root, target, { recursive: true });
        await commitProjectBinding(await prepareProjectBinding({ projectId, folderName: path.basename(target), mode: 'new-copy' }), context => verifyWorkspaceInstallations(context, [a]));
        const instanceB = await projectInstanceId(projectId); const bindingB = await projectBindingId(projectId);
        const b = packageFixture(kind, 2); await install(projectId, b, async () => undefined, async () => undefined);
        const registeredB = (await readInstanceRegistry()).instances[instanceB];
        await expect(bindProject(projectId, path.basename(fixture.root))).rejects.toThrow('явного возврата');
        const prepared = await prepareResume();
        expect(prepared).toMatchObject({ mode: 'resume', requiresFileVerification: true, instanceId: instanceA, previousBindingId: bindingA, sourceFolderName: path.basename(fixture.root) });
        const verifier = vi.fn(context => verifyWorkspaceInstallations(context, [a]));
        const result = await commitProjectBinding(prepared, verifier);
        expect(verifier).toHaveBeenCalledWith(expect.objectContaining({ mode: 'resume', sourceRoot: fixture.root, targetRoot: fixture.root, previousConfigRoot: fixture.root, previousBindingId: bindingA, instanceId: instanceA }));
        expect(result).toMatchObject({ instanceId: instanceA, previousBindingId: bindingA, mode: 'resume' });
        expect(result.bindingId).not.toBe(bindingA); expect(result.bindingId).not.toBe(bindingB); expect(await projectFolder(projectId)).toBe(fixture.root);
        expect((await readInstanceRegistry()).instances[instanceB]).toEqual(registeredB); expect((await workspaceInstanceAt(target, projectId)).instanceId).toBe(instanceB);
        expect(await fs.readFile(path.join(fixture.root, assetBase(a), a.files[0]!.path), 'utf8')).toBe(a.files[0]!.content);
        expect(await fs.readFile(path.join(target, assetBase(b), b.files[0]!.path), 'utf8')).toBe(b.files[0]!.content);
        const inspected = await inspectInstallation(projectId, a); expect(inspected.status).toBe('synced'); expect(inspected.bindingId).toBe(result.bindingId);
        expect(() => assertInspectionIdentity(inspected, projectId, bindingA, a)).toThrow('исходному заданию');
        await expect(applyLocalChange(projectId, a, { planId: oldPlan.planId, revision: 1, digest: oldPlan.digest, expectedBindingId: bindingA }, async () => undefined, async () => undefined)).rejects.toThrow('Привязка или экземпляр');
        if (kind !== 'skill') {
            const receiptA = JSON.parse(await fs.readFile(path.join(fixture.root, receiptPath(a)), 'utf8'));
            const receiptB = JSON.parse(await fs.readFile(path.join(target, receiptPath(b)), 'utf8'));
            const configA = parse(await fs.readFile(path.join(fixture.root, receiptA.config.path), 'utf8'));
            const configB = parse(await fs.readFile(path.join(target, receiptB.config.path), 'utf8'));
            expect(kind === 'mcp' ? configA.mcp[receiptA.config.key] : configA.plugin[0]).toEqual(receiptA.config.value);
            expect(kind === 'mcp' ? configB.mcp[receiptB.config.key] : configB.plugin[0]).toEqual(receiptB.config.value);
            expect(JSON.stringify(receiptA.config.value)).not.toContain(target);
        }
    });
    it('Неизвестный marker v2 не принимается без приватной регистрации', async () => {
        const target = sibling('Неизвестная папка'); await fs.mkdir(path.join(target, '.opencode'), { recursive: true });
        const original = JSON.parse(await fs.readFile(marker(fixture.root), 'utf8'));
        await fs.writeFile(marker(target), JSON.stringify({ ...original, instanceId: randomUUID() }));
        await expect(prepareProjectBinding({ projectId, folderName: path.basename(target), mode: 'resume' })).rejects.toThrow('ранее зарегистрированному');
        expect(await projectFolder(projectId)).toBe(fixture.root);
    });
    it('Копия зарегистрированного marker не наследует право resume', async () => {
        const target = sibling('Клон'); await fs.cp(fixture.root, target, { recursive: true });
        const before = await fs.readFile(marker(target), 'utf8');
        await expect(prepareProjectBinding({ projectId, folderName: path.basename(target), mode: 'resume' })).rejects.toThrow('Физическая папка');
        expect(await fs.readFile(marker(target), 'utf8')).toBe(before); expect(await projectFolder(projectId)).toBe(fixture.root);
    });
    it('Resume не обходит проверку физического каталога при клоне по прежнему пути', async () => {
        const original = sibling('Сохранённый оригинал'); await fs.rename(fixture.root, original); await fs.cp(original, fixture.root, { recursive: true });
        await expect(prepareResume()).rejects.toThrow('Физическая папка');
    });
    it('Legacy marker не может пройти через resume без отдельной миграции', async () => {
        const value = JSON.parse(await fs.readFile(marker(fixture.root), 'utf8')); await fs.writeFile(marker(fixture.root), JSON.stringify({ version: 1, server: value.server, projectId }));
        await expect(prepareResume()).rejects.toThrow('ранее зарегистрированному');
    });
    it('Обязательный frozen callback нельзя заменить одним прежним marker', async () => {
        const target = await selectCopy(); const prepared = await prepareResume(); const raw = await fs.readFile(registryFile(), 'utf8');
        await expect(commitProjectBinding(prepared)).rejects.toThrow('проверки закреплённых файлов');
        expect(await projectFolder(projectId)).toBe(target); expect(await fs.readFile(registryFile(), 'utf8')).toBe(raw);
    });
    it('Подмена папки после resume preview отменяет commit до frozen callback', async () => {
        const target = await selectCopy(); const prepared = await prepareResume(); const verifier = vi.fn(async () => undefined);
        const original = sibling('Оригинал A'); await fs.rename(fixture.root, original); await fs.cp(original, fixture.root, { recursive: true });
        await expect(commitProjectBinding(prepared, verifier)).rejects.toThrow('Физическая папка'); expect(verifier).not.toHaveBeenCalled(); expect(await projectFolder(projectId)).toBe(target);
    });
    it.each(['prepared', 'committed'] as const)('Настоящий SIGKILL resume в %s восстанавливает тот же instance и правильное событие', async phase => {
        const instanceA = await projectInstanceId(projectId); const bindingA = await projectBindingId(projectId); const target = await selectCopy();
        const prepared = await prepareResume(); const pending = path.join(stateDir(), 'workspace-identity-pending.json');
        const workspaceModule = path.resolve('src/bridge/workspace.ts'); const stateModule = path.resolve('src/bridge/state.ts');
        const job = { id: '11111111-1111-1111-1111-111111111111', lease: '22222222-2222-2222-2222-222222222222', deviceId: '33333333-3333-3333-3333-333333333333' };
        const source = `import fs from 'node:fs/promises';import {commitProjectBinding} from ${JSON.stringify(workspaceModule)};import {jobContext} from ${JSON.stringify(stateModule)};const rename=fs.rename.bind(fs);let count=0;fs.rename=async(from,to)=>{await rename(from,to);if(to===${JSON.stringify(pending)})count++;if(${JSON.stringify(phase)}==='prepared'&&to===${JSON.stringify(registryFile())}||${JSON.stringify(phase)}==='committed'&&to===${JSON.stringify(pending)}&&count===2)process.kill(process.pid,'SIGKILL');};await jobContext.run(${JSON.stringify(job)},()=>commitProjectBinding(${JSON.stringify(prepared)},async()=>{}));`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
        let error = ''; child.stderr.on('data', data => { error += String(data); }); const [, signal] = await once(child, 'exit'); expect(signal, error).toBe('SIGKILL');
        expect(JSON.parse(await fs.readFile(pending, 'utf8'))).toMatchObject({ state: phase, result: { mode: 'resume', instanceId: instanceA } });
        const recovered = await recoverPendingWorkspaceIdentity(); const completion = (await pendingCompletions())[0]!;
        expect(completion).toMatchObject({ ...job, state: phase === 'committed' ? 'succeeded' : 'failed' });
        if (phase === 'committed') {
            expect(recovered).toMatchObject({ mode: 'resume', instanceId: instanceA, previousBindingId: bindingA }); expect(await projectFolder(projectId)).toBe(fixture.root);
            expect(await projectBindingId(projectId)).not.toBe(bindingA); expect(await projectInstanceId(projectId)).toBe(instanceA);
        } else {
            expect(await projectFolder(projectId)).toBe(target); expect((await workspaceInstanceAt(fixture.root, projectId)).instanceId).toBe(instanceA);
            expect((await readInstanceRegistry()).instances[instanceA]!.bindingNonce).toBeDefined(); expect((await prepareResume()).previousBindingId).toBe(bindingA);
        }
        await expect(fs.stat(pending)).rejects.toMatchObject({ code: 'ENOENT' });
    }, 15000);
});
