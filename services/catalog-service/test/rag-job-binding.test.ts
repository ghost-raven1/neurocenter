import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { DeviceJobs } from '../src/devices/device-jobs';
import type { Device,DeviceStore } from '../src/devices/device-store';
import type { DeviceArtifacts } from '../src/devices/device-artifacts';
import type { DeviceInstallations } from '../src/devices/device-installations';
import type { InstallPlans } from '../src/devices/install-plans';

const {enqueue}=vi.hoisted(()=>({enqueue:vi.fn()}));
vi.mock('../src/devices/device-enqueue',()=>({enqueueDeviceJob:enqueue}));
const bindingId='b'.repeat(64);
const actor={email:'developer@example.test',activeRole:'Разработчик'};
const device:Device={id:'computer',email:actor.email,role:actor.activeRole,name:'Мост',fingerprint:'a'.repeat(64),last_seen:null,revoked:false,
    report:{protocolVersion:2,ragSupported:true,capabilities:['durable-completions','managed-installations','project-rag-sync-v1'],
        bindings:[{projectId:'project',folderName:'папка',bindingId,valid:true}]}};
const input={deviceId:device.id,projectId:'project',kind:'sync-rag',expectedBindingId:bindingId,requestKey:'11111111-1111-1111-1111-111111111111'};

describe('Задания знаний закреплены за выбранной локальной папкой',()=>{
    const query=vi.fn(),owned=vi.fn(),claims=vi.fn();
    const store={pool:{query,connect:async()=>({query,release:vi.fn()})},owned,access:{claims}} as unknown as DeviceStore;
    const service=new DeviceJobs(store,{} as DeviceArtifacts,{} as DeviceInstallations,{} as InstallPlans);
    const job={id:'job',device_id:device.id,email:actor.email,role:actor.activeRole,project_id:'project',kind:'sync-rag',state:'running',
        lease:'lease',lease_until:new Date(Date.now()+60000),payload:{bindingId}};
    beforeEach(()=>{
        vi.restoreAllMocks();query.mockReset();owned.mockReset();claims.mockReset();enqueue.mockReset();
        owned.mockResolvedValue(device);enqueue.mockResolvedValue({id:'created'});
        query.mockImplementation(async(sql:string)=>({rows:[],rowCount:sql==='SELECT 1 FROM projects WHERE id=$1'?1:0}));
        claims.mockResolvedValue({email:actor.email,userRoles:[actor.activeRole],projects:[{projectId:'project',projectName:'Проект',role:actor.activeRole}]});
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));
    });
    afterEach(()=>vi.unstubAllGlobals());
    it.each(['sync-rag','restore-rag'])('Создание %s сохраняет точный отпечаток папки',async kind=>{
        await expect(service.create(actor,{...input,kind})).resolves.toEqual({id:'created'});
        expect(enqueue).toHaveBeenCalledWith(store.pool,expect.any(String),expect.objectContaining({kind,payload:{bindingId}}),expect.any(Function));
    });
    it.each([undefined,'a'.repeat(64),'не хэш'])('Смена или отсутствие выбранной папки отклоняется: %s',async expectedBindingId=>{
        await expect(service.create(actor,{...input,expectedBindingId})).rejects.toHaveProperty('status');
        expect(enqueue).not.toHaveBeenCalled();
    });
    it('Старая версия без отдельного контракта RAG требует обновления',async()=>{
        owned.mockResolvedValue({...device,report:{...device.report,capabilities:['durable-completions','managed-installations']}});
        await expect(service.create(actor,input)).rejects.toThrow('Обновите мост');expect(enqueue).not.toHaveBeenCalled();
    });
    it('Наблюдателю не передаётся восстановление базы знаний',async()=>{
        claims.mockResolvedValue({email:actor.email,userRoles:['Наблюдатель'],projects:[{projectId:'project',role:'Наблюдатель'}]});
        await expect(service.create({...actor,activeRole:'Наблюдатель'},{...input,kind:'restore-rag'})).rejects.toHaveProperty('status',403);
        expect(enqueue).not.toHaveBeenCalled();
    });
    it.each(['sync-rag','restore-rag'])('Выдача %s отклоняет старую очередь после перепривязки',async kind=>{
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')&&sql.includes("state='queued'")?[{...job,kind,payload:{bindingId:'c'.repeat(64)}}]:[],rowCount:0}));
        expect(await service.claim(device)).toBeNull();
        expect(query.mock.calls.some(([sql])=>sql.startsWith("UPDATE bridge_jobs SET state='failed'"))).toBe(true);
    });
    it.each(['sync-rag','restore-rag'])('Повторная авторизация %s отклоняет новую папку',async kind=>{
        query.mockResolvedValue({rows:[{...job,kind,payload:{bindingId:'c'.repeat(64)}}],rowCount:1});
        await expect(service.authorize(device,job.id,job.lease)).rejects.toHaveProperty('status',409);
    });
    it('Старая очередь без привязки завершается отказом вместо бесконечного ожидания',async()=>{
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')&&sql.includes("state='queued'")?[{...job,payload:{}}]:[],rowCount:0}));
        expect(await service.claim(device)).toBeNull();
        expect(query.mock.calls.find(([sql])=>sql.startsWith("UPDATE bridge_jobs SET state='failed'"))?.[1]).toEqual([
            job.id,device.id,expect.any(String),expect.stringContaining('Индекс не подтверждён'),{code:'rag-contract-upgrade-required',needsResync:true},
        ]);
    });
    it('Текущая папка разрешена, пока назначения роли действуют',async()=>{
        query.mockResolvedValue({rows:[job],rowCount:1});
        await expect(service.authorize(device,job.id,job.lease)).resolves.toMatchObject({ok:true});
        claims.mockResolvedValue({...await claims(),userRoles:[]});
        await expect(service.authorize(device,job.id,job.lease)).rejects.toHaveProperty('status',403);
    });
    it('Повтор не подменяет отпечаток папки текущим значением',async()=>{
        query.mockResolvedValue({rows:[{...job,state:'failed'}]});
        const create=vi.spyOn(service,'create').mockResolvedValue({id:'new'});
        await service.retry(actor,job.id,input.requestKey);
        expect(create).toHaveBeenCalledWith(actor,expect.objectContaining({expectedBindingId:bindingId}));
    });
});
