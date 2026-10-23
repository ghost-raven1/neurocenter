import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {artifactFixture} from '../../../scripts/test/runtime-artifact-fixture.cjs';
import {canonicalV4,type Package} from '../src/bridge/package.js';
import {hash,stateDir} from '../src/bridge/state.js';
import {runDeviceCodexJob} from '../src/features/device-codex-inference/executor.js';
import {codexDeliveryResult} from '../src/features/device-codex-inference/receipts.js';
import {DEVICE_CODEX_PROTOCOL,type DeviceCodexContext,type DeviceCodexPayload} from '../src/features/device-codex-inference/contract.js';
import {ensureRuntimeArtifact} from '../src/features/runtime-artifacts/cache.js';
import * as runtimeCache from '../src/features/runtime-artifacts/cache.js';
import {LIMITS,runtimeArtifactTarget} from '../src/features/runtime-artifacts/model.js';
import {providerFixture,noop} from './opencode-provider.fixture.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{
    vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();vi.unstubAllEnvs();
    await Promise.all(cleanup.splice(0).map(close=>close()));
});

/** The default executor preparation uses a real archive descriptor and a private temporary cache. */
async function fixture(){
    const local=await providerFixture();cleanup.push(local.cleanup);
    const pin=JSON.parse(await fs.readFile(new URL('../../../services/shared/codex-connector-pin.json',import.meta.url),'utf8'));
    const {descriptor}=artifactFixture([{path:'codex-plugin.mjs',content:'export default async()=>({});'}],runtimeArtifactTarget());
    const pkg:Package={schemaVersion:5,plugin:{id:'qa-codex-capacity',name:'QA Codex',kind:'plugin',version:1},
        config:{extra:{runtimeArtifacts:[descriptor],codexConnector:{schemaVersion:1,authOnly:true,sourceCommit:pin.sourceCommit,version:pin.version,sdkVersion:pin.sdkVersion}}},
        files:[],manifest:{sha256:'',filesCount:0}};
    pkg.manifest.sha256=hash(JSON.stringify(canonicalV4({schemaVersion:pkg.schemaVersion,plugin:pkg.plugin,config:pkg.config,files:[]})));
    const payload:DeviceCodexPayload={protocol:DEVICE_CODEX_PROTOCOL,callId:randomUUID(),modelId:'model-capacity',modelPin:'e'.repeat(64),connectionRevision:1,source:{scope:'global'},deadlineAt:new Date(Date.now()+30000).toISOString()};
    const job={id:randomUUID(),lease:randomUUID(),payload};
    const context:DeviceCodexContext={protocol:DEVICE_CODEX_PROTOCOL,callId:payload.callId,model:'qa-codex',capability:'chat',messages:[{role:'user',content:'QA PRIVATE_PROMPT'}],options:{store:false},source:payload.source,
        expectedCandidate:{provider:'codexbridge',configKey:'qa-codex',model:'qa-codex',modelVersion:'qa-codex',capability:'chat',baseUrl:'https://chatgpt.com/backend-api/codex'},connectorPackage:pkg as unknown as Record<string,unknown>,deadlineAt:payload.deadlineAt};
    const transport=vi.fn(async()=>{throw new Error('Auth transport must not load.');});
    const deps={context:vi.fn(async()=>context),dispatch:vi.fn(async()=>({ok:true})),transport,checkLocal:vi.fn(noop)};
    const network=vi.fn(async()=>{throw new Error('Unexpected PRIVATE_NETWORK_ERROR');});vi.stubGlobal('fetch',network);
    return {...local,pkg,payload,job,deps,network,run:()=>runDeviceCodexJob(job,local.descriptor.deviceId,noop,deps),
        result:()=>codexDeliveryResult(job.id,local.descriptor.deviceId,payload.callId)};
}

async function fillCache(){
    const root=path.join(stateDir(),'runtime-artifacts');await fs.mkdir(root,{recursive:true,mode:0o700});
    const file=await fs.open(path.join(root,'qa-sparse-prior-artifact'),'wx',0o600);
    try{await file.truncate(LIMITS.cacheBytes-128);}finally{await file.close();}
}

async function capacityError(f:Awaited<ReturnType<typeof fixture>>){
    await fillCache();
    try{await ensureRuntimeArtifact(f.pkg,{download:async()=>{throw new Error('Download must not start.');}});}
    catch(error){return error;}
    throw new Error('Expected real runtime preparation to reject the full cache.');
}

describe('Codex runtime preparation preserves an actionable pre-dispatch failure',()=>{
    it.each(['runtime-cache-full','disk-full'] as const)('%s crosses real default preparation without loading auth, dispatching or downloading',async code=>{
        const f=await fixture();
        if(code==='runtime-cache-full')await fillCache();
        else vi.spyOn(fs,'statfs').mockResolvedValue({bavail:0n,bsize:4096n} as never);
        let preparationError:unknown;
        const actualEnsure=ensureRuntimeArtifact;
        const prepare=vi.spyOn(runtimeCache,'ensureRuntimeArtifact').mockImplementation(async(...args)=>{
            try{return await actualEnsure(...args);}catch(error){preparationError=error;throw error;}
        });
        expect((await f.run()).state).toBe('failed');
        expect(prepare).toHaveBeenCalledOnce();
        expect((preparationError as Error)?.message).toMatch(code==='runtime-cache-full'?/места в кэше 2 ГиБ/:/недостаточно свободного места/);
        expect(f.deps.transport).not.toHaveBeenCalled();expect(f.deps.dispatch).not.toHaveBeenCalled();expect(f.network).not.toHaveBeenCalled();
        expect(await f.result()).toEqual({protocol:DEVICE_CODEX_PROTOCOL,callId:f.payload.callId,error:{code}});
        expect((await f.run()).state).toBe('failed');
        expect(f.deps.context).toHaveBeenCalledOnce();expect(f.deps.transport).not.toHaveBeenCalled();expect(f.deps.dispatch).not.toHaveBeenCalled();expect(f.network).not.toHaveBeenCalled();
        const cache=await fs.readdir(path.join(stateDir(),'runtime-artifacts'));
        expect(cache).toEqual(code==='runtime-cache-full'?['qa-sparse-prior-artifact']:[]);
    });

    it('does not classify an arbitrary thrown message or spoofed error code as a capacity failure',async()=>{
        const f=await fixture();
        const prepare=vi.fn(async()=>{throw Object.assign(new Error('PRIVATE_TOKEN disk full'),{code:'runtime-cache-full'});});
        await runDeviceCodexJob(f.job,f.descriptor.deviceId,noop,{...f.deps,prepare});
        expect(await f.result()).toEqual({protocol:DEVICE_CODEX_PROTOCOL,callId:f.payload.callId,error:{code:'unavailable'}});
        expect(f.deps.dispatch).not.toHaveBeenCalled();expect(f.network).not.toHaveBeenCalled();
    });

    it('keeps a real capacity error from the auth-loader stage as an unknown pre-send failure',async()=>{
        const f=await fixture(),error=await capacityError(f);
        await runDeviceCodexJob(f.job,f.descriptor.deviceId,noop,{...f.deps,prepare:noop,transport:async()=>{throw error;}});
        expect(await f.result()).toMatchObject({error:{code:'unavailable'}});expect(f.deps.dispatch).not.toHaveBeenCalled();
    });

    it('a capacity error after the started marker remains unknown-after-send and cannot replay the model',async()=>{
        const f=await fixture(),error=await capacityError(f);
        const transport=vi.fn(async(_pkg,_authorize,outbound)=>outbound);f.network.mockRejectedValue(error);
        const deps={...f.deps,prepare:noop,transport};
        await runDeviceCodexJob(f.job,f.descriptor.deviceId,noop,deps);
        expect(await f.result()).toMatchObject({error:{code:'unknown-after-send'}});
        await runDeviceCodexJob(f.job,f.descriptor.deviceId,noop,deps);
        expect(f.deps.dispatch).toHaveBeenCalledOnce();expect(f.network).toHaveBeenCalledOnce();expect(transport).toHaveBeenCalledOnce();
    });

    it('deadline takes precedence over a preparation capacity error',async()=>{
        const f=await fixture(),error=await capacityError(f);vi.useFakeTimers({toFake:['Date']});
        const prepare=async()=>{vi.setSystemTime(Date.parse(f.payload.deadlineAt)+1);throw error;};
        await runDeviceCodexJob(f.job,f.descriptor.deviceId,noop,{...f.deps,prepare});
        expect(await f.result()).toMatchObject({error:{code:'deadline'}});expect(f.deps.dispatch).not.toHaveBeenCalled();expect(f.network).not.toHaveBeenCalled();
    });

    it('authorization denial takes precedence even when a preparation adapter replaces its thrown error',async()=>{
        const f=await fixture(),error=await capacityError(f);let allowed=true;
        const authorize=async()=>{if(!allowed)throw new Error('PRIVATE_REVOKED');};
        const prepare=async(_context:DeviceCodexContext,check:()=>Promise<unknown>)=>{allowed=false;try{await check();}catch{/* Preserve the dependency failure boundary. */}throw error;};
        await runDeviceCodexJob(f.job,f.descriptor.deviceId,authorize,{...f.deps,prepare});
        expect(await f.result()).toMatchObject({error:{code:'authorization'}});expect(f.deps.dispatch).not.toHaveBeenCalled();expect(f.network).not.toHaveBeenCalled();
    });
});
