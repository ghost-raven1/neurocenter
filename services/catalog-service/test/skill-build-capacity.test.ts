vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined),requireFeatureEnabled:vi.fn(async()=>undefined)}));
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {AccessDb} from '../src/access/access-db';
import type {RuntimeArtifacts} from '../src/runtime-artifacts/runtime-artifacts';
import type {CatalogService} from '../src/catalog/catalog.service';
import type {BuildConfiguration,BuildRow} from '../src/package-build/package-build.model';
import {stagingLimit} from '../src/package-build/build-process';

const mocks=vi.hoisted(()=>({reserve:vi.fn(),release:vi.fn(),download:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({})}));
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:mocks.reserve}));
vi.mock('../../shared/skill-repository.cjs',()=>({readSkillRepository:mocks.download}));
vi.mock('../src/devices/device-operations',()=>({notifyDeviceOperations:vi.fn()}));
import {PackageBuildService} from '../src/package-build/package-build.service';

const files=[{path:'SKILL.md',content:'---\nname: capacity-skill\ndescription: Synthetic capacity boundary\n---\n\nInstruction'}];
const repository={type:'repository' as const,url:'https://github.com/fixture/skills',commit:'a'.repeat(40),entrypoint:'SKILL.md'};

describe('Skill staging reservation protects the download and extraction boundary',()=>{
    let root:string,service:PackageBuildService,progress:ReturnType<typeof vi.fn>,prepare:ReturnType<typeof vi.fn>,events:string[];
    beforeEach(async()=>{
        vi.clearAllMocks();events=[];root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-skill-capacity-'));
        mocks.reserve.mockImplementation(async()=>{events.push('reserved');return mocks.release;});
        mocks.download.mockImplementation(async()=>{events.push('download');return files;});
        progress=vi.fn().mockResolvedValue(undefined);prepare=vi.fn().mockImplementation(async()=>{events.push('validated');throw new Error('Synthetic stop before native publication');});
        service=new PackageBuildService({claims:async()=>({userRoles:['Главный админ']})} as unknown as AccessDb,
            {} as RuntimeArtifacts,{} as CatalogService,{prepareLocalSkill:prepare} as never);
        Object.assign(service,{lease:{},repository:{progress}});
    });
    afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
    const execute=async(source:BuildConfiguration['source'])=>{
        const row={id:randomUUID(),request_key:randomUUID(),actor:'capacity@example.test',config:{kind:'skill',name:'Capacity skill',description:'Synthetic capacity boundary',tags:[],targets:[],source}} as BuildRow;
        await (service as unknown as {execute(row:BuildRow,root:string):Promise<void>}).execute(row,root);
        return row;
    };
    it('Reserves the full existing staging budget before starting a GitHub snapshot download',async()=>{
        await execute(repository);
        expect(mocks.reserve).toHaveBeenCalledExactlyOnceWith({resource:'runtime-artifacts',bytes:stagingLimit,path:root});
        expect(mocks.download).toHaveBeenCalledOnce();expect(prepare).toHaveBeenCalledOnce();
        expect(events).toEqual(['reserved','download','validated']);expect(mocks.release).toHaveBeenCalledOnce();expect(await fs.readdir(root)).toEqual([]);
    });
    it('A capacity refusal never starts a download or extraction and leaves no staging files',async()=>{
        mocks.reserve.mockRejectedValue(new Error('Synthetic capacity denied'));
        const row=await execute(repository);
        expect(mocks.download).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();expect(mocks.release).not.toHaveBeenCalled();
        expect(progress).toHaveBeenLastCalledWith(row.id,'FAILED',0,'Synthetic capacity denied',undefined,'Synthetic capacity denied');
        expect(await fs.readdir(root)).toEqual([]);
    });
    it('Only bounded uploaded skill files use the small budget and never enter the repository downloader',async()=>{
        await execute({type:'files',entrypoint:'SKILL.md',files});
        expect(mocks.reserve).toHaveBeenCalledExactlyOnceWith({resource:'runtime-artifacts',bytes:64*1024**2,path:root});
        expect(mocks.download).not.toHaveBeenCalled();expect(prepare).toHaveBeenCalledOnce();expect(mocks.release).toHaveBeenCalledOnce();
        expect(events).toEqual(['reserved','validated']);expect(await fs.readdir(root)).toEqual([]);
    });
});
