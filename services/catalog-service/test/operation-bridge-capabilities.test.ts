import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {OperationRepository} from '../src/operations/operation-repository';
import {DeviceJobs} from '../src/devices/device-jobs';
import type {DeviceStore} from '../src/devices/device-store';
import type {DeviceArtifacts} from '../src/devices/device-artifacts';
import type {DeviceInstallations} from '../src/devices/device-installations';
import type {InstallPlans} from '../src/devices/install-plans';

const jobId='11111111-1111-4111-8111-111111111111',actor='owner@example.test',projectId='prj-own';
const row={operation_id:'bridge-'+jobId,type:'VERIFY',resource_type:'bridge',resource_id:jobId,project_id:projectId,
    actor,state:'FAILED',percent:0,bytes_done:0,bytes_total:0,started_at:null,finished_at:null,error:'Сбой',log:[],retries:0};

describe('Возможность повтора берётся из исходного задания моста',()=>{
    const query=vi.fn(),repository=new OperationRepository({query} as unknown as Pool);
    let jobs:Array<{id:string;email:string;project_id:string|null;kind:string;project_exists?:boolean}>;
    beforeEach(()=>{
        vi.resetAllMocks();jobs=[{id:jobId,email:actor,project_id:projectId,kind:'inspect-installation',project_exists:true}];
        query.mockImplementation(async(sql:string)=>({rows:sql.includes('FROM bridge_jobs')?jobs:
            sql.includes('count(*)')?[{n:1,active:0,active_percent:0,running:0,queued:0}]:[row]}));
    });

    it('Detail передаёт вид и право повторить чтение с уровнем наблюдателя',async()=>{
        expect(await repository.get(row.operation_id)).toMatchObject({bridgeJob:{kind:'inspect-installation',retrySupported:true,minimumLevel:1}});
    });

    it('Список разрешает повтор установки и запрещает действия с новым подтверждением',async()=>{
        for(const kind of ['install','bind-project','probe-runtime','open-rag-ui','apply-local-change','prepare-mcp-configuration','future-kind']) {
            jobs[0].kind=kind;
            expect((await repository.list(1,10)).items[0]).toMatchObject({bridgeJob:{kind,retrySupported:kind==='install',minimumLevel:2}});
        }
    });

    it.each([{email:'other@example.test'},{project_id:'prj-foreign'}])('Чужое задание не добавляет возможность повтора: %j',async change=>{
        jobs[0]={...jobs[0],...change};expect(await repository.get(row.operation_id)).not.toHaveProperty('bridgeJob');
    });

    it('Отсутствующее исходное задание не превращается в разрешённый повтор',async()=>{
        jobs=[];expect(await repository.get(row.operation_id)).not.toHaveProperty('bridgeJob');
    });

    it.each([false,undefined])('История удалённого проекта остаётся доступной без ложного повтора: %s',async exists=>{
        jobs[0].project_exists=exists;
        expect(await repository.get(row.operation_id)).toMatchObject({operationId:row.operation_id,projectId,
            bridgeJob:{kind:'inspect-installation',retrySupported:false,minimumLevel:1}});
        const page=await repository.list(1,10);
        expect(page.total).toBe(1);
        expect(page.items[0]).toMatchObject({operationId:row.operation_id,projectId,
            bridgeJob:{kind:'inspect-installation',retrySupported:false,minimumLevel:1}});
    });

    it('Личное задание без проекта сохраняет возможность повторного выбора корневой папки',async()=>{
        jobs[0]={...jobs[0],project_id:null,kind:'choose-root',project_exists:false};
        query.mockImplementation(async(sql:string)=>({rows:sql.includes('FROM bridge_jobs')?jobs:[{...row,project_id:null}]}));
        expect(await repository.get(row.operation_id)).toMatchObject({bridgeJob:{kind:'choose-root',retrySupported:true,minimumLevel:2}});
    });

    it('Проектное задание без проекта не разрешает повтор как выбор корневой папки',async()=>{
        jobs[0]={...jobs[0],project_id:null,kind:'sync-rag',project_exists:false};
        query.mockImplementation(async(sql:string)=>({rows:sql.includes('FROM bridge_jobs')?jobs:[{...row,project_id:null}]}));
        expect(await repository.get(row.operation_id)).toMatchObject({bridgeJob:{kind:'sync-rag',retrySupported:false,minimumLevel:2}});
    });

    it('Обычная операция не читает очередь моста',async()=>{
        query.mockImplementation(async(sql:string)=>({rows:sql.includes('count(*)')?[{n:1,active:0}]:[{...row,resource_type:'project'}]}));
        await repository.list(1,10);expect(query).toHaveBeenCalledTimes(2);
        query.mockClear();await repository.get('ordinary');expect(query).toHaveBeenCalledOnce();
    });

    it('Задания всей страницы обогащаются одним запросом без payload',async()=>{
        await repository.list(1,10);
        const calls=query.mock.calls.filter(([sql])=>sql.includes('FROM bridge_jobs'));
        expect(calls).toHaveLength(1);expect(calls[0][1]).toEqual([[jobId]]);expect(calls[0][0]).not.toContain('payload');
        expect(calls[0][0]).toContain('EXISTS (SELECT 1 FROM projects');
    });

    it.each(['open-local-recovery-folder','future-kind'])('Действие %s не повторяется без актуального сценария',async kind=>{
        const jobsService=new DeviceJobs({pool:{query:vi.fn().mockResolvedValue({rows:[{id:jobId,email:actor,kind,state:'failed',payload:{}}]})}} as unknown as DeviceStore,
            {} as DeviceArtifacts,{} as DeviceInstallations,{} as InstallPlans);
        const create=vi.spyOn(jobsService,'create').mockResolvedValue({id:'unexpected'});
        await expect(jobsService.retry({email:actor,activeRole:'Разработчик'},jobId,jobId)).rejects.toMatchObject({status:409});
        expect(create).not.toHaveBeenCalled();
    });
});
