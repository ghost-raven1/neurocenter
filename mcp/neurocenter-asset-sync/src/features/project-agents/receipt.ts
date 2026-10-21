import path from 'node:path';
import {hash} from '../../bridge/state.js';
import {journalDirectory,parseJournal} from '../../bridge/installation-journal.js';
import {readBoundedUtf8} from '../../bridge/read-bounded.js';
import {JOURNAL_BYTES_LIMIT,LOCK_BYTES_LIMIT} from '../../bridge/installation-limits.js';
import type {ProjectAgentsPayload,ProjectAgentReceipt} from './contract.js';
import {LEARNING_COLLECTOR_FILE} from '../project-learning/collector-plugin.js';

export const AGENTS_RECEIPT='.opencode/neurocenter/agents.json';
export const agentFile=(slug:string):string=>'.opencode/agents/'+slug+'.md';
export const agentsJournalKey=(projectId:string):string=>hash('project-agents:'+projectId).slice(0,24);
export type AgentsReceipt=Omit<ProjectAgentsPayload,'agents'>&{agents:ProjectAgentReceipt[];collector?:{path:string;sha256:string}};
const damaged=()=>new Error('Квитанция агентов не подтверждена приватным журналом моста. Сохраните локальные файлы перед повторной настройкой.');
const exact=(value:unknown,keys:string[],optional:string[]=[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
    &&keys.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>keys.includes(key)||optional.includes(key));

export function parseAgentsReceipt(raw:string):AgentsReceipt{
    let value:unknown;try{value=JSON.parse(raw);}catch{throw damaged();}
    const keys=['schemaVersion','projectId','bindingId','instanceId','revision','manifestSha256','agents'];
    if(!exact(value,keys,['collector'])||value.schemaVersion!==1||typeof value.projectId!=='string'||!value.projectId||value.projectId.length>200
        ||typeof value.bindingId!=='string'||!/^[a-f0-9]{64}$/.test(value.bindingId)||typeof value.instanceId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.instanceId)
        ||!Number.isSafeInteger(value.revision)||Number(value.revision)<1||typeof value.manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(value.manifestSha256)
        ||!Array.isArray(value.agents)||value.agents.length>32)throw damaged();
    for(const item of value.agents){
        if(!exact(item,['id','slug','version','enabled','sha256'])||typeof item.id!=='string'||!item.id||item.id.length>200
            ||typeof item.slug!=='string'||item.slug.length>64||!/^nc-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug)
            ||!Number.isSafeInteger(item.version)||Number(item.version)<1||typeof item.enabled!=='boolean'||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))throw damaged();
    }
    if(new Set(value.agents.map(item=>item.id)).size!==value.agents.length||new Set(value.agents.map(item=>item.slug)).size!==value.agents.length)throw damaged();
    if(value.collector!==undefined&&(!exact(value.collector,['path','sha256'])||value.collector.path!==LEARNING_COLLECTOR_FILE||typeof value.collector.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.collector.sha256)))throw damaged();
    return value as unknown as AgentsReceipt;
}

async function optionalRead(file:string,maximum:number):Promise<string|null>{
    try{return await readBoundedUtf8(file,maximum);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}

/** Only a bridge-private committed transaction may establish ownership of project agent files. */
export async function agentsPrivateProof(root:string,projectId:string):Promise<{receipt:AgentsReceipt;raw:string;recoveryPath:string}|null>{
    const directory=journalDirectory(root),key=agentsJournalKey(projectId);
    const pointerRaw=await optionalRead(path.join(directory,'assets',key+'.json'),LOCK_BYTES_LIMIT);
    if(pointerRaw===null)return null;
    let pointer:unknown;try{pointer=JSON.parse(pointerRaw);}catch{throw damaged();}
    if(!exact(pointer,['action','manifest','recoveryPath'])||pointer.action!=='install'||typeof pointer.manifest!=='string'||!/^[a-f0-9]{64}$/.test(pointer.manifest)
        ||typeof pointer.recoveryPath!=='string'||path.dirname(pointer.recoveryPath)!==path.join(directory,'history')||!/^[-a-f0-9]{36}\.json$/.test(path.basename(pointer.recoveryPath)))throw damaged();
    const raw=await optionalRead(pointer.recoveryPath,JOURNAL_BYTES_LIMIT);if(raw===null)throw damaged();
    const journal=parseJournal(raw,root);
    if(journal.state!=='committed'||journal.action!=='install'||journal.assetKey!==key||journal.manifest!==pointer.manifest||journal.result?.projectId!==projectId)throw damaged();
    const stored=journal.changes.find(change=>change.relative===AGENTS_RECEIPT);
    if(!stored?.after||stored.encoding)throw damaged();
    const receipt=parseAgentsReceipt(stored.after);
    if(receipt.projectId!==projectId||receipt.manifestSha256!==journal.manifest)throw damaged();
    return {receipt,raw:stored.after,recoveryPath:pointer.recoveryPath};
}
