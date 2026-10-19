import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceJobs } from '../src/devices/device-jobs';
import type { Device, DeviceStore } from '../src/devices/device-store';
import type { DeviceArtifacts } from '../src/devices/device-artifacts';
import type { DeviceInstallations } from '../src/devices/device-installations';
import type { InstallPlans } from '../src/devices/install-plans';
import { buildPackage } from '../src/catalog/bundle-package';

const {enqueue} = vi.hoisted(()=>({enqueue:vi.fn()}));
vi.mock('../src/devices/device-enqueue',()=>({enqueueDeviceJob:enqueue}));
const bindingId = 'b'.repeat(64);
const actor = {email:'observer@example.test',activeRole:'Наблюдатель'};
const pkg = buildPackage({id:'ai-plug-helper',name:'Помощник',kind:'mcp',version:1},[],'now',{transport:'remote',url:'https://example.test/mcp'});
const device: Device = {id:'device',email:actor.email,role:actor.activeRole,name:'Проверка',fingerprint:'a'.repeat(64),last_seen:null,revoked:false,
    report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','package-v4','install-set-v1','installation-inspection-v1'],
        bindings:[{projectId:'project',folderName:'папка',bindingId,valid:true}]}};
const input = {deviceId:device.id,projectId:'project',kind:'inspect-installation',assetId:pkg.plugin.id,assetKind:pkg.plugin.kind,
    expectedManifest:pkg.manifest.sha256,expectedBindingId:bindingId,requestKey:'11111111-1111-1111-1111-111111111111'};

describe('Права и привязка заданий проверки файлов', () => {
    const query=vi.fn(),owned=vi.fn(),inspectionPackage=vi.fn(),claims=vi.fn();
    const store={pool:{query},owned,access:{claims}} as unknown as DeviceStore;
    const service=new DeviceJobs(store,{} as DeviceArtifacts,{inspectionPackage} as unknown as DeviceInstallations,{} as InstallPlans);
    beforeEach(()=>{
        vi.restoreAllMocks();query.mockReset();owned.mockReset();inspectionPackage.mockReset();claims.mockReset();enqueue.mockReset();
        owned.mockResolvedValue(device);inspectionPackage.mockResolvedValue(pkg);enqueue.mockResolvedValue({id:'created'});
        query.mockImplementation(async(sql:string)=>({rows:[],rowCount:sql==='SELECT 1 FROM projects WHERE id=$1'?1:0}));
        claims.mockResolvedValue({email:actor.email,userRoles:['Наблюдатель'],projects:[{projectId:'project',projectName:'Проект',role:'Наблюдатель'}]});
    });
    it('Наблюдатель проверяет свою установку по зафиксированному пакету',async()=>{
        await expect(service.create(actor,input)).resolves.toEqual({id:'created'});
        expect(inspectionPackage).toHaveBeenCalledWith(actor,expect.objectContaining({bindingId,expectedManifest:pkg.manifest.sha256}));
        expect(enqueue).toHaveBeenCalledWith(store.pool,expect.stringContaining('"bindingId"'),expect.objectContaining({kind:'inspect-installation',payload:expect.objectContaining({bindingId,package:pkg})}),expect.any(Function));
    });
    it.each(['install','uninstall'])('Наблюдатель не получает право %s вместе с проверкой',async kind=>{
        await expect(service.create(actor,{...input,kind})).rejects.toMatchObject({status:403});expect(enqueue).not.toHaveBeenCalled();
    });
    it('Наблюдатель чужого проекта и отозванная роль не проверяют файлы',async()=>{
        claims.mockResolvedValueOnce({userRoles:['Наблюдатель'],projects:[]});
        await expect(service.create(actor,input)).rejects.toMatchObject({status:403});
        claims.mockResolvedValueOnce({userRoles:[],projects:[]});
        await expect(service.create(actor,input)).rejects.toMatchObject({status:403});expect(enqueue).not.toHaveBeenCalled();
    });
    it.each([undefined,'a'.repeat(64),'не хэш'])('Старая или отсутствующая выбранная привязка не направляет запрос в другую папку: %s',async expectedBindingId=>{
        await expect(service.create(actor,{...input,expectedBindingId})).rejects.toHaveProperty('status');
        expect(inspectionPackage).not.toHaveBeenCalled();expect(enqueue).not.toHaveBeenCalled();
    });
    it('Клиент без capability не получает задание проверки',async()=>{
        owned.mockResolvedValue({...device,report:{...device.report,capabilities:['durable-completions','managed-installations','package-v4']}});
        await expect(service.create(actor,input)).rejects.toMatchObject({status:409});expect(enqueue).not.toHaveBeenCalled();
    });
    it('Повтор сохраняет исходную папку, не переключаясь на текущую',async()=>{
        query.mockResolvedValue({rows:[{id:'old',device_id:device.id,project_id:'project',kind:'inspect-installation',state:'failed',
            payload:{bindingId,assetId:pkg.plugin.id,assetKind:'mcp',version:1,package:pkg}}]});
        const create=vi.spyOn(service,'create').mockResolvedValue({id:'new'});
        await service.retry(actor,'old',input.requestKey);
        expect(create).toHaveBeenCalledWith(actor,expect.objectContaining({expectedBindingId:bindingId,expectedManifest:pkg.manifest.sha256}));
    });
});
