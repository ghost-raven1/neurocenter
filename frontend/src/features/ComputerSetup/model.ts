import {OPENCODE_CLI_INSPECT_JOB,normalizeOpenCodeCliResult} from '@neurocenter/computer-setup';
import type {OpenCodeCliRequest,OpenCodeCliResult} from '../../../../services/shared/computer-setup.cjs';

export interface CliIntent {version:1;email:string;role:string;request:OpenCodeCliRequest;jobId?:string}
export interface CliJob {
    id:string;deviceId:string;kind:typeof OPENCODE_CLI_INSPECT_JOB;projectId:null;
    state:'queued'|'running'|'reconciling'|'succeeded'|'failed'|'cancelled';
    createdAt:string;updatedAt:string;observation?:OpenCodeCliResult;
}
export interface CliObservationState {
    intent?:CliIntent;job?:CliJob;busy:boolean;reading:boolean;canReplay:boolean;
    error:string;storageError:string;denied:boolean;
}
export const initialCliObservation=():CliObservationState=>({busy:false,reading:false,canReplay:false,error:'',storageError:'',denied:false});
export const cliTerminal=(job:CliJob|undefined):boolean=>!!job&&['succeeded','failed','cancelled'].includes(job.state);
export const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export const cliUuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const date=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));

/** Queue success is an observation, not evidence that CLI installation or a model request succeeded. */
export function readCliJob(value:unknown,deviceId:string,jobId?:string):CliJob{
    if(!cliUuid(deviceId)||!record(value)||!cliUuid(value.id)||value.deviceId!==deviceId||value.kind!==OPENCODE_CLI_INSPECT_JOB||value.projectId!==null
        ||jobId!==undefined&&value.id!==jobId||typeof value.state!=='string'||!['queued','running','reconciling','succeeded','failed','cancelled'].includes(value.state)
        ||!date(value.createdAt)||!date(value.updatedAt))throw Error('Квитанция относится к другому компьютеру или заданию. Проверьте исходную отправку.');
    let observation:OpenCodeCliResult|undefined;
    if(value.state==='succeeded'||value.state==='failed'){
        const genericFailure=value.state==='failed'&&(value.result===undefined||value.result===null||record(value.result)&&Object.keys(value.result).length===0);
        if(!genericFailure){
            observation=normalizeOpenCodeCliResult(value.result,{deviceId,jobId:value.id});
            if((value.state==='succeeded')!==['installed','missing'].includes(observation.status))throw Error('Состояние задания не подтверждает результат проверки OpenCode.');
        }
    }
    return {id:value.id,deviceId,projectId:null,kind:OPENCODE_CLI_INSPECT_JOB,state:value.state as CliJob['state'],createdAt:value.createdAt,updatedAt:value.updatedAt,...(observation?{observation}:{})};
}

/** An older list snapshot cannot undo an accepted terminal receipt. */
export function newerCliJob(previous:CliJob|undefined,next:CliJob):CliJob{
    return previous?.id===next.id&&(Date.parse(previous.updatedAt)>Date.parse(next.updatedAt)||cliTerminal(previous)&&!cliTerminal(next))?previous:next;
}
