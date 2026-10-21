import fs from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {safeTarget} from '../../bridge/workspace-paths.js';
import {readBoundedUtf8} from '../../bridge/read-bounded.js';
import {enqueueLearningObservation,type LearningQueueTarget} from './observation-queue.js';
import type {LearningObservedExperienceInput} from './contract.js';

export interface LearningCollectorConfiguration extends LearningQueueTarget {directory:string;server:string;queueDirectory:string}
const TOOL_NAMES=new Set(['read','edit','write','bash','glob','grep','list','task','todowrite','todoread','webfetch','websearch','lsp','skill','question','apply_patch']);
const SESSION_LIMIT=64,CALL_LIMIT=10000;
interface Session {startedAt:number;tools:Record<string,number>;calls:number;truncated:boolean;pending?:LearningObservedExperienceInput}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const sessionId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(value);

async function current(configuration:LearningCollectorConfiguration):Promise<boolean>{
    try{
        if(await fs.realpath(configuration.directory)!==configuration.directory)return false;
        const marker=JSON.parse(await readBoundedUtf8(await safeTarget(configuration.directory,'.opencode/neurocenter.json'),64*1024));
        return marker?.version===2&&marker.server===configuration.server&&marker.projectId===configuration.projectId&&marker.instanceId===configuration.instanceId;
    }catch{return false;}
}

/** Hooks capture only bounded allowlisted metadata; no args, output, prompt, diff or credentials are inspected. */
export async function createLearningCollector(input:{directory?:unknown},configuration:LearningCollectorConfiguration){
    const enabled=typeof input.directory==='string'&&await fs.realpath(input.directory).catch(()=>undefined)===configuration.directory&&await current(configuration);
    const sessions=new Map<string,Session>();
    const get=(id:string)=>{
        let value=sessions.get(id);if(!value){if(sessions.size>=SESSION_LIMIT)return;value={startedAt:Date.now(),tools:{},calls:0,truncated:false};sessions.set(id,value);}return value;
    };
    let chain=Promise.resolve();
    const finalize=async(id:string,event:'idle'|'error')=>{
        if(!enabled||!await current(configuration))return;
        const session=sessions.get(id)??(event==='error'?get(id):undefined);if(!session)return;
        if(!session.pending){
            const sessionHash=createHash('sha256').update(configuration.bindingId+'\0'+id).digest('hex');
            const facts={observerVersion:1,observedAt:new Date().toISOString(),sessionEvent:event,toolObservations:session.tools,calls:session.calls,truncated:session.truncated,elapsedMs:Math.min(86_400_000,Math.max(0,Date.now()-session.startedAt))};
            session.pending={requestKey:randomUUID(),title:'Наблюдение OpenCode',summary:'Служебные счётчики инструментов. Событие завершения ожидания не подтверждает успешность задачи.',
                outcome:'unknown',evidence:[{kind:'observation',status:'unknown',summary:JSON.stringify(facts),reference:'opencode-session-sha256:'+sessionHash}]};
        }
        // The snapshot and UUID survive a full queue: the next idle event retries the same observation.
        await enqueueLearningObservation({projectId:configuration.projectId,bindingId:configuration.bindingId,instanceId:configuration.instanceId},session.pending,configuration.queueDirectory);
        sessions.delete(id);
    };
    return {
        'tool.execute.after':async(input:{tool?:unknown;sessionID?:unknown})=>{
            if(!enabled||typeof input.tool!=='string'||!TOOL_NAMES.has(input.tool)||!sessionId(input.sessionID))return;
            const session=get(input.sessionID);if(!session||session.pending)return;
            if(session.calls>=CALL_LIMIT){session.truncated=true;return;}
            session.calls++;session.tools[input.tool]=(session.tools[input.tool]??0)+1;
        },
        event:async(input:{event?:unknown})=>{
            if(!enabled||!record(input.event)||!['session.idle','session.error'].includes(String(input.event.type))||!record(input.event.properties)||!sessionId(input.event.properties.sessionID))return;
            const id=input.event.properties.sessionID,event=input.event.type==='session.error'?'error':'idle';
            const next=chain.then(()=>finalize(id,event));chain=next.catch(()=>undefined);await chain;
        },
    };
}

export const LEARNING_COLLECTOR_FILE='.opencode/plugins/neurocenter-learning.js';

/** The wrapper pins this bridge's collector and target; the private queue path contains no authentication secret. */
export function renderLearningCollector(configuration:LearningCollectorConfiguration):string{
    const factory=import.meta.url;
    return `import {createLearningCollector} from ${JSON.stringify(factory)};\nexport default async input=>createLearningCollector(input,${JSON.stringify(configuration)});\n`;
}
