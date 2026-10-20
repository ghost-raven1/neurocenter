import {buildPackage} from '../src/catalog/bundle-package';
import {describe, expect, it, vi} from 'vitest';
import {isProjectSkill,assertProjectCatalogAsset} from '../src/devices/project-skill';
import {DeviceJobs} from '../src/devices/device-jobs';
import type {Device, DeviceStore} from '../src/devices/device-store';
import type {DeviceArtifacts} from '../src/devices/device-artifacts';
import type {DeviceInstallations} from '../src/devices/device-installations';
import type {InstallPlans} from '../src/devices/install-plans';

describe('Скиллы собственного проекта', () => {
    it('Запись чужого скилла в каталоге не обходит область проекта при выдаче задания',async()=>{
        const query=vi.fn().mockResolvedValueOnce({rows:[{kind:'install',role:'Админ проекта',project_id:'prj-own',payload:{assetKind:'skill',assetId:'project-prj-other/private',bindingId:'a'.repeat(64)}}]})
            .mockResolvedValue({rows:[{}],rowCount:1});
        const service=new DeviceJobs({pool:{query}} as unknown as DeviceStore,{} as DeviceArtifacts,{} as DeviceInstallations);
        vi.spyOn(service as unknown as {permission:()=>Promise<unknown>},'permission').mockResolvedValue({});
        await expect(service.authorize({id:'computer',report:{capabilities:['install-set-v1'],bindings:[{projectId:'prj-own',bindingId:'a'.repeat(64)}]}} as unknown as Device,'job','lease')).rejects.toMatchObject({status:403});
        expect(query).toHaveBeenCalledTimes(1);
    });
    it('Общий каталог и собственные скиллы допустимы, подмена пути и чужая область запрещены',()=>{
        expect(()=>assertProjectCatalogAsset('skill','common/helper','prj-own')).not.toThrow();
        expect(()=>assertProjectCatalogAsset('skill','ops/helper','prj-own')).not.toThrow();
        expect(()=>assertProjectCatalogAsset('skill','project-prj-own/helper','prj-own')).not.toThrow();
        expect(()=>assertProjectCatalogAsset('skill','project-prj-other/helper','prj-own')).toThrow('другого проекта');
        expect(()=>assertProjectCatalogAsset('skill','common/../project-prj-other/helper','prj-own')).toThrow('путь');
        expect(()=>assertProjectCatalogAsset(['skill'],'common/helper','prj-own')).toThrow('Выберите');
        expect(()=>assertProjectCatalogAsset({toString:'skill'},'common/helper','prj-own')).toThrow('Выберите');
    });
    it.each([
        ['skill', 'project-prj-own/helper', 'prj-own', true],
        ['skill', 'project-prj-own/folder/helper', 'prj-own', true],
        ['skill', 'project-prj-other/helper', 'prj-own', false],
        ['mcp', 'project-prj-own/helper', 'prj-own', false],
        ['skill', 'project-prj-own/../common/helper', 'prj-own', false],
        ['skill', 'project-prj-own//helper', 'prj-own', false],
        ['skill', 'project-prj-own/', 'prj-own', false],
        ['skill', null, 'prj-own', false],
    ])('Проверяет область без подмены пути: %s %s', (kind, id, project, expected) => {
        expect(isProjectSkill(kind, id, project)).toBe(expected);
    });

    it.each([['project-prj-own/helper', true], ['common/helper', false], ['project-prj-other/helper', false]])('Повторная авторизация установки сохраняет проектную границу: %s', async (assetId, allowed) => {
        const pkg=buildPackage({kind:'skill',id:'project-prj-own/helper',name:'helper',version:1},[{path:'SKILL.md',content:'Fixture'}],'now');
        const query = vi.fn().mockResolvedValueOnce({rows: [{kind: 'install', role: 'Разработчик', project_id: 'prj-own', payload: {assetKind: 'skill', assetId, bindingId: 'a'.repeat(64),package:pkg}}]}).mockResolvedValue({rows: [], rowCount: 0});
        const service = new DeviceJobs({pool: {query}} as unknown as DeviceStore, {} as DeviceArtifacts, {} as DeviceInstallations, {package:vi.fn().mockResolvedValue(pkg)} as unknown as InstallPlans);
        const permission = vi.spyOn(service as unknown as {permission: () => Promise<unknown>}, 'permission').mockResolvedValue({});
        const result = service.authorize({id: 'computer',report:{capabilities:['install-set-v1'],bindings:[{projectId:'prj-own',bindingId:'a'.repeat(64)}]}} as unknown as Device, 'job', 'lease');
        if (allowed) { await expect(result).resolves.toMatchObject({ok: true}); }
        else { await expect(result).rejects.toMatchObject({status: 403}); }
        expect(permission).toHaveBeenCalled();
    });
});
