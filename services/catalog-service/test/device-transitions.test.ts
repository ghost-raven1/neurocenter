import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {DeviceJobs} from '../src/devices/device-jobs';
import type {Device,DeviceStore} from '../src/devices/device-store';
import type {DeviceArtifacts} from '../src/devices/device-artifacts';
import type {DeviceInstallations} from '../src/devices/device-installations';
import type {InstallPlans} from '../src/devices/install-plans';

describe('Атомарность очереди и журнала операций MCP',()=>{
    const query=vi.fn(), direct=vi.fn(), release=vi.fn();
    const store={pool:{query:direct,connect:async()=>({query,release})},access:{claims:async()=>({email:'owner@example.test',userRoles:['Разработчик'],projects:[{projectId:'project',projectName:'Проект',role:'Разработчик'}]})}} as unknown as DeviceStore;
    const jobs=new DeviceJobs(store,{} as DeviceArtifacts,{} as DeviceInstallations,{} as InstallPlans);
    const row={id:'job',device_id:'computer',project_id:'project',email:'owner@example.test',kind:'sync-rag',percent:37};
    beforeEach(()=>{
        vi.clearAllMocks();
        direct.mockResolvedValue({rows:[{kind:'sync-rag'}]});
        query.mockImplementation(async(sql:string)=>{
            if(sql.includes('INSERT INTO operations'))throw new Error('Журнал временно недоступен');
            return {rows:sql.startsWith('UPDATE')?[row]:[],rowCount:sql.startsWith('UPDATE')?1:0};
        });
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));
    });
    afterEach(()=>vi.unstubAllGlobals());
    it('Отказ журнала отменяет и отмену ожидающего задания',async()=>{
        await expect(jobs.cancel({email:row.email,activeRole:'Разработчик'},row.id)).rejects.toThrow('Журнал временно недоступен');
        expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
        expect(query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
        expect(direct).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
    });
    it('Истечение очереди не сохраняет cancelled, если проекция операции не записана',async()=>{
        query.mockImplementation(async(sql:string)=>{
            if(sql.includes('INSERT INTO operations'))throw new Error('Журнал временно недоступен');
            return {rows:sql.includes("state='cancelled'")?[row]:[],rowCount:sql.includes("state='cancelled'")?1:0};
        });
        await expect(jobs.list({email:row.email,activeRole:'Разработчик'})).rejects.toThrow('Журнал временно недоступен');
        expect(query.mock.calls.map(([sql])=>sql).slice(-7)).toEqual(['BEGIN',expect.stringContaining("state='reconciling'"),'COMMIT',
            'BEGIN',expect.stringContaining("state='cancelled'"),expect.stringContaining('INSERT INTO operations'),'ROLLBACK']);
        expect(direct).not.toHaveBeenCalled();
        expect(query.mock.calls.find(([sql])=>sql.startsWith("UPDATE bridge_jobs SET state='cancelled'"))?.[0]).toContain('Задание ожидало моста больше суток');
        const operation=query.mock.calls.find(([sql])=>sql.includes('INSERT INTO operations'))!;
        expect(JSON.parse(operation[1][8])[0].message).toBe('Срок ожидания моста истёк.');
    });
    it('Отказ промежуточного журнала откатывает прогресс обычного задания',async()=>{
        await expect(jobs.update({id:row.device_id} as Device,row.id,{lease:'lease',state:'running',message:'Продолжаем работу'})).rejects.toThrow('Журнал временно недоступен');
        expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
        expect(query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('Успешная отмена фиксирует job и operation до инвалидации интерфейса',async()=>{
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('UPDATE')?[row]:[],rowCount:sql.startsWith('UPDATE')?1:0}));
        const fetch=vi.fn(async()=>{expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');return {ok:true};});vi.stubGlobal('fetch',fetch);
        await expect(jobs.cancel({email:row.email,activeRole:'Разработчик'},row.id)).resolves.toEqual({ok:true});
        expect(query.mock.calls.find(([sql])=>sql.startsWith('UPDATE'))?.[1]).toEqual([row.id,row.email,false,['project']]);
        expect(query.mock.calls.find(([sql])=>sql.includes('INSERT INTO operations'))?.[1].slice(5,7)).toEqual(['CANCELLED',0]);
        expect(fetch).toHaveBeenCalledOnce();
    });
    it('Отказ RUNNING проекции откатывает аренду до доставки задания worker',async()=>{
        direct.mockImplementation(async(sql:string)=>{
            if(sql.includes('INSERT INTO operations'))throw new Error('Журнал временно недоступен');
            return {rows:[]};
        });
        query.mockImplementation(async(sql:string)=>{
            if(sql.startsWith('SELECT id,paused_until'))return {rows:[{id:row.device_id,paused:false}]};
            if(sql.startsWith('SELECT * FROM bridge_jobs WHERE device_id'))return {rows:[{...row,state:'queued',role:'Разработчик',payload:{}}]};
            if(sql.includes('INSERT INTO operations'))throw new Error('Журнал временно недоступен');
            return {rows:[],rowCount:0};
        });
        const permission=vi.spyOn(jobs as unknown as {permission:()=>Promise<unknown>},'permission').mockResolvedValue(undefined);
        try {
            await expect(jobs.claim({id:row.device_id,report:{protocolVersion:2,capabilities:['durable-completions','managed-installations']}} as unknown as Device))
                .rejects.toThrow('Журнал временно недоступен');
            expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
            const leaseUpdate=query.mock.calls.findIndex(([sql])=>sql.includes("SET state='running',lease="));
            const projection=query.mock.calls.findIndex(([sql])=>sql.includes('INSERT INTO operations'));
            expect(leaseUpdate).toBeGreaterThan(-1);expect(projection).toBeGreaterThan(leaseUpdate);
            expect(query.mock.calls.slice(leaseUpdate,projection).some(([sql])=>sql==='COMMIT')).toBe(false);
            expect(permission).not.toHaveBeenCalled();
        } finally {permission.mockRestore();}
    });
});
