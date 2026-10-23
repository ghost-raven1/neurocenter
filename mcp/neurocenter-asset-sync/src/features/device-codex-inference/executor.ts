import {isDeepStrictEqual} from 'node:util';
import {api,hash,hub,readState,type Credentials} from '../../bridge/state.js';
import {projectFolder,projectBindingId,projectInstanceId} from '../../bridge/workspace.js';
import {loadDeviceCodexTransport,deviceCodexConnectorPackage} from '../opencode-providers/connector.js';
import {prepareJobRuntimeArtifacts} from '../../bridge/job-runtime-artifacts.js';
import {assertCodexModelSource} from './model-source.js';
import {DEVICE_CODEX_PROTOCOL,normalizeDeviceCodexPayload,normalizeDeviceCodexContext,type DeviceCodexContext,type DeviceCodexPayload,type DeviceCodexResult} from './contract.js';
import {readCodexReceipt,writeCodexReceipt,codexCompletionSummary,type CodexReceipt} from './receipts.js';
import {readCodexResponse} from './response.js';
import {RuntimeArtifactCapacityError} from '../runtime-artifacts/capacity-error.js';

interface CodexJob {id:string;lease:string;payload:unknown}
interface ExecutionDependencies {
    context:(job:CodexJob)=>Promise<unknown>;
    dispatch:(job:CodexJob,callId:string)=>Promise<unknown>;
    transport:typeof loadDeviceCodexTransport;
    checkLocal?:(context:DeviceCodexContext)=>Promise<void>;
    prepare?:(context:DeviceCodexContext,authorize:()=>Promise<unknown>)=>Promise<unknown>;
    pollMs?:number;
}
const defaults:ExecutionDependencies={
    context:job=>api('codex-inference/context',{jobId:job.id,lease:job.lease}),
    dispatch:(job,callId)=>api('codex-inference/dispatch',{jobId:job.id,lease:job.lease,callId}),
    transport:loadDeviceCodexTransport,
    prepare:(context,authorize)=>prepareJobRuntimeArtifacts([deviceCodexConnectorPackage(context.connectorPackage)],authorize,async()=>{}),
};
const failed=(callId:string,code:Extract<DeviceCodexResult,{error:unknown}>['error']['code']):DeviceCodexResult=>({protocol:DEVICE_CODEX_PROTOCOL,callId,error:{code}});
const unavailable=()=>Object.assign(new Error('Результат Codex не сохранён. Повторная отправка модели заблокирована.'),{localChangesCommitted:true});

async function localContext(deviceId:string,payload:DeviceCodexPayload){
    const site=hub(),source=payload.source,root=source.scope==='project'?await projectFolder(source.projectId):undefined;
    return async()=>{
        if(hub()!==site||(await readState<Credentials>('credentials'))?.deviceId!==deviceId)throw new Error('Подключение компьютера изменилось.');
        if(source.scope==='project'&&(await projectFolder(source.projectId)!==root||await projectBindingId(source.projectId)!==source.bindingId||await projectInstanceId(source.projectId)!==source.instanceId))throw new Error('Привязка проекта изменилась.');
    };
}
function requestBody(context:DeviceCodexContext):Record<string,unknown>{
    if(Object.keys(context.options).some(key=>!['reasoningEffort','store'].includes(key))||context.options.store!==undefined&&context.options.store!==false)throw new Error('Параметры запроса не поддерживаются Codex.');
    const instructions=context.messages.filter(message=>message.role==='system').map(message=>message.content).join('\n\n');
    const input=context.messages.filter(message=>message.role!=='system').map(message=>({role:message.role,content:[
        {type:message.role==='assistant'?'output_text':'input_text',text:message.content},
        ...(message.images??[]).map(data=>({type:'input_image',image_url:imageUrl(data),detail:'auto'})),
    ]}));
    if(!input.length)throw new Error('Запрос Codex не содержит сообщения.');
    return {model:context.model,instructions,input,stream:true,store:false,
        ...(context.options.reasoningEffort?{reasoning:{effort:context.options.reasoningEffort}}:{})};
}
function imageUrl(data:string):string{
    const bytes=Buffer.from(data.slice(0,32),'base64');
    const format=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png'
        :bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'jpeg'
            :bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'webp'
                :['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())?'gif':undefined;
    if(!format)throw new Error('Формат изображения не поддерживается Codex.');
    return 'data:image/'+format+';base64,'+data;
}

/** Dispatch is admitted once; recovery can replay only a private completed receipt, never the external model call. */
export async function runDeviceCodexJob(job:CodexJob,deviceId:string,authorize:()=>Promise<unknown>,dependencies:Partial<ExecutionDependencies>={}){
    const payload=normalizeDeviceCodexPayload(job.payload),deps={...defaults,...dependencies};
    let receipt=await readCodexReceipt(job.id,deviceId,payload),result=receipt?.result;
    const finish=async(value:DeviceCodexResult)=>{
        const completed:CodexReceipt={schemaVersion:1,jobId:job.id,lease:job.lease,deviceId,callId:payload.callId,payloadHash:hash(JSON.stringify(payload)),state:'completed',result:value};
        try{await writeCodexReceipt(completed,receipt);}catch{throw unavailable();}
        receipt=completed;
        return {...codexCompletionSummary(value),message:'response'in value?'Ответ Codex получен.':'Запрос Codex не завершён; повторная отправка не выполнялась.'};
    };
    if(result)return {...codexCompletionSummary(result),message:'Сохранённый результат Codex доставлен.'};
    if(receipt)return finish(failed(payload.callId,'unknown-after-send'));
    const controller=new AbortController(),deadline=Date.parse(payload.deadlineAt)-Date.now();
    const timer=setTimeout(()=>controller.abort(new Error('deadline')),Math.max(0,deadline));
    let poll:ReturnType<typeof setInterval>|undefined,pollPending=false,dispatched=false,denied=false;
    let stage:'preflight'|'runtime'|'transport'='preflight';
    let checkIdentity:()=>Promise<void>=async()=>{};
    const check=async()=>{
        controller.signal.throwIfAborted();
        try{await checkIdentity();await authorize();controller.signal.throwIfAborted();await checkIdentity();}
        catch(error){denied=true;throw error;}
    };
    try{
        if(deadline<=0)throw new Error('deadline');
        checkIdentity=await localContext(deviceId,payload);
        await check();
        const context=normalizeDeviceCodexContext(await deps.context(job));
        if(context.callId!==payload.callId||context.deadlineAt!==payload.deadlineAt||!isDeepStrictEqual(context.source,payload.source))throw new Error('Контекст Codex изменился.');
        const checkSource=()=>deps.checkLocal?deps.checkLocal(context):assertCodexModelSource(context,deviceId,check,async()=>{controller.signal.throwIfAborted();await checkIdentity();});
        await check();await checkSource();await check();
        const body=requestBody(context);
        stage='runtime';await deps.prepare?.(context,check);stage='transport';await check();
        poll=setInterval(()=>{
            if(pollPending)return;pollPending=true;
            void checkSource().then(check).catch(()=>controller.abort(new Error('authorization'))).finally(()=>{pollPending=false;});
        },deps.pollMs??2000);
        const transport=await deps.transport(context.connectorPackage,check,async(input,init)=>{
            if(dispatched||receipt)throw new Error('Повторная отправка Codex запрещена.');
            if(String(input)!=='https://chatgpt.com/backend-api/codex/responses'||init?.method!=='POST')throw new Error('Адрес запроса Codex не подтверждён.');
            await check();await checkSource();await check();
            const started:CodexReceipt={schemaVersion:1,jobId:job.id,lease:job.lease,deviceId,callId:payload.callId,payloadHash:hash(JSON.stringify(payload)),state:'started'};
            await writeCodexReceipt(started,undefined);receipt=started;
            const admission=await deps.dispatch(job,payload.callId);
            if(!admission||typeof admission!=='object'||(admission as {ok?:unknown}).ok!==true)throw new Error('Отправка Codex не разрешена.');
            await check();
            dispatched=true;
            return fetch(input,{...init,signal:controller.signal});
        });
        await check();
        const response=await transport('https://chatgpt.com/backend-api/codex/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
        result=await readCodexResponse(response,context.model,payload.callId,controller.signal);
        await check();
    }catch(error){
        // A complete response remains private evidence; the server decides whether a late ACK may apply it.
        const preparationCode=stage==='runtime'&&error instanceof RuntimeArtifactCapacityError?error.code:undefined;
        if(!result)result=failed(payload.callId,receipt?'unknown-after-send':Date.now()>=Date.parse(payload.deadlineAt)?'deadline':denied||controller.signal.aborted?'authorization':preparationCode??'unavailable');
    }finally{clearTimeout(timer);if(poll)clearInterval(poll);controller.abort();}
    return finish(result!);
}
