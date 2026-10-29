import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {DeviceJobs} from '../src/devices/device-jobs';
import type {Device,DeviceStore} from '../src/devices/device-store';
import type {DeviceArtifacts} from '../src/devices/device-artifacts';
import type {DeviceInstallations} from '../src/devices/device-installations';
import type {InstallPlans} from '../src/devices/install-plans';

describe('Согласованность прогресса MCP',()=>{
    const query=vi.fn();const service=new DeviceJobs({pool:{query,connect:async()=>({query,release:vi.fn()})}} as unknown as DeviceStore,{} as DeviceArtifacts,{} as DeviceInstallations,{} as InstallPlans);
    beforeEach(()=>{query.mockReset();vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));});
    afterEach(()=>vi.unstubAllGlobals());
    it('Статус без percent использует сохранённый прогресс очереди',async()=>{
        query.mockImplementation(async(sql:string)=>sql.startsWith('SELECT')?{rows:[{kind:'install'}]}:sql.startsWith('UPDATE')?
            {rowCount:1,rows:[{id:'job',kind:'install',project_id:'project',email:'test@example.test',percent:73}]}:{rows:[]});
        await service.update({id:'computer'} as Device,'job',{lease:'lease',message:'Продолжаем работу'});
        expect(query.mock.calls.find(([sql])=>sql.includes('INSERT INTO operations'))?.[1][6]).toBe(73);
    });
    it.each(['succeeded','failed'])('Конечный статус %s через прогресс отвергается до SQL, даже с квитанцией',async state=>{
        for(const result of [undefined,{}, {projectId:'project',assetId:'asset',version:1,manifest:'a'.repeat(64),bindingId:'binding',unchanged:true}]) {
            await expect(service.update({id:'computer'} as Device,'job',{lease:'lease',state,message:'Готово',result}))
                .rejects.toMatchObject({status:400,message:expect.stringContaining('подтверждение результата')});
        }
        expect(query).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
    it('Промежуточный прогресс не требует квитанцию ещё не завершённой установки',async()=>{
        query.mockImplementation(async(sql:string)=>sql.startsWith('SELECT')?{rows:[{kind:'install'}]}:sql.startsWith('UPDATE')?
            {rowCount:1,rows:[{id:'job',kind:'install',project_id:'project',email:'test@example.test',percent:35}]}:{rows:[]});
        await expect(service.update({id:'computer'} as Device,'job',{lease:'lease',state:'running',message:'Проверяем',percent:35})).resolves.toEqual({ok:true});
        expect(query.mock.calls.find(([sql])=>sql.startsWith('UPDATE'))?.[1][3]).toBe('running');
    });
    it.each(['connect-rag-model','bind-project','open-rag-ui','inspect-opencode-cli'])('Проверенное действие %s сохраняет статус моста вместо сообщения worker',async kind=>{
        const row={id:'job',kind,project_id:'project',email:'test@example.test',percent:20};
        query.mockImplementation(async(sql:string)=>sql.startsWith('SELECT')?{rows:[row]}:sql.startsWith('UPDATE')?{rowCount:1,rows:[row]}:{rows:[]});
        await service.update({id:'computer'} as Device,'job',{lease:'lease',percent:20,message:'MCP выполняет задание /private/API_KEY=секрет'});
        expect(query.mock.calls.find(([sql])=>sql.startsWith('UPDATE'))?.[1][5]).toBe('Мост выполняет проверенное действие.');
        const operation=query.mock.calls.find(([sql])=>sql.includes('INSERT INTO operations'))!;
        expect(JSON.parse(operation[1][8])[0].message).toBe('Мост выполняет проверенное действие.');
        expect(query.mock.calls.some(([,parameters])=>JSON.stringify(parameters??null).includes('API_KEY'))).toBe(false);
    });
    it('Проверка CLI не передаёт промежуточный stdout или результат через progress',async()=>{
        query.mockResolvedValue({rows:[{kind:'inspect-opencode-cli'}]});
        await expect(service.update({id:'computer'} as Device,'job',{lease:'lease',message:'private',result:{stdout:'private'}})).rejects.toMatchObject({status:400});
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE')||sql.includes('INSERT INTO operations'))).toBe(false);
    });
    const bindingId='b'.repeat(64);
    const inspection={schemaVersion:1,projectId:'project',bindingId,assetId:'ai-plug-helper',assetKind:'mcp',version:1,manifest:'a'.repeat(64),
        checkedAt:'2026-10-17T00:00:00.000Z',readiness:'unverified',state:'checked',status:'unknown',issues:['inspection-failed']};
    const inspectionJob={id:'job',kind:'inspect-installation',project_id:'project',email:'test@example.test',state:'running',percent:0,lease_until:new Date(Date.now()+60000),
        payload:{bindingId,package:{plugin:{id:inspection.assetId,kind:'mcp',version:1},manifest:{sha256:inspection.manifest}}}};
    it('Неуспешная сверка через progress отвергается до чтения и не сохраняет конфиденциальное сообщение',async()=>{
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[inspectionJob]:[]}));
        await expect(service.update({id:'computer'} as Device,'job',{lease:'lease',state:'failed',message:'/Users/private/API_KEY=секрет',
            result:{config:{API_KEY:'секрет'},readiness:'ready'}})).rejects.toMatchObject({status:400});
        expect(query).not.toHaveBeenCalled();
    });
    it('Промежуточная сверка не принимает произвольный result с настройками',async()=>{
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[inspectionJob]:[]}));
        await expect(service.update({id:'computer'} as Device,'job',{lease:'lease',state:'running',message:'Проверяем',
            result:{config:{API_KEY:'секрет'}}})).rejects.toMatchObject({status:400});
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE')||sql.includes('INSERT INTO operations'))).toBe(false);
    });
    it.each([undefined,'running'])('Обычный прогресс сверки со state=%s сохраняет фиксированное сообщение без секрета',async state=>{
        query.mockImplementation(async(sql:string)=>sql.startsWith('SELECT')?{rows:[inspectionJob]}:sql.startsWith('UPDATE')?
            {rowCount:1,rows:[inspectionJob]}:{rows:[]});
        await expect(service.update({id:'computer'} as Device,'job',{lease:'lease',state,message:'/private/API_KEY=секрет',result:null})).resolves.toEqual({ok:true});
        const saved=query.mock.calls.find(([sql])=>sql.startsWith('UPDATE'))?.[1];
        expect(saved?.[5]).toBe('Проверка файлов выполняется.');expect(saved?.[6]).toBeNull();
        expect(query.mock.calls.some(([,parameters])=>JSON.stringify(parameters ?? null).includes('API_KEY'))).toBe(false);
    });
    it('Серверный отказ до выдачи сверки не требует локальную квитанцию и не раскрывает причину из исключения',async()=>{
        query.mockImplementation(async(sql:string)=>{
            if(sql.startsWith('SELECT id,paused_until')){return {rows:[{id:'computer',paused:false}]};}
            if(sql.startsWith("SELECT * FROM bridge_jobs WHERE device_id")){return {rows:[{...inspectionJob,device_id:'computer',role:'Наблюдатель',state:'queued'}]};}
            if(sql.startsWith("UPDATE bridge_jobs SET state='failed'")){return {rowCount:1,rows:[{...inspectionJob,device_id:'computer'}]};}
            return {rows:[],rowCount:0};
        });
        const permission=vi.spyOn(service as unknown as {permission:()=>Promise<unknown>},'permission').mockRejectedValueOnce(new Error('/private/API_KEY=секрет'));
        try{
            await expect(service.claim({id:'computer',report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','package-v4','installation-inspection-v1']}} as unknown as Device)).resolves.toBeNull();
            const refused=query.mock.calls.find(([sql])=>sql.startsWith("UPDATE bridge_jobs SET state='failed'"));
            expect(refused?.[1][3]).toBe('Проверка файлов недоступна: доступ или версия MCP изменились.');
            expect(query.mock.calls.some(([,parameters])=>JSON.stringify(parameters ?? null).includes('API_KEY'))).toBe(false);
        }finally{permission.mockRestore();}
    });
});
