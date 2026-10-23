import path from 'node:path';
import {hash,stateDir,readState,writeState} from '../../bridge/state.js';
import {syncDirectory} from '../../bridge/atomic-file.js';
import {readPrivateConfiguration,writePrivateConfiguration} from '../local-configuration/private-store.js';
import {DEVICE_CODEX_PROTOCOL,normalizeDeviceCodexResult,type DeviceCodexPayload,type DeviceCodexResult} from './contract.js';
import type {Completion} from '../../bridge/completions.js';
import {sanitizeCodexDiagnostic,type CodexDiagnostic} from './diagnostics.js';

export interface CodexReceipt {schemaVersion:1;jobId:string;lease:string;deviceId:string;callId:string;payloadHash:string;state:'started'|'completed';result?:DeviceCodexResult;diagnostic?:CodexDiagnostic}
type ReceiptPointer=Pick<CodexReceipt,'jobId'|'lease'|'deviceId'|'callId'|'payloadHash'>;
const indexName='device-codex-pending',uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const key=(callId:string)=>hash('device-codex-receipt:'+callId);
/** Generic completion records carry delivery metadata; the answer stays in its private receipt. */
export function codexCompletionSummary(result:DeviceCodexResult):Pick<Completion,'state'|'result'>{
    return {state:'response'in result?'succeeded':'failed',result:{protocol:DEVICE_CODEX_PROTOCOL,callId:result.callId}};
}
async function pointers():Promise<ReceiptPointer[]>{
    const value=await readState<ReceiptPointer[]>(indexName)??[];
    if(!Array.isArray(value)||value.length>1024||new Set(value.map(item=>item.callId)).size!==value.length||value.some(item=>!item||!uuid.test(item.jobId)||!uuid.test(item.lease)||!uuid.test(item.deviceId)||!uuid.test(item.callId)||!/^[a-f0-9]{64}$/.test(item.payloadHash)))throw new Error('Повреждён список подтверждений Codex.');
    return value;
}
/** Prompts and account credentials never enter the receipt; completed answers stay in the private store. */
export async function readCodexReceipt(jobId:string,deviceId:string,payload:DeviceCodexPayload):Promise<CodexReceipt|undefined>{
    const receipt=await readPrivateConfiguration<CodexReceipt>(key(payload.callId));
    if(receipt&&(receipt.schemaVersion!==1||receipt.jobId!==jobId||receipt.deviceId!==deviceId||receipt.callId!==payload.callId||receipt.payloadHash!==hash(JSON.stringify(payload))
        ||!['started','completed'].includes(receipt.state)||(receipt.state==='completed')!==!!receipt.result))throw new Error('Квитанция Codex не соответствует заданию.');
    if(receipt?.result)normalizeDeviceCodexResult(receipt.result);
    return receipt;
}
/** The directory fsync makes the no-retry marker durable before the external send is admitted. */
export async function writeCodexReceipt(receipt:CodexReceipt,expected:CodexReceipt|undefined):Promise<void>{
    if(receipt.result)normalizeDeviceCodexResult(receipt.result);
    const pending=await pointers(),previous=pending.find(item=>item.callId===receipt.callId);
    if(previous&&(previous.jobId!==receipt.jobId||previous.deviceId!==receipt.deviceId||previous.payloadHash!==receipt.payloadHash))throw new Error('Подтверждение Codex уже принадлежит другому заданию.');
    if(!previous){
        if(pending.length>=1024)throw new Error('Сначала доставьте сохранённые результаты Codex.');
        const {jobId,lease,deviceId,callId,payloadHash}=receipt;
        await writeState(indexName,[...pending,{jobId,lease,deviceId,callId,payloadHash}]);
    }
    const stored={...receipt},diagnostic=sanitizeCodexDiagnostic(receipt.diagnostic);
    if(diagnostic)stored.diagnostic=diagnostic;else delete stored.diagnostic;
    await writePrivateConfiguration(key(receipt.callId),stored,expected);
    await syncDirectory(path.join(stateDir(),'local-configuration'));
}
/** A crash between private completion and generic ACK creation restores delivery without recovering a prompt. */
export async function recoverCodexCompletions(save:(completion:Completion)=>Promise<void>):Promise<void>{
    for(const pointer of await pointers()){
        let receipt=await readPrivateConfiguration<CodexReceipt>(key(pointer.callId));
        if(receipt&&(receipt.jobId!==pointer.jobId||receipt.deviceId!==pointer.deviceId||receipt.callId!==pointer.callId||receipt.payloadHash!==pointer.payloadHash))throw new Error('Квитанция Codex изменилась.');
        if(receipt?.state!=='completed'){
            const diagnostic=sanitizeCodexDiagnostic(receipt?.diagnostic);
            const completed:CodexReceipt={schemaVersion:1,...pointer,state:'completed',result:{protocol:DEVICE_CODEX_PROTOCOL,callId:pointer.callId,error:{code:receipt?'unknown-after-send':'unavailable'}},...(diagnostic?{diagnostic}:{})};
            await writeCodexReceipt(completed,receipt);receipt=completed;
        }
        const result=normalizeDeviceCodexResult(receipt.result);
        await save({id:pointer.jobId,lease:pointer.lease,deviceId:pointer.deviceId,...codexCompletionSummary(result),message:'Сохранённый результат Codex готов к доставке.'});
    }
}
export async function acknowledgeCodexReceipt(jobId:string,callId:string):Promise<void>{
    const pending=await pointers();
    if(pending.some(item=>item.callId===callId&&item.jobId!==jobId))throw new Error('Подтверждение Codex принадлежит другому заданию.');
    await writeState(indexName,pending.filter(item=>item.callId!==callId));
}
export async function codexDeliveryResult(jobId:string,deviceId:string|undefined,callId:string):Promise<DeviceCodexResult>{
    const receipt=await readPrivateConfiguration<CodexReceipt>(key(callId));
    if(!receipt||receipt.schemaVersion!==1||receipt.jobId!==jobId||receipt.deviceId!==deviceId||receipt.callId!==callId||receipt.state!=='completed'||!receipt.result)throw new Error('Сохранённый результат Codex недоступен.');
    return normalizeDeviceCodexResult(receipt.result);
}
