import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {BuildRow} from '../src/package-build/package-build.model';
import {runtimeReportFixture} from './package-build-runtime.fixture';

const mocks=vi.hoisted(()=>({build:vi.fn(),verify:vi.fn(),release:vi.fn()}));
vi.mock('../src/database/pool',()=>({createPool:()=>({})}));
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:async()=>mocks.release}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
vi.mock('../src/devices/device-operations',()=>({notifyDeviceOperations:vi.fn()}));
vi.mock('../src/package-build/build-process',async()=>({...await vi.importActual('../src/package-build/build-process'),runPackageBuilder:mocks.build}));
vi.mock('../src/package-build/build-runtime',async()=>({...await vi.importActual('../src/package-build/build-runtime'),verifyBuildRuntime:mocks.verify}));
import {PackageBuildService} from '../src/package-build/package-build.service';

const roots:string[]=[];
beforeEach(()=>vi.clearAllMocks());
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-queue-runtime-'));roots.push(root);
    const row={id:randomUUID(),request_key:randomUUID(),execution_nonce:randomUUID(),state:'RUNNING',actor:'packager@example.test',
        config:{kind:'plugin',name:'Queue gate fixture',description:'Fixture',tags:[],targets:['darwin-arm64'],
            source:{type:'files',entrypoint:'index.mjs',files:[{path:'index.mjs',content:'export default()=>({});'}]}}} as BuildRow;
    const claims=vi.fn(async()=>({userRoles:['Главный админ']}));
    const importArchive=vi.fn(),prepareLocal=vi.fn(),beginPublication=vi.fn(),recordRuntime=vi.fn();
    const progress=vi.fn(async(_id:string,state:BuildRow['state'])=>{if(state==='FAILED')row.state=state;});
    const service=new PackageBuildService({claims} as never,{importArchive} as never,{} as never,{prepareLocal} as never);
    Object.assign(service,{lease:{},repository:{get:async()=>row,progress,recordRuntime,beginPublication},
        withLease:async(_lease:unknown,work:()=>Promise<unknown>)=>work()});
    mocks.build.mockImplementation(async(_config:unknown,stage:string)=>{
        const manifest=path.join(stage,'asset.json');await fs.writeFile(manifest,JSON.stringify({fixture:'candidate'}));return manifest;
    });
    const run=()=>(service as unknown as{execute:(row:BuildRow,root:string)=>Promise<void>}).execute(row,root);
    return {row,root,claims,progress,importArchive,prepareLocal,beginPublication,recordRuntime,run};
}

describe('Queue worker runtime gate before import and publication',()=>{
    it.each(['failed-report','verifier-error'] as const)('never imports or publishes before the gate settles: %s',async outcome=>{
        const f=await fixture();let release:()=>void=()=>{};
        const waiting=new Promise<void>(resolve=>{release=resolve;});
        mocks.verify.mockImplementation(async(manifest:string,identity:string)=>{
            await waiting;
            if(outcome==='verifier-error')throw new Error('Проверяющий runtime недоступен.');
            return runtimeReportFixture(manifest,identity,false);
        });
        const pending=f.run();
        await vi.waitFor(()=>expect(mocks.verify).toHaveBeenCalledOnce());
        expect(f.importArchive).not.toHaveBeenCalled();expect(f.prepareLocal).not.toHaveBeenCalled();expect(f.beginPublication).not.toHaveBeenCalled();
        release();await pending;
        expect(f.importArchive).not.toHaveBeenCalled();expect(f.prepareLocal).not.toHaveBeenCalled();expect(f.beginPublication).not.toHaveBeenCalled();
        expect(f.row.state).toBe('FAILED');
        expect(f.recordRuntime).toHaveBeenCalledTimes(outcome==='failed-report'?1:0);
        if(outcome==='failed-report')expect(f.recordRuntime).toHaveBeenCalledWith(f.row.id,f.row.execution_nonce,1,expect.objectContaining({ok:false}),expect.any(Object));
        await expect(fs.stat(path.join(f.root,f.row.id))).rejects.toMatchObject({code:'ENOENT'});
        expect(mocks.release).toHaveBeenCalledOnce();
    });
    it('fresh role revocation after successful verification still prevents every publication effect',async()=>{
        const f=await fixture();
        mocks.verify.mockImplementation(async(manifest:string,identity:string)=>{
            const report=await runtimeReportFixture(manifest,identity);f.claims.mockResolvedValue({userRoles:[]});return report;
        });
        await f.run();
        expect(f.recordRuntime).toHaveBeenCalledOnce();expect(f.row.state).toBe('FAILED');
        expect(f.importArchive).not.toHaveBeenCalled();expect(f.prepareLocal).not.toHaveBeenCalled();expect(f.beginPublication).not.toHaveBeenCalled();
        expect(f.progress).toHaveBeenLastCalledWith(f.row.id,'FAILED',0,expect.stringContaining('Права главного администратора отозваны'),undefined,expect.any(String));
    });
});
