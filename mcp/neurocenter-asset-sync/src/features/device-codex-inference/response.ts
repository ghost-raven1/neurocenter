import {normalizeDeviceCodexResult,DEVICE_CODEX_PROTOCOL,type DeviceCodexResult} from './contract.js';

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const usageCount=(value:unknown):number|null=>Number.isSafeInteger(value)&&Number(value)>=0?Number(value):null;
/** Only a terminal Responses event is accepted; EOF, partial output and tool calls cannot become a completed answer. */
function completedResponse(value:unknown,model:string,callId:string):DeviceCodexResult{
    if(!record(value)||value.model!==model||!['completed','incomplete'].includes(String(value.status))||!Array.isArray(value.output))throw new Error('Ответ Codex не завершён.');
    let content='';
    for(const output of value.output){
        if(!record(output))throw new Error('Некорректный ответ Codex.');
        if(output.type==='reasoning')continue;
        if(output.type!=='message'||output.role!=='assistant'||!Array.isArray(output.content))throw new Error('Codex вернул неподдерживаемое действие.');
        for(const part of output.content){
            if(!record(part)||part.type!=='output_text'||typeof part.text!=='string')throw new Error('Некорректный текст Codex.');
            content+=part.text;
            if(Buffer.byteLength(content)>480*1024)throw new Error('Ответ Codex превышает допустимый размер.');
        }
    }
    const usage=record(value.usage)?value.usage:{},input=usageCount(usage.input_tokens),output=usageCount(usage.output_tokens);
    const incomplete=record(value.incomplete_details)?value.incomplete_details.reason:undefined;
    if(value.status==='incomplete'&&incomplete!=='max_output_tokens')throw new Error('Ответ Codex прерван.');
    const result=normalizeDeviceCodexResult({protocol:DEVICE_CODEX_PROTOCOL,callId,response:{model,done:true,done_reason:value.status==='incomplete'?'length':'stop',message:{role:'assistant',content},prompt_eval_count:input,eval_count:output,usage_reported:input!==null||output!==null}});
    if(Buffer.byteLength(JSON.stringify(result))>480*1024)throw new Error('Ответ Codex превышает допустимый размер подтверждения.');
    return result;
}
/** The stream is bounded independently from claimed Content-Length and is cancelled on every exit. */
export async function readCodexResponse(response:Response,model:string,callId:string,signal:AbortSignal):Promise<DeviceCodexResult>{
    if(!response.ok||!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))throw new Error('Codex не подтвердил поток ответа.');
    const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,buffer='';
    const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
    try{
        while(true){
            signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();
            if(part.done)throw new Error('Codex завершил поток до подтверждения результата.');
            bytes+=part.value.byteLength;
            if(bytes>2*1024*1024)throw new Error('Поток Codex превышает допустимый размер.');
            buffer=(buffer+decoder.decode(part.value,{stream:true})).replace(/\r\n/g,'\n');
            let end:number;
            while((end=buffer.indexOf('\n\n'))>=0){
                const event=buffer.slice(0,end);buffer=buffer.slice(end+2);
                const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
                if(!data||data==='[DONE]')continue;
                const value:unknown=JSON.parse(data);
                if(!record(value))throw new Error('Некорректное событие Codex.');
                if(value.type==='response.completed'||value.type==='response.incomplete')return completedResponse(value.response,model,callId);
                if(value.type==='response.failed'||value.type==='error')throw new Error('Codex не завершил запрос.');
            }
        }
    }finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});}
}
