vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined),requireFeatureEnabled:vi.fn(async()=>undefined)}));
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ChildProcess} from 'node:child_process';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {AccessDb} from '../src/access/access-db';
import type {RuntimeArtifacts} from '../src/runtime-artifacts/runtime-artifacts';
import type {CatalogService} from '../src/catalog/catalog.service';
import type {BuildRow} from '../src/package-build/package-build.model';

const mocks=vi.hoisted(()=>({run:vi.fn(),stop:vi.fn(),release:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({})}));
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:async()=>mocks.release}));
vi.mock('../src/devices/device-operations',()=>({notifyDeviceOperations:vi.fn()}));
vi.mock('../src/package-build/build-process',async()=>({...await vi.importActual('../src/package-build/build-process'),stagingLimit:4*1024**3,runPackageBuilder:mocks.run,stopBuildProcess:mocks.stop}));
import {PackageBuildService} from '../src/package-build/package-build.service';
import {BuildProcessUnreapedError} from '../src/package-build/build-process';
import {BuildCancelledError,cleanupBuildStages} from '../src/package-build/build-cancellation';

function barrier(){let resolve:()=>void=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}

describe('Поздний запуск дочерней сборки после ожидания файловой системы',()=>{
    let root:string|undefined;
    afterEach(async()=>{if(root)await fs.rm(root,{recursive:true,force:true});vi.clearAllMocks();});
    it.each(['lease','shutdown'])('Потеря %s до observe немедленно останавливает появившийся процесс',async reason=>{
        root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-child-lifetime-'));
        const prepared=barrier(),resume=barrier(),child={pid:123} as ChildProcess;
        mocks.run.mockImplementation(async(_config:unknown,_stage:string,observe:(child:ChildProcess)=>void)=>{
            prepared.resolve();await resume.promise;observe(child);throw new Error('Дочерняя сборка остановлена');
        });
        const progress=vi.fn().mockResolvedValue(undefined);
        const service=new PackageBuildService({claims:async()=>({userRoles:['Главный админ']})} as unknown as AccessDb,
            {} as RuntimeArtifacts,{} as CatalogService,{} as never);
        Object.assign(service,{lease:{},repository:{progress}});
        const row={id:randomUUID(),actor:'builder@example.test',config:{name:'Проверка позднего запуска',source:{type:'files',entrypoint:'index.mjs',files:[{path:'index.mjs',content:'export default()=>({})'}]}}} as BuildRow;
        const execute=(service as unknown as{execute:(row:BuildRow,root:string)=>Promise<void>}).execute.bind(service);
        const running=execute(row,root);
        await prepared.promise;
        Object.assign(service,reason==='lease'?{lease:undefined}:{stopping:true});
        resume.resolve();await running;
        expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(child);
        expect(progress).toHaveBeenLastCalledWith(row.id,'FAILED',0,'Дочерняя сборка остановлена',undefined,'Дочерняя сборка остановлена');
        expect(mocks.release).toHaveBeenCalledOnce();
        expect(await fs.readdir(root)).toEqual([]);
    });
    it('An unconfirmed child reap preserves staging and never reports completed cancellation',async()=>{
        root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-unconfirmed-child-'));
        const id=randomUUID(),progress=vi.fn(async(_id:string,state:string)=>{if(state==='FAILED')throw new BuildCancelledError();});
        const completeCancellation=vi.fn(),cancellationAwaitingOwner=vi.fn();
        mocks.run.mockImplementation(async(_config:unknown,stage:string)=>{await fs.writeFile(path.join(stage,'pending-writer'),'keep');throw new BuildProcessUnreapedError();});
        const service=new PackageBuildService({claims:async()=>({userRoles:['Главный админ']})} as never,{} as never,{} as never,{} as never);
        Object.assign(service,{lease:{},repository:{progress,completeCancellation,cancellationAwaitingOwner}});
        await (service as unknown as{execute:(row:BuildRow,root:string)=>Promise<void>}).execute({id,actor:'owner@example.test',config:{source:{type:'files'}}} as BuildRow,root);
        expect(completeCancellation).not.toHaveBeenCalled();expect(cancellationAwaitingOwner).toHaveBeenCalledWith(id);
        expect(await fs.readFile(path.join(root,id,'pending-writer'),'utf8')).toBe('keep');
    });
    it('Retries a transient cleanup failure in the same live parent after its worker has stopped',async()=>{
        root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-cancel-cleanup-retry-'));
        const id=randomUUID(),row={id,execution_nonce:randomUUID(),execution_host:(await import('node:os')).hostname(),execution_pid:process.pid,execution_started:true,state:'CANCELLING',actor:'owner@example.test',config:{source:{type:'files'}}} as BuildRow;
        const stage=path.join(root,id),failure=Object.assign(Error('Transient cleanup busy'),{code:'EBUSY'});
        const remove=fs.rm.bind(fs);let failed=false;
        const removal=vi.spyOn(fs,'rm').mockImplementation(async(filename,options)=>{if(String(filename)===stage&&!failed){failed=true;throw failure;}return remove(filename,options);});
        const completeCancellation=vi.fn(async()=>{row.state='CANCELLED';}),cancellationCleanupFailed=vi.fn(),cancellationAwaitingOwner=vi.fn();
        const repository={progress:vi.fn(),completeCancellation,cancellationCleanupFailed,cancellationAwaitingOwner,stagesToClean:async()=>[row],cancellationsWithoutStage:async()=>[]};
        mocks.run.mockRejectedValue(new BuildCancelledError());
        const service=new PackageBuildService({claims:async()=>({userRoles:['Главный админ']})} as never,{} as never,{} as never,{} as never);
        Object.assign(service,{lease:{},repository});
        try{
            await expect((service as unknown as{execute:(row:BuildRow,root:string)=>Promise<void>}).execute(row,root)).rejects.toBe(failure);
            expect(completeCancellation).not.toHaveBeenCalled();expect(cancellationCleanupFailed).toHaveBeenCalledWith(id);expect(await fs.stat(stage)).toBeDefined();
            const ownStopped=(service as unknown as{stoppedWorkers?:Set<string>}).stoppedWorkers;
            await cleanupBuildStages(repository as never,root,ownStopped);
            expect(row.state).toBe('CANCELLED');expect(completeCancellation).toHaveBeenCalledOnce();expect(cancellationAwaitingOwner).not.toHaveBeenCalled();
            await expect(fs.stat(stage)).rejects.toMatchObject({code:'ENOENT'});
        }finally{removal.mockRestore();}
    });
});
