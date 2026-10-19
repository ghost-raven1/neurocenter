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
vi.mock('../src/package-build/build-process',()=>({stagingLimit:4*1024**3,runPackageBuilder:mocks.run,stopBuildProcess:mocks.stop}));
import {PackageBuildService} from '../src/package-build/package-build.service';

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
            {} as RuntimeArtifacts,{} as CatalogService);
        Object.assign(service,{lease:{},repository:{progress}});
        const row={id:randomUUID(),actor:'builder@example.test',config:{name:'Проверка позднего запуска'}} as BuildRow;
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
});
