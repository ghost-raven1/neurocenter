import os from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {api,hub,readState,type Credentials} from '../../bridge/state.js';
import {saveCompletion} from '../../bridge/completions.js';
import {openVerificationPage} from '../../bridge/open-browser.js';
import {assertOpenCodeAuthOwner,stopOpenCodeAuthOwnerChecks} from '../computer-setup/auth-owner.js';
import {recoverComputerSetupJobs} from '../computer-setup/executor.js';
import {CliCleanupError} from '../computer-setup/receipts.js';
import {RoleMcpCleanupError} from '../system-role-mcp/owned-process.js';
import {contract,type GlobalProvidersIssue} from './contract.js';
import {GlobalProviderEditor} from './editor.js';
import {startGlobalProvidersSession,closeGlobalProvidersSessions,closeGlobalProvidersSession} from './server.js';
import {beginGlobalReceipt,readGlobalReceipt,completeGlobalReceipt,queueGlobalReceipt,globalReceipts,globalReceiptRecoverable,type GlobalJob,type GlobalReceipt} from './receipts.js';
const active=new Map<string,Promise<void>>();let stopping=false;
const message='Локальное состояние OpenCode сохранено в квитанции. Окно настройки и ответ модели проверяются отдельно.';
function failed(receipt:GlobalReceipt,issue:GlobalProvidersIssue='unknown'){return{id:receipt.job.id,lease:receipt.job.lease,deviceId:receipt.job.deviceId,state:'failed' as const,message:'Исход локального действия не подтверждён. Проверьте сохранённое состояние перед новым действием.',result:{...contract.normalizeGlobalProvidersResult({schemaVersion:1,scope:'global',deviceId:receipt.job.deviceId,jobId:receipt.job.id,kind:receipt.job.kind,checkedAt:new Date().toISOString(),status:'failed',issue})}};}
export async function recoverGlobalProvidersJobs(){
    if(active.size)throw Error('Локальная проверка ещё выполняется.');
    await recoverComputerSetupJobs();
    for await(let receipt of globalReceipts()){
        if(receipt.phase==='started'){if(!await globalReceiptRecoverable(receipt))throw Error('Локальное действие ещё принадлежит работающему мосту.');if(receipt.job.kind===contract.OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB)await closeGlobalProvidersSession(receipt.job.id);receipt=await completeGlobalReceipt(receipt,failed(receipt));}
        await queueGlobalReceipt(receipt,saveCompletion);
    }
}
export async function stopGlobalProvidersJobs(){stopping=true;await closeGlobalProvidersSessions();await stopOpenCodeAuthOwnerChecks();await Promise.allSettled([...active.values()]);}
/** Fixed global actions use only the bounded version probe and keep local URLs/credentials out of the outbox. */
export async function runGlobalProvidersJob(job:GlobalJob,deviceId:string,authorize:(signal?:AbortSignal)=>Promise<unknown>){
    if(stopping||active.size||job.project_id!=null)throw Error('Локальная настройка занята или недоступна.');
    const payload=contract.normalizeGlobalProvidersPayload(job.payload,job.kind);if(payload.deviceId!==deviceId||![contract.OPENCODE_GLOBAL_PROVIDERS_READ_JOB,contract.OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB].includes(job.kind as typeof contract.OPENCODE_GLOBAL_PROVIDERS_READ_JOB))throw Error('Другой компьютер или вид задания.');
    const run=(async()=>{
        const identity={id:job.id,lease:job.lease,kind:job.kind,project_id:null,payload,deviceId},previous=await readGlobalReceipt(job.id);
        if(previous){if(!isDeepStrictEqual(previous.job,identity)||previous.phase!=='closed')throw Error('Сначала восстановите сохранённое локальное действие.');await queueGlobalReceipt(previous,saveCompletion);return;}
        let receipt=await beginGlobalReceipt(identity);const site=hub(),credentials=await readState<Credentials>('credentials'),limits=contract.globalProvidersLimits(process.env);
        const current=async()=>{if(stopping||hub()!==site||!credentials||credentials.deviceId!==deviceId||!isDeepStrictEqual(await readState<Credentials>('credentials'),credentials))throw Error('Авторизация компьютера изменилась.');};
        try{
            await authorize();await current();const checkedAt=new Date().toISOString();let result;
            if(job.kind===contract.OPENCODE_GLOBAL_PROVIDERS_READ_JOB){const editor=new GlobalProviderEditor({home:os.homedir(),environment:{...process.env},limits,authorize:async()=>{await authorize();await current();}}),inventory=await editor.inventory();result={schemaVersion:1,scope:'global',deviceId,jobId:job.id,kind:job.kind,checkedAt,status:inventory.issues.length?'partial':'checked',inventory};}
            else{
                const permit=async(signal?:AbortSignal)=>{await current();const response=await api<{ok:boolean;expiresAt:string}>('opencode-global-providers/authorize',{jobId:job.id},undefined,signal);if(!response?.ok||response.expiresAt!==payload.expiresAt)throw Error('Разрешение локальной формы изменилось.');await current();};
                const cli=await assertOpenCodeAuthOwner(deviceId,authorize);await cli.assertCurrent();
                await startGlobalProvidersSession({id:job.id,home:os.homedir(),environment:{...process.env},expiresAt:payload.expiresAt!,limits,authorize:permit,assertCurrent:current,assertCompatibleCli:signal=>assertOpenCodeAuthOwner(deviceId,permit,signal),open:openVerificationPage});
                result={schemaVersion:1,scope:'global',deviceId,jobId:job.id,kind:job.kind,checkedAt,status:'opened',expiresAt:payload.expiresAt};
            }
            const normalized=contract.normalizeGlobalProvidersResult(result,{deviceId,jobId:job.id,kind:job.kind,expiresAt:payload.expiresAt});receipt=await completeGlobalReceipt(receipt,{id:job.id,lease:job.lease,deviceId,state:'succeeded',message,result:{...normalized}});
        }catch(error){if(error instanceof CliCleanupError||error instanceof RoleMcpCleanupError)throw error;receipt=await completeGlobalReceipt(receipt,failed(receipt,(error as {code?:string})?.code==='OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED'?'unsupported-version':'unknown'));}
        await queueGlobalReceipt(receipt,saveCompletion);
    })();active.set(job.id,run);try{await run;}finally{active.delete(job.id);}
}
