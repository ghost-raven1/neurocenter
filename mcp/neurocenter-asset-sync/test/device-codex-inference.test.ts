import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {providerFixture,noop} from './opencode-provider.fixture.js';
import {runDeviceCodexJob} from '../src/features/device-codex-inference/executor.js';
import {readCodexResponse} from '../src/features/device-codex-inference/response.js';
import {readCodexReceipt,writeCodexReceipt,codexDeliveryResult,recoverCodexCompletions} from '../src/features/device-codex-inference/receipts.js';
import {DEVICE_CODEX_PROTOCOL,type DeviceCodexContext,type DeviceCodexPayload} from '../src/features/device-codex-inference/contract.js';
import {saveCompletion,pendingCompletions,deliverCompletions} from '../src/bridge/completions.js';
import {hash,stateDir} from '../src/bridge/state.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();await Promise.all(cleanup.splice(0).map(fn=>fn()));});
const model='qa-exact-codex';
const terminal=(content='Answer PRIVATE_ANSWER',usage:unknown={input_tokens:13,output_tokens:7})=>({type:'response.completed',response:{model,status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:content}]}],usage}});
const stream=(events:unknown[])=>new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
async function fixture(){
    const local=await providerFixture();cleanup.push(local.cleanup);
    const payload:DeviceCodexPayload={protocol:DEVICE_CODEX_PROTOCOL,callId:randomUUID(),modelId:'model-exact',modelPin:'e'.repeat(64),connectionRevision:2,source:{scope:'global'},deadlineAt:new Date(Date.now()+30000).toISOString()};
    const job={id:randomUUID(),lease:randomUUID(),payload};
    const context:DeviceCodexContext={protocol:DEVICE_CODEX_PROTOCOL,callId:payload.callId,model,capability:'chat',messages:[{role:'user',content:'Prompt PRIVATE_PROMPT'}],options:{reasoningEffort:'high',store:false},source:payload.source,
        expectedCandidate:{provider:'codexbridge',configKey:model,model,modelVersion:model,capability:'chat',baseUrl:'https://chatgpt.com/backend-api/codex',options:{apiFormat:'responses',store:false}},connectorPackage:{},deadlineAt:payload.deadlineAt};
    const transport=vi.fn(async(_pkg,authorize,outbound)=>async(input:RequestInfo|URL,init?:RequestInit)=>{await authorize();return outbound(input,init);});
    const deps={context:vi.fn(async()=>context),dispatch:vi.fn(async()=>({ok:true})),transport,checkLocal:vi.fn(noop),prepare:vi.fn(noop)};
    return {...local,payload,job,context,deps};
}

describe('One-shot device Codex inference and private receipt delivery',()=>{
    it('persists admission before fetch and replays only saved delivery after a lost ACK',async()=>{
        const f=await fixture(),outbound=vi.fn(async()=>{
            expect(await readCodexReceipt(f.job.id,f.descriptor.deviceId,f.payload)).toMatchObject({state:'started'});
            expect(f.deps.dispatch).toHaveBeenCalledOnce();return stream([terminal()]);
        });vi.stubGlobal('fetch',outbound);
        const completed=await runDeviceCodexJob(f.job,f.descriptor.deviceId,noop,f.deps);
        expect(completed.state).toBe('succeeded');expect(outbound).toHaveBeenCalledOnce();
        const sent=JSON.parse(outbound.mock.calls[0]?.[1]?.body as string);
        expect(sent).toMatchObject({model,reasoning:{effort:'high'},stream:true,store:false});expect(sent).not.toHaveProperty('tools');
        await saveCompletion({id:f.job.id,lease:f.job.lease,deviceId:f.descriptor.deviceId,...completed});
        const generic=await pendingCompletions();expect(JSON.stringify(generic)).not.toMatch(/PRIVATE_PROMPT|PRIVATE_ANSWER|accessToken/);
        expect(await fs.readFile(path.join(stateDir(),'completions',f.job.id+'.json'),'utf8')).not.toMatch(/PRIVATE_PROMPT|PRIVATE_ANSWER/);
        const send=vi.fn(async()=>{throw new Error('lost ACK');});await expect(deliverCompletions(send)).rejects.toThrow('lost ACK');
        const first=send.mock.calls[0]?.[0];expect(first).toMatchObject({result:{response:{message:{content:'Answer PRIVATE_ANSWER'},prompt_eval_count:13,eval_count:7}}});
        const retry=vi.fn(noop);await deliverCompletions(retry);expect(retry.mock.calls[0]?.[0]).toEqual(first);
        expect((await runDeviceCodexJob(f.job,f.descriptor.deviceId,()=>{throw new Error('revoked');},f.deps)).state).toBe('succeeded');
        expect(outbound).toHaveBeenCalledOnce();expect(f.deps.context).toHaveBeenCalledOnce();
    });
    it('a started crash marker becomes unknown-after-send and never sends a second model request',async()=>{
        const f=await fixture();await writeCodexReceipt({schemaVersion:1,jobId:f.job.id,lease:f.job.lease,deviceId:f.descriptor.deviceId,callId:f.payload.callId,payloadHash:hash(JSON.stringify(f.payload)),state:'started'},undefined);
        vi.stubGlobal('fetch',vi.fn());expect((await runDeviceCodexJob(f.job,f.descriptor.deviceId,noop,f.deps)).state).toBe('failed');
        expect(await codexDeliveryResult(f.job.id,f.descriptor.deviceId,f.payload.callId)).toMatchObject({error:{code:'unknown-after-send'}});
        expect(fetch).not.toHaveBeenCalled();expect(f.deps.context).not.toHaveBeenCalled();
    });
    it('recovers private completion after a crash before the generic completion was written',async()=>{
        const f=await fixture();vi.stubGlobal('fetch',vi.fn(async()=>stream([terminal()])));
        await runDeviceCodexJob(f.job,f.descriptor.deviceId,noop,f.deps);expect(await pendingCompletions()).toEqual([]);
        await recoverCodexCompletions(saveCompletion);await recoverCodexCompletions(saveCompletion);
        const send=vi.fn(noop);await deliverCompletions(send);expect(send).toHaveBeenCalledOnce();expect(send.mock.calls[0]?.[0]).toMatchObject({result:{response:{model}}});
        await recoverCodexCompletions(saveCompletion);expect(await pendingCompletions()).toEqual([]);expect(fetch).toHaveBeenCalledOnce();
    });
    it('a partial stream cannot become success or be retried after the external send',async()=>{
        const f=await fixture(),outbound=vi.fn(async()=>stream([{type:'response.output_text.delta',delta:'partial PRIVATE_PARTIAL'}]));vi.stubGlobal('fetch',outbound);
        expect((await runDeviceCodexJob(f.job,f.descriptor.deviceId,noop,f.deps)).state).toBe('failed');
        expect(await codexDeliveryResult(f.job.id,f.descriptor.deviceId,f.payload.callId)).toMatchObject({error:{code:'unknown-after-send'}});
        await runDeviceCodexJob(f.job,f.descriptor.deviceId,noop,f.deps);expect(outbound).toHaveBeenCalledOnce();
        expect(JSON.stringify(await readCodexReceipt(f.job.id,f.descriptor.deviceId,f.payload))).not.toContain('PRIVATE_PARTIAL');
    });
    it('authorization revocation aborts the running fetch and is never reported as a complete answer',async()=>{
        const f=await fixture();let allowed=true;const authorization=async()=>{if(!allowed)throw new Error('PRIVATE_TOKEN');};
        let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
        vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{entered();return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));}));
        const result=runDeviceCodexJob(f.job,f.descriptor.deviceId,authorization,{...f.deps,pollMs:10});await started;allowed=false;
        expect((await result).state).toBe('failed');expect(await codexDeliveryResult(f.job.id,f.descriptor.deviceId,f.payload.callId)).toMatchObject({error:{code:'unknown-after-send'}});
        expect(fetch).toHaveBeenCalledOnce();
    });
    it.each(['flag-off','revoked','offline'])('preserves the full terminal receipt when the final authorization check fails: %s',async reason=>{
        const f=await fixture();let terminalRead=false;
        const authorize=vi.fn(async()=>{if(terminalRead)throw new Error(reason);});
        const body=new ReadableStream<Uint8Array>({
            start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(terminal())+'\n\n'));},
            cancel(){terminalRead=true;},
        });
        const outbound=vi.fn(async()=>new Response(body,{headers:{'content-type':'text/event-stream'}}));vi.stubGlobal('fetch',outbound);
        const completed=await runDeviceCodexJob(f.job,f.descriptor.deviceId,authorize,f.deps);
        expect(terminalRead).toBe(true);expect(completed.state).toBe('succeeded');
        expect(await codexDeliveryResult(f.job.id,f.descriptor.deviceId,f.payload.callId)).toMatchObject({response:{model,message:{content:'Answer PRIVATE_ANSWER'},prompt_eval_count:13,eval_count:7}});
        await saveCompletion({id:f.job.id,lease:f.job.lease,deviceId:f.descriptor.deviceId,...completed});
        const send=vi.fn(noop);await deliverCompletions(send);expect(send.mock.calls[0]?.[0]).toMatchObject({result:{response:{model}}});
        await runDeviceCodexJob(f.job,f.descriptor.deviceId,authorize,f.deps);expect(outbound).toHaveBeenCalledOnce();expect(f.deps.context).toHaveBeenCalledOnce();
    });
    it('a local source edit during connector resolution blocks dispatch before any provider send',async()=>{
        const f=await fixture();let sourceValid=true;
        f.deps.transport.mockImplementationOnce(async(_pkg,_authorize,outbound)=>{sourceValid=false;return async(input,init)=>outbound(input,init);});
        f.deps.checkLocal.mockImplementation(async()=>{if(!sourceValid)throw new Error('changed');});vi.stubGlobal('fetch',vi.fn());
        expect((await runDeviceCodexJob(f.job,f.descriptor.deviceId,noop,f.deps)).state).toBe('failed');expect(fetch).not.toHaveBeenCalled();expect(f.deps.dispatch).not.toHaveBeenCalled();
    });
});
describe('Bounded terminal Responses parsing',()=>{
    it('keeps the exact selected model and reports absent usage honestly',async()=>{
        const result=await readCodexResponse(stream([terminal('Answer',null)]),model,randomUUID(),new AbortController().signal);
        expect(result).toMatchObject({response:{model,prompt_eval_count:null,eval_count:null,usage_reported:false}});
    });
    it.each(['wrong-model','tool-call','oversize','escaped-size','failure','empty'])('rejects %s without a successful normalized answer',async kind=>{
        const event=terminal();
        if(kind==='wrong-model')event.response.model='another-model';
        if(kind==='tool-call')event.response.output=[{type:'function_call'}] as never;
        if(kind==='oversize')event.response.output[0]!.content[0]!.text='x'.repeat(480*1024+1);
        if(kind==='escaped-size')event.response.output[0]!.content[0]!.text='\n'.repeat(260*1024);
        if(kind==='failure')event.type='response.failed';
        if(kind==='empty')event.response.output=[];
        await expect(readCodexResponse(stream([event]),model,randomUUID(),new AbortController().signal)).rejects.toThrow();
    });
});
