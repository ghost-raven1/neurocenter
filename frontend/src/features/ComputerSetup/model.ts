import {OPENCODE_CLI_INSPECT_JOB,normalizeOpenCodeCliResult} from '@neurocenter/computer-setup';
import type {OpenCodeCliRequest,OpenCodeCliResult} from '../../../../services/shared/computer-setup.cjs';
import {OPENCODE_CLI_INSTALL_JOB,normalizeOpenCodeInstallResult} from '@neurocenter/opencode-cli-install';
import type {OpenCodeInstallRequest,OpenCodeInstallResult} from '../../../../services/shared/opencode-cli-install.cjs';
export type ComputerCliKind=typeof OPENCODE_CLI_INSPECT_JOB|typeof OPENCODE_CLI_INSTALL_JOB;
export type ComputerCliRequest=OpenCodeCliRequest|OpenCodeInstallRequest;

export interface CliIntent {version:1;email:string;role:string;request:ComputerCliRequest;jobId?:string}
export interface CliJob {
    id:string;deviceId:string;kind:ComputerCliKind;projectId:null;
    state:'queued'|'running'|'reconciling'|'succeeded'|'failed'|'cancelled';
    createdAt:string;updatedAt:string;observation?:OpenCodeCliResult;
    installation?:OpenCodeInstallResult;
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
export function readCliJob(value:unknown,deviceId:string,jobId?:string,kind:ComputerCliKind=OPENCODE_CLI_INSPECT_JOB):CliJob{
    if(!cliUuid(deviceId)||!record(value)||!cliUuid(value.id)||value.deviceId!==deviceId||value.kind!==kind||value.projectId!==null
        ||jobId!==undefined&&value.id!==jobId||typeof value.state!=='string'||!['queued','running','reconciling','succeeded','failed','cancelled'].includes(value.state)
        ||!date(value.createdAt)||!date(value.updatedAt))throw Error('Квитанция относится к другому компьютеру или заданию. Проверьте исходную отправку.');
    let observation:OpenCodeCliResult|undefined,installation:OpenCodeInstallResult|undefined;
    if(value.state==='succeeded'||value.state==='failed'){
        const genericFailure=value.state==='failed'&&(value.result===undefined||value.result===null||record(value.result)&&Object.keys(value.result).length===0);
        if(!genericFailure){
            if(kind===OPENCODE_CLI_INSTALL_JOB){
                installation=normalizeOpenCodeInstallResult(value.result);
                if(installation.deviceId!==deviceId||installation.jobId!==value.id||(value.state==='succeeded')!==['installed','unchanged'].includes(installation.status))throw Error('Состояние задания не подтверждает установку OpenCode.');
                if(installation.installedVersion)observation=normalizeOpenCodeCliResult({schemaVersion:1,scope:'global',deviceId,jobId:value.id,checkedAt:installation.checkedAt,status:'installed',version:installation.installedVersion});
            }else{
                observation=normalizeOpenCodeCliResult(value.result,{deviceId,jobId:value.id});
                if((value.state==='succeeded')!==['installed','missing'].includes(observation.status))throw Error('Состояние задания не подтверждает результат проверки OpenCode.');
            }
        }
    }
    return {id:value.id,deviceId,projectId:null,kind,state:value.state as CliJob['state'],createdAt:value.createdAt,updatedAt:value.updatedAt,...(observation?{observation}:{}),...(installation?{installation}:{})};
}

/** An older list snapshot cannot undo an accepted terminal receipt. */
export function newerCliJob(previous:CliJob|undefined,next:CliJob):CliJob{
    return previous?.id===next.id&&(Date.parse(previous.updatedAt)>Date.parse(next.updatedAt)||cliTerminal(previous)&&!cliTerminal(next))?previous:next;
}
