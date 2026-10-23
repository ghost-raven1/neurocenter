import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {providerFixture,noop} from './opencode-provider.fixture.js';
import {runDeviceCodexJob} from '../src/features/device-codex-inference/executor.js';
import {readCodexReceipt,writeCodexReceipt,codexDeliveryResult,recoverCodexCompletions} from '../src/features/device-codex-inference/receipts.js';
import {DEVICE_CODEX_PROTOCOL,type DeviceCodexContext,type DeviceCodexPayload} from '../src/features/device-codex-inference/contract.js';
import {saveCompletion,pendingCompletions,deliverCompletions} from '../src/bridge/completions.js';
import {hash} from '../src/bridge/state.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();await Promise.all(cleanup.splice(0).map(close=>close()));});
const compiler=createRequire(new URL('../../../services/catalog-service/package.json',import.meta.url))('esbuild') as typeof import('esbuild');
const secret='PRIVATE_DIAGNOSTIC_MUST_NEVER_STORE';

/** Compile the exact pinned upstream source with the production recipe patch; no official session/RPC module loads. */
async function upstream(root:string){
    const source=JSON.parse(await fs.readFile(new URL('../../../scripts/catalog-plugins/test/fixtures/codex-auth.json',import.meta.url),'utf8'));
    const pin=JSON.parse(await fs.readFile(new URL('../../../services/shared/codex-connector-pin.json',import.meta.url),'utf8'));
    expect(pin.sourceCommit).toBe('de21db304bef59af6421079c10e8a43404fd09fa');
    const original=source.files['auth-provider.ts'] as string;
    expect(hash(original)).toBe(pin.files['auth-provider.ts']);
    const before='const session = await readSession(attempt === 1);',after='const session = await readSession(attempt === 1, request.signal);';
    expect(original.split(before)).toHaveLength(2);
    const {code}=await compiler.transform(original.replace(before,after),{loader:'ts',target:'es2022',format:'esm',legalComments:'eof'});
    const directory=path.join(root,'pinned-transport');await fs.mkdir(directory);
    await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({type:'module'}));
    await fs.writeFile(path.join(directory,'auth-session.js'),'export function readCodexSession(){throw new Error("Official auth reader must never execute.");}');
    const file=path.join(directory,'auth-provider.js');await fs.writeFile(file,code);
    return await import(pathToFileURL(file).href) as {createCodexFetch:(read:(refresh?:boolean,signal?:AbortSignal)=>Promise<unknown>,transport:typeof fetch)=>typeof fetch};
}

async function fixture(){
    const local=await providerFixture();cleanup.push(local.cleanup);
    const provider=await upstream(local.temporary);
    const payload:DeviceCodexPayload={protocol:DEVICE_CODEX_PROTOCOL,callId:randomUUID(),modelId:'model-qa-codex',modelPin:'e'.repeat(64),connectionRevision:1,source:{scope:'global'},deadlineAt:new Date(Date.now()+30000).toISOString()};
    const job={id:randomUUID(),lease:randomUUID(),payload};
    const model='qa-codex';
    const context:DeviceCodexContext={protocol:DEVICE_CODEX_PROTOCOL,callId:payload.callId,model,capability:'chat',messages:[{role:'user',content:secret}],options:{store:false},source:payload.source,
        expectedCandidate:{provider:'codexbridge',configKey:model,model,modelVersion:model,capability:'chat',baseUrl:'https://chatgpt.com/backend-api/codex'},connectorPackage:{},deadlineAt:payload.deadlineAt};
    const read=vi.fn(async(_refresh?:boolean,_signal?:AbortSignal)=>({accessToken:secret,accountId:secret,expiresAt:Date.now()+60000}));
    const transport=vi.fn(async(_pkg:unknown,authorize:()=>Promise<unknown>,outbound:typeof fetch)=>{await authorize();return provider.createCodexFetch(read,outbound);});
    const deps={context:vi.fn(async()=>context),dispatch:vi.fn(async()=>({ok:true})),transport,prepare:vi.fn(noop),checkLocal:vi.fn(noop)};
    const outbound=vi.fn(async()=>new Response(secret,{status:401,headers:{'content-type':'application/json; boundary='+secret,'x-private':secret}}));vi.stubGlobal('fetch',outbound);
    return {...local,payload,job,model,read,deps,outbound,run:()=>runDeviceCodexJob(job,local.descriptor.deviceId,noop,deps),
        receipt:()=>readCodexReceipt(job.id,local.descriptor.deviceId,payload),
        result:()=>codexDeliveryResult(job.id,local.descriptor.deviceId,payload.callId)};
}
const diagnostic=(receipt:unknown)=>(receipt as {diagnostic?:unknown}|undefined)?.diagnostic;

describe('Private Codex diagnostics observe the real pinned transport without changing one-shot delivery',()=>{
    it('retains the first HTTP401 before upstream refresh hits the one-shot guard, and recovery never resends',async()=>{
        const f=await fixture();expect((await f.run()).state).toBe('failed');
        expect(f.outbound).toHaveBeenCalledOnce();expect(f.deps.dispatch).toHaveBeenCalledOnce();
        expect(f.read.mock.calls.map(args=>args[0])).toEqual([false,true]);
        expect(await f.result()).toEqual({protocol:DEVICE_CODEX_PROTOCOL,callId:f.payload.callId,error:{code:'unknown-after-send'}});
        const saved=await f.receipt();expect(diagnostic(saved)).toEqual({schemaVersion:1,stage:'response-headers',httpStatus:401,mediaType:'json'});
        expect(JSON.stringify(saved)).not.toContain(secret);
        await recoverCodexCompletions(saveCompletion);
        expect(JSON.stringify(await pendingCompletions())).not.toMatch(/diagnostic|httpStatus|PRIVATE_DIAGNOSTIC/);
        const send=vi.fn(noop);await deliverCompletions(send);
        expect(send.mock.calls[0]?.[0]).toMatchObject({result:{error:{code:'unknown-after-send'}}});
        expect(JSON.stringify(send.mock.calls[0]?.[0])).not.toMatch(/diagnostic|httpStatus|PRIVATE_DIAGNOSTIC/);
        await f.run();expect(f.outbound).toHaveBeenCalledOnce();expect(f.read).toHaveBeenCalledTimes(2);
    });

    it('accepts the same completed SSE result through the real pinned transport',async()=>{
        const f=await fixture(),event={type:'response.completed',response:{model:f.model,status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'QA complete'}]}]}};
        f.outbound.mockResolvedValue(new Response('data: '+JSON.stringify(event)+'\n\n',{headers:{'content-type':'text/event-stream; charset=utf-8'}}));
        expect((await f.run()).state).toBe('succeeded');
        expect(await f.result()).toMatchObject({response:{model:f.model,message:{content:'QA complete'}}});
        expect(diagnostic(await f.receipt())).toEqual({schemaVersion:1,stage:'completed',httpStatus:200,mediaType:'sse'});
        expect(f.outbound).toHaveBeenCalledOnce();expect(f.read).toHaveBeenCalledOnce();
    });

    it.each(['admission','fetch','runtime'] as const)('%s failure never claims an HTTP response or stores the thrown secret',async kind=>{
        const f=await fixture(),fail=async()=>{throw new Error(secret);};
        if(kind==='admission')f.deps.dispatch.mockImplementation(fail);
        if(kind==='fetch')f.outbound.mockImplementation(fail);
        if(kind==='runtime')f.deps.prepare.mockImplementation(fail);
        await f.run();
        expect(diagnostic(await f.receipt())).toEqual({schemaVersion:1,stage:kind==='admission'?'dispatch-admission':kind==='fetch'?'outbound-fetch':'runtime-preparation'});
        expect(JSON.stringify(await f.receipt())).not.toContain(secret);
        expect(f.outbound).toHaveBeenCalledTimes(kind==='fetch'?1:0);
        expect(await f.result()).toMatchObject({error:{code:kind==='runtime'?'unavailable':'unknown-after-send'}});
    });

    it('legacy started receipt recovery does not invent an HTTP observation after a crash',async()=>{
        const f=await fixture();await writeCodexReceipt({schemaVersion:1,jobId:f.job.id,lease:f.job.lease,deviceId:f.descriptor.deviceId,callId:f.payload.callId,payloadHash:hash(JSON.stringify(f.payload)),state:'started'},undefined);
        await recoverCodexCompletions(saveCompletion);
        expect(diagnostic(await f.receipt())).toBeUndefined();expect(await f.result()).toMatchObject({error:{code:'unknown-after-send'}});
        expect(f.outbound).not.toHaveBeenCalled();expect(f.read).not.toHaveBeenCalled();
    });

    it.each([
        [{schemaVersion:1,stage:'response-headers',httpStatus:401,mediaType:'json',body:secret,message:secret,headers:{authorization:secret}}, {schemaVersion:1,stage:'response-headers',httpStatus:401,mediaType:'json'}],
        [{schemaVersion:1,stage:'preflight',httpStatus:200,mediaType:'sse',body:secret}, {schemaVersion:1,stage:'preflight'}],
        [{schemaVersion:1,stage:'response-headers',httpStatus:600,mediaType:secret}, {schemaVersion:1,stage:'response-headers'}],
        [{schemaVersion:1,stage:secret,httpStatus:401}, undefined],
    ])('private storage projects only the closed diagnostic fields',async(input,expected)=>{
        const f=await fixture();await writeCodexReceipt({schemaVersion:1,jobId:f.job.id,lease:f.job.lease,deviceId:f.descriptor.deviceId,callId:f.payload.callId,payloadHash:hash(JSON.stringify(f.payload)),state:'completed',
            result:{protocol:DEVICE_CODEX_PROTOCOL,callId:f.payload.callId,error:{code:'unavailable'}},diagnostic:input} as never,undefined);
        expect(diagnostic(await f.receipt())).toEqual(expected);expect(JSON.stringify(await f.receipt())).not.toContain(secret);
    });
});
