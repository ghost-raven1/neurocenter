import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {BuildConfiguration} from '../src/package-build/package-build.model';
import type {PackageAgentService} from '../src/package-build/package-agent.service';
import type {PackageAgentContext,PackageAgentReview,PackageAgentRuntimeReport} from '../src/package-build/package-agent.model';
import {BuildCancelledError} from '../src/package-build/build-cancellation';
import {BuildDiagnosticError,BuildProcessUnreapedError} from '../src/package-build/build-process';
import {buildVerifiedAttempts} from '../src/package-build/build-attempts';
import type {BuildRuntimeReport} from '../src/package-build/build-runtime';

const directories:string[]=[];
afterEach(async()=>{for(const directory of directories.splice(0))await fs.rm(directory,{recursive:true,force:true});});
const original=(agent=false,maxAttempts=3):BuildConfiguration=>({
    kind:'mcp',name:'test-mcp',description:'Fixture',tags:[],targets:['darwin-arm64'],
    source:{type:'files',entrypoint:'bad.js',args:['--stdio'],files:[{path:'bad.js',content:'export const bad=1;'}, {path:'good.js',content:'export const good=1;'}]},
    ...(agent?{agent:{modelId:'model-packager',expectedModelPin:'a'.repeat(64),maxAttempts}}:{}),
});
async function passingReport(manifest:string,identity:string):Promise<BuildRuntimeReport>{
    return {schemaVersion:1,ok:true,status:'passed',candidate:{identity,sourceDigest:'b'.repeat(64),assetId:'fixture',version:1,
        manifestSha256:createHash('sha256').update(await fs.readFile(manifest)).digest('hex')},hostTarget:'darwin-arm64',testedTarget:'darwin-arm64',untestedTargets:[],
        isolation:{kind:'fixture',osEnforced:true,network:'denied',childProcesses:'denied',disposableProfile:true},
        checks:{integrity:true,initialize:true,toolsList:true,pluginFactory:false,hooks:false},counts:{tools:1,pluginHooks:0},diagnostics:[],
        startedAt:'2026-10-23T00:00:00.000Z',finishedAt:'2026-10-23T00:00:00.001Z',durationMs:1};
}
function failedReport(report:BuildRuntimeReport,code='mcp-initialize-failed'):BuildRuntimeReport {
    return {...report,ok:false,status:'failed',diagnostics:[{code,message:'Controlled runtime diagnostic.'}]};
}
async function fixture(agentEnabled=false,maxAttempts=3){
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc-build-attempt-'));directories.push(directory);
    const config=original(agentEnabled,maxAttempts),events:string[]=[],abort=new AbortController();
    const identity=(attempt:number)=>'build-fixture:'+attempt+':owner';
    const authorize=vi.fn(async()=>{events.push('authorize');});
    const agent={
        propose:vi.fn(async(value:BuildConfiguration,_context:PackageAgentContext)=>{events.push('propose');return value;}),
        review:vi.fn(async(_value:BuildConfiguration,_report:PackageAgentRuntimeReport,_context:PackageAgentContext):Promise<PackageAgentReview>=>{events.push('review');return {decision:'publish'};}),
    };
    const build=vi.fn(async(_value:BuildConfiguration,attempt:number)=>{
        events.push('build:'+attempt);const manifest=path.join(directory,'manifest-'+attempt+'.json');
        await fs.writeFile(manifest,JSON.stringify({fixture:'built-candidate',attempt}));return manifest;
    });
    const verify=vi.fn(async(manifest:string,candidate:string)=>{events.push('verify');return passingReport(manifest,candidate);});
    const record=vi.fn(async(_attempt:number,_report:BuildRuntimeReport)=>{events.push('record');});
    const reset=vi.fn(async()=>{events.push('reset');});
    const context=(attempt:number,feedback?:PackageAgentRuntimeReport):PackageAgentContext=>({
        buildId:'c83f2a14-8c5d-4aa5-8763-ed413b3c8021',executionNonce:'c83f2a14-8c5d-4aa5-8763-ed413b3c8022',actorEmail:'admin@example.test',
        attempt,feedback,signal:abort.signal,candidates:['bad.js','good.js'],authorize,transaction:async()=>{throw new Error('No database in unit test');},
    });
    return {config,directory,events,agent,build,verify,record,reset,authorize,context,identity,abort,
        options:{...(agentEnabled?{agent:agent as unknown as PackageAgentService}:{}),build,verify,record,reset,authorize,context,identity}};
}

describe('The actual bounded build attempt helper',()=>{
    it('passes a classified compile failure to one accepted v2 repair without reviewing a nonexistent runtime',async()=>{
        const f=await fixture(true,2);f.config.recipeVersion=2;
        const failure=new BuildDiagnosticError('Compile failed',{schemaVersion:1,stage:'compile',target:'darwin-arm64',code:'SOURCE_COMPILE_FAILED',reason:'Cannot resolve helper token=PRIVATE',repairable:true});
        f.build.mockRejectedValueOnce(failure);
        f.agent.propose.mockImplementationOnce(async config=>config).mockImplementationOnce(async config=>({...config,source:{...config.source,entrypoint:'good.js'}}));
        const result=await buildVerifiedAttempts(f.config,f.options);
        expect(f.build).toHaveBeenCalledTimes(2);expect(f.verify).toHaveBeenCalledOnce();expect(f.agent.review).toHaveBeenCalledOnce();expect(f.reset).toHaveBeenCalledOnce();
        expect(f.agent.propose.mock.calls[1][1].feedback).toMatchObject({passed:false,build:{stage:'compile',target:'darwin-arm64',code:'SOURCE_COMPILE_FAILED'}});
        expect(JSON.stringify(f.agent.propose.mock.calls[1][1].feedback)).not.toContain('PRIVATE');expect(result.identity).toBe(f.identity(2));
    });
    it('does not reinterpret accepted v1 jobs or exceeded budgets as v2 compile repair',async()=>{
        for(const version of [undefined,2] as const){
            const f=await fixture(true,1);if(version)f.config.recipeVersion=version;
            const failure=new BuildDiagnosticError('Compile failed',{schemaVersion:1,stage:'compile',target:'darwin-arm64',code:'SOURCE_COMPILE_FAILED',reason:'Syntax failed',repairable:true});
            f.build.mockRejectedValue(failure);await expect(buildVerifiedAttempts(f.config,f.options)).rejects.toBe(failure);
            expect(f.agent.propose).toHaveBeenCalledOnce();expect(f.reset).not.toHaveBeenCalled();
        }
        const legacy=await fixture(true,3),failure=new BuildDiagnosticError('Compile failed',{schemaVersion:1,stage:'compile',target:'darwin-arm64',code:'SOURCE_COMPILE_FAILED',reason:'Syntax failed',repairable:true});
        legacy.build.mockRejectedValue(failure);await expect(buildVerifiedAttempts(legacy.config,legacy.options)).rejects.toBe(failure);expect(legacy.agent.propose).toHaveBeenCalledOnce();
    });
    it.each(['BUILD_FAILED','SOURCE_RUNTIME_UNSUPPORTED','SOURCE_DEPENDENCY_INVALID'])('never spends a v2 retry for nonrepairable %s',async code=>{
        const f=await fixture(true,3);f.config.recipeVersion=2;
        const failure=new BuildDiagnosticError('Infrastructure or unsupported source',{schemaVersion:1,stage:'build',target:'darwin-arm64',code,reason:'Controlled reason',repairable:true});
        f.build.mockRejectedValue(failure);await expect(buildVerifiedAttempts(f.config,f.options)).rejects.toBe(failure);
        expect(f.agent.propose).toHaveBeenCalledOnce();expect(f.reset).not.toHaveBeenCalled();
    });
    it('stops an unchanged v2 build repair before repeating the broken recipe',async()=>{
        const f=await fixture(true,3);f.config.recipeVersion=2;
        f.build.mockRejectedValue(new BuildDiagnosticError('Compile failed',{schemaVersion:1,stage:'compile',target:'darwin-arm64',code:'SOURCE_COMPILE_FAILED',reason:'Syntax failed',repairable:true}));
        await expect(buildVerifiedAttempts(f.config,f.options)).rejects.toThrow('не изменил');
        expect(f.agent.propose).toHaveBeenCalledTimes(2);expect(f.build).toHaveBeenCalledOnce();expect(f.verify).not.toHaveBeenCalled();
    });
    it('waits for the mandatory manual runtime gate before it can return a candidate',async()=>{
        const f=await fixture();let complete=false,release:(report:BuildRuntimeReport)=>void=()=>{};
        f.verify.mockImplementation(async()=>{f.events.push('verify');return new Promise(resolve=>{release=resolve;});});
        const pending=buildVerifiedAttempts(f.config,f.options).then(result=>{complete=true;return result;});
        await vi.waitFor(()=>expect(f.verify).toHaveBeenCalledOnce());expect(complete).toBe(false);expect(f.record).not.toHaveBeenCalled();
        const manifest=f.build.mock.results[0];expect(manifest.type).toBe('return');
        const file=await manifest.value;release(await passingReport(file,f.identity(1)));
        await expect(pending).resolves.toMatchObject({manifest:file,identity:f.identity(1)});
        expect(f.events).toEqual(['authorize','authorize','build:1','authorize','verify','record','authorize','authorize']);
        expect(f.agent.propose).not.toHaveBeenCalled();expect(f.agent.review).not.toHaveBeenCalled();
    });
    it('never returns a failed manual candidate, and retains its verification report',async()=>{
        const f=await fixture();f.verify.mockImplementation(async(manifest,identity)=>failedReport(await passingReport(manifest,identity)));
        await expect(buildVerifiedAttempts(f.config,f.options)).rejects.toThrow('Controlled runtime diagnostic');
        expect(f.build).toHaveBeenCalledOnce();expect(f.record).toHaveBeenCalledOnce();expect(f.reset).not.toHaveBeenCalled();expect(f.agent.review).not.toHaveBeenCalled();
    });
    it('enforces the runtime failure gate even when an agent incorrectly approves publication',async()=>{
        const f=await fixture(true);f.verify.mockImplementation(async(manifest,identity)=>failedReport(await passingReport(manifest,identity)));
        await expect(buildVerifiedAttempts(f.config,f.options)).rejects.toThrow('не разрешила публикацию');
        expect(f.agent.review).toHaveBeenCalledOnce();expect(f.build).toHaveBeenCalledOnce();
    });
    it('runs propose, build, runtime review and one bounded repair on the same configuration chain',async()=>{
        const f=await fixture(true,2),repair={...f.config,source:{...f.config.source,entrypoint:'good.js'}} as BuildConfiguration;
        f.verify.mockImplementationOnce(async(manifest,identity)=>failedReport(await passingReport(manifest,identity)));
        f.agent.review.mockResolvedValueOnce({decision:'repair',config:repair});
        const result=await buildVerifiedAttempts(f.config,f.options);
        expect(f.build).toHaveBeenCalledTimes(2);expect(f.agent.propose).toHaveBeenCalledTimes(2);expect(f.agent.review).toHaveBeenCalledTimes(2);
        expect(f.build.mock.calls.map(([value,attempt])=>({entrypoint:value.source.entrypoint,attempt}))).toEqual([{entrypoint:'bad.js',attempt:1},{entrypoint:'good.js',attempt:2}]);
        expect(f.agent.propose.mock.calls[1][1]).toMatchObject({attempt:2,feedback:{passed:false}});
        expect(f.reset).toHaveBeenCalledOnce();expect(f.record.mock.calls.map(([attempt])=>attempt)).toEqual([1,2]);expect(result.identity).toBe(f.identity(2));
    });
    it('stops after three repair attempts without returning any unverified result',async()=>{
        const f=await fixture(true,3);f.verify.mockImplementation(async(manifest,identity)=>failedReport(await passingReport(manifest,identity)));
        f.agent.review.mockImplementation(async(value)=>({decision:'repair',config:value}));
        await expect(buildVerifiedAttempts(f.config,f.options)).rejects.toThrow('Лимит попыток');
        expect(f.build).toHaveBeenCalledTimes(3);expect(f.agent.propose).toHaveBeenCalledTimes(3);expect(f.agent.review).toHaveBeenCalledTimes(3);
        expect(f.reset).toHaveBeenCalledTimes(2);expect(f.record).toHaveBeenCalledTimes(3);
    });
    it.each(['isolation-unavailable','no-host-artifact','configuration-required','integrity-failed','unsafe-environment','cleanup-failed','cancelled'])(
        'does not spend a model review or retry on runtime infrastructure failure %s',async code=>{
            const f=await fixture(true);f.verify.mockImplementation(async(manifest,identity)=>failedReport(await passingReport(manifest,identity),code));
            await expect(buildVerifiedAttempts(f.config,f.options)).rejects.toThrow('Controlled runtime diagnostic');
            expect(f.agent.propose).toHaveBeenCalledOnce();expect(f.agent.review).not.toHaveBeenCalled();expect(f.reset).not.toHaveBeenCalled();expect(f.build).toHaveBeenCalledOnce();
        });
    it('does not spend another proposal on an unclassified builder infrastructure failure',async()=>{
        const f=await fixture(true),error=new Error('Source registry is offline');f.build.mockRejectedValue(error);
        await expect(buildVerifiedAttempts(f.config,f.options)).rejects.toBe(error);
        expect(f.agent.propose).toHaveBeenCalledOnce();expect(f.agent.review).not.toHaveBeenCalled();expect(f.verify).not.toHaveBeenCalled();expect(f.reset).not.toHaveBeenCalled();
    });
    it.each([new BuildCancelledError(),new BuildProcessUnreapedError()])('does not retry cancellation or unreaped builder failure: %s',async error=>{
        const f=await fixture(true);f.build.mockRejectedValue(error);
        await expect(buildVerifiedAttempts(f.config,f.options)).rejects.toBe(error);
        expect(f.agent.propose).toHaveBeenCalledOnce();expect(f.agent.review).not.toHaveBeenCalled();expect(f.reset).not.toHaveBeenCalled();expect(f.verify).not.toHaveBeenCalled();
    });
    it('stops on verification exceptions before any model review or retry',async()=>{
        const f=await fixture(true),error=new Error('Verifier unavailable');f.verify.mockRejectedValue(error);
        await expect(buildVerifiedAttempts(f.config,f.options)).rejects.toBe(error);
        expect(f.record).not.toHaveBeenCalled();expect(f.agent.review).not.toHaveBeenCalled();expect(f.reset).not.toHaveBeenCalled();
    });
    it('rejects bytes changed after verification even when review approves publication',async()=>{
        const f=await fixture(true);
        f.agent.review.mockImplementation(async()=>{
            await fs.appendFile(await f.build.mock.results[0].value,'mutation');return {decision:'publish'};
        });
        await expect(buildVerifiedAttempts(f.config,f.options)).rejects.toThrow('Кандидат изменился');
        expect(f.agent.review).toHaveBeenCalledOnce();expect(f.reset).not.toHaveBeenCalled();
    });
    it('rejects a report for a different candidate identity',async()=>{
        const f=await fixture();f.verify.mockImplementation(async manifest=>passingReport(manifest,'another-candidate'));
        await expect(buildVerifiedAttempts(f.config,f.options)).rejects.toThrow('не разрешила публикацию');
        expect(f.record).toHaveBeenCalledOnce();expect(f.reset).not.toHaveBeenCalled();
    });
    it('stops before build or inference when fresh authorization is revoked',async()=>{
        const f=await fixture(true),error=new Error('Feature or main-admin role revoked');f.authorize.mockRejectedValue(error);
        await expect(buildVerifiedAttempts(f.config,f.options)).rejects.toBe(error);expect(f.agent.propose).not.toHaveBeenCalled();expect(f.build).not.toHaveBeenCalled();
    });
    it('stops after runtime when recording or fresh authorization fails',async()=>{
        const f=await fixture(true),error=new Error('Lease lost while recording');f.record.mockRejectedValue(error);
        await expect(buildVerifiedAttempts(f.config,f.options)).rejects.toBe(error);expect(f.agent.review).not.toHaveBeenCalled();expect(f.reset).not.toHaveBeenCalled();
    });
    it('requires the configured agent service before any build work',async()=>{
        const f=await fixture(true);const options={...f.options,agent:undefined};
        await expect(buildVerifiedAttempts(f.config,options)).rejects.toThrow('недоступен');
        expect(f.build).not.toHaveBeenCalled();expect(f.authorize).not.toHaveBeenCalled();
    });
});
