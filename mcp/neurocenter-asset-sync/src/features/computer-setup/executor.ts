import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {saveCompletion} from '../../bridge/completions.js';
import {roleMcpLifecycleSupported} from '../system-role-mcp/owned-process.js';
import {normalizeOpenCodeCliPayload,OPENCODE_CLI_INSPECT_JOB} from './contract.js';
import {userOpenCodeDirectories} from './executable.js';
import {observeOpenCodeCli} from './process.js';
import {beginCliReceipt,readCliReceipt,settleCliReceipt,cliProcessJournal,closeCliReceipt,completeCliReceipt,queueCliCompletion,recoverComputerSetupCompletions,CliCleanupError,cliFailureMessage,type CliReceipt} from './receipts.js';

interface CliJob {id:string;lease:string;kind:string;project_id?:string|null;payload:unknown;}
const active=new Map<AbortController,{finished:Promise<void>;settled:boolean;closed:()=>CliReceipt|undefined}>();let stopping=false;

/** The worker waits for owned processes and the private completion write before its stop can finish. */
export async function stopComputerSetupJobs():Promise<void>{
    stopping=true;
    for(const controller of active.keys())controller.abort(new Error('Мост останавливается.'));
    await Promise.all([...active.values()].map(item=>item.finished));
}

/** The queue and installer share this cleanup fence; a live execution is never adopted by recovery. */
export async function recoverComputerSetupJobs():Promise<void>{
    if(!roleMcpLifecycleSupported())return;
    if([...active.values()].some(item=>!item.settled))throw new CliCleanupError(new Error('Проверка OpenCode ещё выполняется.'));
    const expected=[...active.values()].flatMap(item=>{const receipt=item.closed();return receipt?[receipt]:[];});
    await recoverComputerSetupCompletions(saveCompletion,expected);
    for(const [controller,item]of active)if(item.settled)active.delete(controller);
}

/** Device-global observation never borrows a project folder, SDK probe or browser-supplied executable. */
export async function runComputerSetupJob(job:CliJob,deviceId:string,authorize:(signal?:AbortSignal)=>Promise<unknown>):Promise<void>{
    if(stopping||active.size||!roleMcpLifecycleSupported()||job.kind!==OPENCODE_CLI_INSPECT_JOB||job.project_id!=null)throw new Error('Проверка OpenCode недоступна.');
    const payload=normalizeOpenCodeCliPayload(job.payload);
    if(payload.deviceId!==deviceId)throw new Error('Проверка OpenCode относится к другому компьютеру.');
    const controller=new AbortController();
    let closed:CliReceipt|undefined;
    const timer=setTimeout(()=>controller.abort(Object.assign(new Error('Проверка OpenCode превысила срок.'),{name:'TimeoutError'})),10000);
    const run=(async()=>{
        const identity={id:job.id,lease:job.lease,deviceId},previous=await readCliReceipt(job.id);
        if(previous){
            if(JSON.stringify(previous.job)!==JSON.stringify(identity))throw new CliCleanupError(new Error('Задание проверки OpenCode изменило владельца.'));
            if(previous.phase==='closed')return;
            throw new CliCleanupError(new Error('Сначала восстановите прерванную проверку OpenCode.'));
        }
        let receipt:CliReceipt=await beginCliReceipt(identity);
        let completion:{state:'succeeded'|'failed';message:string;result:Record<string,unknown>};
        try{
            const home=os.homedir(),environment={...process.env};
            const result=await observeOpenCodeCli({deviceId,jobId:job.id,home,environment,
                directories:userOpenCodeDirectories(home,environment.PATH??''),
                bridgeRoots:[fileURLToPath(new URL('../../../',import.meta.url))],
                journal:()=>cliProcessJournal(receipt,next=>{receipt=next;})},
            async signal=>{await authorize(signal);},controller.signal);
            completion={state:result.status==='installed'||result.status==='missing'?'succeeded':'failed',result:{...result},
                message:result.status==='installed'?'Пользовательский OpenCode найден.':result.status==='missing'?'Пользовательский OpenCode не найден.'
                    :result.status==='timed-out'?'Проверка OpenCode превысила срок. Повторите проверку.':'Проверка OpenCode не завершена. Проверьте компьютер и повторите действие.'};
        }catch(error){
            if(error instanceof CliCleanupError)throw error;
            completion={state:'failed',result:{},message:cliFailureMessage};
        }
        receipt=await settleCliReceipt(receipt);await closeCliReceipt(receipt);
        receipt=await completeCliReceipt(receipt,{...identity,...completion});
        closed=structuredClone(receipt);
        await queueCliCompletion(receipt,saveCompletion);
    })();
    const entry={finished:run,settled:false,closed:()=>closed};active.set(controller,entry);
    let completed=false;
    try{await run;completed=true;}finally{entry.settled=true;clearTimeout(timer);if(completed)active.delete(controller);}
}
