import {DiagnosticError,evidenceNote} from './constants.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const launch=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const requestId=value=>typeof value==='string'&&uuid.test(value);
const launchIdValue=value=>typeof value==='string'&&launch.test(value);
const events={
    'tool-build':['requested','accepted','replayed','started','cancel-requested','succeeded','failed','cancelled'],
    'saved-chat':['accepted','retried','started','cancel-requested','succeeded','failed','cancelled'],
};
const common=['schemaVersion','kind','timestamp','launchId','flow','event'];
const ids={'tool-build':['requestKey','buildId','operationId'],'saved-chat':['conversationId','turnId','requestId','attemptId']};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;

/** Select closed event records only; text labels cannot establish launch or request completeness. */
function eventRecord(value,selected){
    if(!object(value)||value.schemaVersion!==1||value.kind!=='neurocenter-dev-trace'||typeof value.flow!=='string'||!Object.hasOwn(events,value.flow)
        ||!events[value.flow].includes(value.event)||!timestamp(value.timestamp)||value.launchId!==selected.launchId
        ||Object.keys(value).some(key=>![...common,...ids[value.flow]].includes(key)))return null;
    if(value.flow==='tool-build'){
        if(!requestId(value.requestKey)||Object.hasOwn(value,'buildId')!==Object.hasOwn(value,'operationId'))return null;
        if(Object.hasOwn(value,'buildId')&&(!requestId(value.buildId)||value.operationId!=='tool-build-'+value.buildId))return null;
    }else if(ids['saved-chat'].some(key=>!requestId(value[key]))||value.attemptId!==value.requestId)return null;
    if(Date.parse(value.timestamp)<Date.parse(selected.startedAt))return null;
    return Object.fromEntries([...common,...ids[value.flow]].filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
}

/** Read one fixed Catalog generation; no arbitrary path, prompt, payload or error message is returned. */
export async function readRequestTrace(root,{flow,request,launchId,limit=50},{readLog,signal}={}){
    if(typeof flow!=='string'||!Object.hasOwn(events,flow)||!requestId(request)||launchId!==undefined&&!launchIdValue(launchId)
        ||!Number.isInteger(limit)||limit<1||limit>100)throw new DiagnosticError('INVALID_ARGUMENT','Choose a fixed trace flow, canonical request UUID and at most 100 events.');
    if(signal?.aborted)throw new DiagnosticError('CANCELLED','The trace observation was cancelled.');
    const log=await readLog(root,'catalog',{launchId,maxBytes:32768,signal});
    const selected=log.launch;
    if(signal?.aborted)throw new DiagnosticError('CANCELLED','The trace observation was cancelled.');
    let rejectedRecords=0;
    const matched=[];
    if(selected){
        let text=log.text;
        if(log.truncated){const first=text.indexOf('\n');text=first<0?'':text.slice(first+1);}
        for(const line of text.split('\n')){
            if(!line)continue;
            let raw;try{raw=JSON.parse(line);}catch{continue;}
            if(raw?.kind!=='neurocenter-dev-trace')continue;
            const row=eventRecord(raw,selected);
            if(!row){rejectedRecords++;continue;}
            if(row.flow===flow&&(flow==='tool-build'?row.requestKey:row.requestId)===request)matched.push(row);
        }
    }
    return {flow,request,observedAt:log.observedAt,launch:selected??null,currentProcessCorrelation:log.currentProcessCorrelation,
        state:!selected?'unavailable':matched.length?'observed':'not-found',events:matched.slice(-limit),rejectedRecords,
        truncated:log.truncated||matched.length>limit,
        scope:'Only closed structured events in the bounded selected Catalog launch log are observed. Missing events and other launches remain unverified; no complete request or successful outcome is established.',
        evidence:evidenceNote};
}
