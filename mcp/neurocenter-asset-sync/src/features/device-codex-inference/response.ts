import {normalizeDeviceCodexResult,DEVICE_CODEX_PROTOCOL,type DeviceCodexResult} from './contract.js';
import type {ReadableStreamReadResult} from 'node:stream/web';

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const usageCount=(value:unknown):number|null=>Number.isSafeInteger(value)&&Number(value)>=0?Number(value):null;
export const CODEX_RESPONSE_FAILURE_REASONS=['http-status','content-type','empty-body','stream-read','premature-eof','stream-limit','invalid-utf8','event-json','event-shape','provider-failed','model-mismatch','invalid-terminal','unsupported-output','output-limit'] as const;
export type CodexResponseFailureReason=typeof CODEX_RESPONSE_FAILURE_REASONS[number];
/** A closed local reason describes validation, never provider text or generated content. */
export class CodexResponseFailure extends Error {
    constructor(readonly reason:CodexResponseFailureReason){super('Ответ Codex не прошёл проверку.');this.name='CodexResponseFailure';}
}
/** Only a terminal Responses event is accepted; EOF, partial output and tool calls cannot become a completed answer. */
function completedResponse(value:unknown,model:string,callId:string):DeviceCodexResult{
    if(!record(value)||typeof value.model!=='string'||!['completed','incomplete'].includes(value.status as string)||!Array.isArray(value.output))throw new CodexResponseFailure('invalid-terminal');
    if(value.model!==model)throw new CodexResponseFailure('model-mismatch');
    let content='';
    for(const output of value.output){
        if(!record(output))throw new CodexResponseFailure('invalid-terminal');
        if(output.type==='reasoning')continue;
        if(output.type!=='message'||output.role!=='assistant'||!Array.isArray(output.content))throw new CodexResponseFailure('unsupported-output');
        for(const part of output.content){
            if(!record(part)||part.type!=='output_text'||typeof part.text!=='string')throw new CodexResponseFailure('unsupported-output');
            content+=part.text;
            if(Buffer.byteLength(content)>480*1024)throw new CodexResponseFailure('output-limit');
        }
    }
    const usage=record(value.usage)?value.usage:{},input=usageCount(usage.input_tokens),output=usageCount(usage.output_tokens);
    const incomplete=record(value.incomplete_details)?value.incomplete_details.reason:undefined;
    if(value.status==='incomplete'&&incomplete!=='max_output_tokens')throw new CodexResponseFailure('invalid-terminal');
    let result:DeviceCodexResult;
    try{result=normalizeDeviceCodexResult({protocol:DEVICE_CODEX_PROTOCOL,callId,response:{model,done:true,done_reason:value.status==='incomplete'?'length':'stop',message:{role:'assistant',content},prompt_eval_count:input,eval_count:output,usage_reported:input!==null||output!==null}});}
    catch{throw new CodexResponseFailure('invalid-terminal');}
    if(Buffer.byteLength(JSON.stringify(result))>480*1024)throw new CodexResponseFailure('output-limit');
    return result;
}
/** The stream is bounded independently from claimed Content-Length and is cancelled on every exit. */
export async function readCodexResponse(response:Response,model:string,callId:string,signal:AbortSignal):Promise<DeviceCodexResult>{
    const type=response.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase();
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw new CodexResponseFailure('http-status');}
    if(!response.body)throw new CodexResponseFailure('empty-body');
    if(type&&type!=='text/event-stream'){await response.body.cancel().catch(()=>{});throw new CodexResponseFailure('content-type');}
    const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,buffer='';
    const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
    try{
        while(true){
            signal.throwIfAborted();let part:ReadableStreamReadResult<Uint8Array>;
            try{part=await reader.read();}catch{if(signal.aborted)throw signal.reason;throw new CodexResponseFailure('stream-read');}
            signal.throwIfAborted();
            if(part.done)throw new CodexResponseFailure('premature-eof');
            bytes+=part.value.byteLength;
            if(bytes>2*1024*1024)throw new CodexResponseFailure('stream-limit');
            let decoded:string;try{decoded=decoder.decode(part.value,{stream:true});}catch{throw new CodexResponseFailure('invalid-utf8');}
            buffer=(buffer+decoded).replace(/\r\n/g,'\n');
            let end:number;
            while((end=buffer.indexOf('\n\n'))>=0){
                const event=buffer.slice(0,end);buffer=buffer.slice(end+2);
                const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
                if(!data||data==='[DONE]')continue;
                let value:unknown;try{value=JSON.parse(data);}catch{throw new CodexResponseFailure('event-json');}
                if(!record(value))throw new CodexResponseFailure('event-shape');
                if(value.type==='response.completed'||value.type==='response.incomplete')return completedResponse(value.response,model,callId);
                if(value.type==='response.failed'||value.type==='error')throw new CodexResponseFailure('provider-failed');
            }
        }
    }finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});}
}
