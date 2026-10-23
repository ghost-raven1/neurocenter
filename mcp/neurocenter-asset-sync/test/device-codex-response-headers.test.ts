import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {readCodexResponse} from '../src/features/device-codex-inference/response.js';
import {runDeviceCodexJob} from '../src/features/device-codex-inference/executor.js';
import {readCodexReceipt,codexDeliveryResult} from '../src/features/device-codex-inference/receipts.js';
import {sanitizeCodexDiagnostic} from '../src/features/device-codex-inference/diagnostics.js';
import {DEVICE_CODEX_PROTOCOL,type DeviceCodexContext,type DeviceCodexPayload} from '../src/features/device-codex-inference/contract.js';
import {providerFixture,noop} from './opencode-provider.fixture.js';

const model='qa-header-model',secret='PRIVATE_BODY_MUST_NOT_ENTER_DIAGNOSTICS';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();await Promise.all(cleanup.splice(0).map(close=>close()));});
const terminal=()=>({type:'response.completed',response:{model,status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'QA answer'}]}],usage:{input_tokens:2,output_tokens:3}}});
const event=(value:unknown)=>'data: '+JSON.stringify(value)+'\n\n';

/** A byte stream avoids Response(string)'s automatic text/plain header; every fixture belongs to this test. */
function reply(body:string|Uint8Array,options:{contentType?:string;status?:number;closed?:boolean}={}){
    const cancel=vi.fn(),bytes=typeof body==='string'?new TextEncoder().encode(body):body;
    const stream=new ReadableStream<Uint8Array>({start(controller){if(bytes.length)controller.enqueue(bytes);if(options.closed)controller.close();},cancel});
    const response=new Response(stream,{status:options.status??200,headers:options.contentType===undefined?{}:{'content-type':options.contentType}});
    return {response,cancel};
}
const parse=(response:Response)=>readCodexResponse(response,model,randomUUID(),new AbortController().signal);

describe('A missing Content-Type does not bypass strict bounded Codex SSE validation',()=>{
    it('accepts a complete exact-model SSE with an absent header and releases the stream',async()=>{
        const f=reply(event(terminal()));expect(f.response.headers.has('content-type')).toBe(false);
        expect(await parse(f.response)).toMatchObject({response:{model,done:true,message:{content:'QA answer'},prompt_eval_count:2,eval_count:3}});
        expect(f.cancel).toHaveBeenCalledOnce();
    });
    it('accepts an explicit SSE media type case-insensitively',async()=>{
        const f=reply(event(terminal()),{contentType:'Text/Event-Stream; charset=utf-8'});
        expect(await parse(f.response)).toMatchObject({response:{model}});expect(f.cancel).toHaveBeenCalledOnce();
    });
    it.each(['application/json','text/plain','text/event-streamish'])('rejects explicit %s even when its body looks like SSE, and cancels it',async contentType=>{
        const f=reply(event(terminal()),{contentType});
        await expect(parse(f.response)).rejects.toMatchObject({reason:'content-type'});expect(f.cancel).toHaveBeenCalledOnce();
    });
    it.each([400,401,403,500])('rejects HTTP%s before accepting any terminal event, and cancels its body',async status=>{
        const f=reply(event(terminal()),{status});await expect(parse(f.response)).rejects.toMatchObject({reason:'http-status'});expect(f.cancel).toHaveBeenCalledOnce();
    });
    it.each([
        ['JSON',JSON.stringify(terminal().response),'premature-eof'],
        ['empty','','premature-eof'],
        ['partial',event({type:'response.output_text.delta',delta:secret}),'premature-eof'],
        ['truncated',event(terminal()).slice(0,-2),'premature-eof'],
        ['wrong-model',event({...terminal(),response:{...terminal().response,model:'other'}}),'model-mismatch'],
        ['tool-call',event({...terminal(),response:{...terminal().response,output:[{type:'function_call',arguments:secret}]}}),'unsupported-output'],
        ['provider-failed',event({type:'response.failed',error:{message:secret}}),'provider-failed'],
        ['malformed-event','data: {PRIVATE_INVALID_JSON\n\n','event-json'],
        ['empty-terminal',event({...terminal(),response:{...terminal().response,output:[]}}),'invalid-terminal'],
    ])('missing MIME still rejects %s without interpreting it as a successful response',async(_name,body,reason)=>{
        const f=reply(body,{closed:true});await expect(parse(f.response)).rejects.toMatchObject({reason});
    });
    it('missing MIME retains the stream byte limit and invalid UTF-8 rejection',async()=>{
        await expect(parse(reply(new Uint8Array(2*1024*1024+1),{closed:true}).response)).rejects.toMatchObject({reason:'stream-limit'});
        await expect(parse(reply(Uint8Array.from([0xff,0xfe]),{closed:true}).response)).rejects.toMatchObject({reason:'invalid-utf8'});
    });
    it('an absent body is an explicit bounded failure',async()=>{
        await expect(parse(new Response(null))).rejects.toMatchObject({reason:'empty-body'});
    });

    it('persists only the closed parser reason privately and replays the failed receipt without resending',async()=>{
        const local=await providerFixture();cleanup.push(local.cleanup);
        const payload:DeviceCodexPayload={protocol:DEVICE_CODEX_PROTOCOL,callId:randomUUID(),modelId:'model-headers',modelPin:'e'.repeat(64),connectionRevision:1,source:{scope:'global'},deadlineAt:new Date(Date.now()+30000).toISOString()};
        const job={id:randomUUID(),lease:randomUUID(),payload};
        const context:DeviceCodexContext={protocol:DEVICE_CODEX_PROTOCOL,callId:payload.callId,model,capability:'chat',messages:[{role:'user',content:'QA prompt'}],options:{},source:payload.source,
            expectedCandidate:{provider:'codexbridge',configKey:model,model,modelVersion:model,capability:'chat',baseUrl:null},connectorPackage:{},deadlineAt:payload.deadlineAt};
        const outbound=vi.fn(async()=>reply(JSON.stringify({error:secret}),{closed:true}).response);vi.stubGlobal('fetch',outbound);
        const deps={context:async()=>context,dispatch:vi.fn(async()=>({ok:true})),transport:async(_pkg:unknown,_authorize:()=>Promise<unknown>,send:typeof fetch)=>send,prepare:noop,checkLocal:noop};
        expect((await runDeviceCodexJob(job,local.descriptor.deviceId,noop,deps)).state).toBe('failed');
        const receipt=await readCodexReceipt(job.id,local.descriptor.deviceId,payload);
        expect((receipt as unknown as {diagnostic:unknown}).diagnostic).toEqual({schemaVersion:1,stage:'response-validation',httpStatus:200,mediaType:'missing',reason:'premature-eof'});
        expect(JSON.stringify(receipt)).not.toContain(secret);
        expect(await codexDeliveryResult(job.id,local.descriptor.deviceId,payload.callId)).toEqual({protocol:DEVICE_CODEX_PROTOCOL,callId:payload.callId,error:{code:'unknown-after-send'}});
        await runDeviceCodexJob(job,local.descriptor.deviceId,noop,deps);expect(outbound).toHaveBeenCalledOnce();expect(deps.dispatch).toHaveBeenCalledOnce();
    });
    it('only the known parser reason at the validation stage survives diagnostic projection',()=>{
        const base={schemaVersion:1,stage:'response-validation',httpStatus:200,mediaType:'missing'};
        expect(sanitizeCodexDiagnostic({...base,reason:'model-mismatch',message:secret})).toEqual({...base,reason:'model-mismatch'});
        expect(sanitizeCodexDiagnostic({...base,reason:secret})).toEqual(base);
        expect(sanitizeCodexDiagnostic({...base,stage:'preflight',reason:'model-mismatch'})).toEqual({schemaVersion:1,stage:'preflight'});
    });
});
