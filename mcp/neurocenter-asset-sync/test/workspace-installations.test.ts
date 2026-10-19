import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceFixture, packageFixture } from './bridge-fixture.js';
import { install } from '../src/bridge/installer.js';
import { prepareProjectBinding, commitProjectBinding, projectBindingId, projectInstanceId } from '../src/bridge/workspace.js';
import { verifyWorkspaceInstallations } from '../src/bridge/workspace-installations.js';
import { assetBase } from '../src/bridge/installation-receipt.js';
import { inspectInstallation } from '../src/bridge/installation-inspection.js';

describe('Мастер сверяет замороженные установки перед принятием папки', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    beforeEach(async () => { fixture=await workspaceFixture(); });
    afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(fixture.temporary,{recursive:true,force:true}); });
    const clone = async (kind='skill') => {
        const pkg = packageFixture(kind);
        await install('test-project',pkg,async()=>undefined,async()=>undefined);
        const target = path.join(path.dirname(fixture.root),'копия');
        await fs.cp(fixture.root,target,{recursive:true});
        const prepared = await prepareProjectBinding({projectId:'test-project',folderName:'копия',mode:'new-copy',
            expectedBindingId:await projectBindingId('test-project'),expectedInstanceId:await projectInstanceId('test-project')});
        return {pkg,target,prepared};
    };
    it.each(['skill','mcp','plugin'])('Принимает копию %s только с совпадающими файлами, квитанцией и исходным подключением', async kind => {
        const {pkg,prepared}=await clone(kind);
        const result=await commitProjectBinding(prepared,context=>verifyWorkspaceInstallations(context,[pkg]));
        expect(result.instanceId).not.toBe(prepared.instanceId);
        expect(result.bindingId).not.toBe(prepared.previousBindingId);
        expect((await inspectInstallation('test-project',pkg)).status).toBe('synced');
    });
    it('Ручная правка копии не меняет текущий экземпляр', async () => {
        const {pkg,target,prepared}=await clone();
        await fs.writeFile(path.join(target,assetBase(pkg),'SKILL.md'),'Локальная правка');
        await expect(commitProjectBinding(prepared,context=>verifyWorkspaceInstallations(context,[pkg]))).rejects.toThrow('отличаются');
        expect(await projectBindingId('test-project')).toBe(prepared.previousBindingId);
        expect(await fs.readFile(path.join(target,assetBase(pkg),'SKILL.md'),'utf8')).toBe('Локальная правка');
        await expect(fs.access(path.join(target,'.opencode/neurocenter/files.lock'))).rejects.toThrow();
    });
    it('Неизвестная квитанция не усыновляется из одного marker', async () => {
        const {pkg,target,prepared}=await clone();
        await fs.writeFile(path.join(target,'.opencode/neurocenter/receipts','f'.repeat(24)+'.json'),'{}');
        await expect(commitProjectBinding(prepared,context=>verifyWorkspaceInstallations(context,[pkg]))).rejects.toThrow('неизвестные квитанции');
    });
    it('Пустая история сервера не принимает существующие инструменты', async () => {
        const {prepared}=await clone();
        await expect(commitProjectBinding(prepared,context=>verifyWorkspaceInstallations(context,[]))).rejects.toThrow('квитанции');
    });
});
