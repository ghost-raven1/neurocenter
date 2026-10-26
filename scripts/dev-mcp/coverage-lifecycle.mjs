import {packages,DiagnosticError} from './constants.mjs';
import {coverageLifecycleFailureCodes} from '../workspace/run-lifecycle.mjs';

const states=['preparing','running','finalizing','passed','failed','cancelled'];
const terminal=new Set(['passed','failed','cancelled']);
const ids=new Set([...packages.map(([id])=>'unit:'+id),'native','integration']);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const malformed=()=>new DiagnosticError('MALFORMED_REPORT','The coverage lifecycle is inconsistent; inspect or rerun the selected coverage profile.');
function timestamp(value){
    if(typeof value!=='string'||value.length>40||!Number.isFinite(Date.parse(value)))throw malformed();
    return new Date(value).toISOString();
}
function failure(value){
    if(value===null)return null;
    if(!object(value)||!coverageLifecycleFailureCodes.includes(value.code))throw malformed();
    return {code:value.code};
}
function processResult(value){
    if(!object(value)||typeof value.ok!=='boolean'||!count(value.durationMs)||typeof value.leaderReaped!=='boolean'
        ||!(value.exitCode===null||count(value.exitCode)&&value.exitCode<=255)
        ||!(value.signal===null||typeof value.signal==='string'&&/^SIG[A-Z0-9]{1,12}$/.test(value.signal))
        ||!object(value.cleanup)||typeof value.cleanup.noLiveDescendants!=='boolean')throw malformed();
    const zombies=value.cleanup.zombiePids??[],signals=value.cleanup.signals;
    if(!Array.isArray(zombies)||zombies.length>20000||zombies.some(pid=>!count(pid)||!pid)
        ||!Array.isArray(signals)||signals.length>2||signals.some((signal,index)=>signal!==['SIGTERM','SIGKILL'][index]))throw malformed();
    const cause=value.failure===undefined?null:failure(value.failure);
    if(value.ok&&(value.exitCode!==0||value.signal!==null||!value.leaderReaped||!value.cleanup.noLiveDescendants||cause))throw malformed();
    return {ok:value.ok,exitCode:value.exitCode,signal:value.signal,durationMs:value.durationMs,leaderReaped:value.leaderReaped,
        cleanup:{noLiveDescendants:value.cleanup.noLiveDescendants,zombieCount:zombies.length,signals:[...signals]},
        ...(cause?{failure:cause}:{})};
}

/** Validate new execution evidence before relaxing legacy coverage-summary requirements. */
export function coverageLifecycleSummary(manifest){
    if(!Object.hasOwn(manifest,'lifecycle'))return null;
    const raw=manifest.lifecycle;
    if(!object(raw)||raw.schemaVersion!==1||!states.includes(raw.state)||!Array.isArray(raw.plannedSteps)
        ||!raw.plannedSteps.length||raw.plannedSteps.length>10||new Set(raw.plannedSteps).size!==raw.plannedSteps.length
        ||raw.plannedSteps.some(id=>!ids.has(id))||!Array.isArray(raw.steps)||raw.steps.length>raw.plannedSteps.length
        ||typeof manifest.complete!=='boolean'||typeof manifest.suiteCompletion!=='boolean'
        ||manifest.complete!==manifest.suiteCompletion)throw malformed();
    const sourceKeys=['head','status','trackedDiffSha256','untrackedContentSha256'];
    const hasSource=Object.hasOwn(manifest,'sourceBefore')||Object.hasOwn(manifest,'sourceAfter');
    if(manifest.complete&&(manifest.sourceChangedDuringRun!==false||hasSource&&(!object(manifest.sourceBefore)||!object(manifest.sourceAfter)
        ||sourceKeys.some(key=>typeof manifest.sourceBefore[key]!=='string'||typeof manifest.sourceAfter[key]!=='string'
            ||manifest.sourceBefore[key]!==manifest.sourceAfter[key]))))throw malformed();
    const startedAt=timestamp(manifest.startedAt),finishedAt=manifest.finishedAt==null?null:timestamp(manifest.finishedAt);
    if(terminal.has(raw.state)!==!!finishedAt||finishedAt&&Date.parse(finishedAt)<Date.parse(startedAt))throw malformed();
    const primary=failure(raw.failure);
    let cancellation=null;
    if(raw.cancellation!==null){
        if(!object(raw.cancellation)||![null,'SIGINT','SIGTERM'].includes(raw.cancellation.signal))throw malformed();
        cancellation={signal:raw.cancellation.signal};
    }
    if(!Array.isArray(raw.finalizationErrors)||raw.finalizationErrors.length>16)throw malformed();
    const errors=raw.finalizationErrors.map(value=>{const cause=failure(value);if(!cause)throw malformed();return cause;});
    let previous=Date.parse(startedAt);
    const steps=raw.steps.map((step,index)=>{
        if(!object(step)||step.id!==raw.plannedSteps[index])throw malformed();
        const start=timestamp(step.startedAt),pending=step.result===null&&step.finishedAt===null;
        if(Date.parse(start)<previous)throw malformed();
        if(pending){
            if(terminal.has(raw.state)||index!==raw.steps.length-1)throw malformed();
            return {id:step.id,startedAt:start,finishedAt:null,result:null};
        }
        const end=timestamp(step.finishedAt);
        if(Date.parse(end)<Date.parse(start)||finishedAt&&Date.parse(end)>Date.parse(finishedAt))throw malformed();
        previous=Date.parse(end);
        return {id:step.id,startedAt:start,finishedAt:end,result:processResult(step.result)};
    });
    if(raw.state==='preparing'&&steps.length||raw.state==='passed'&&(primary||cancellation||errors.length
        ||steps.length!==raw.plannedSteps.length||steps.some(step=>!step.result?.ok))
        ||raw.state==='failed'&&!primary||raw.state==='cancelled'&&(!primary||!cancellation)
        ||manifest.complete&&raw.state!=='passed')throw malformed();
    const recorded=new Set(steps.filter(step=>step.result!==null).map(step=>step.id));
    if(!Array.isArray(manifest.packages)||new Set(manifest.packages.map(item=>item?.name)).size!==manifest.packages.length
        ||manifest.packages.some(item=>!recorded.has('unit:'+item?.name))
        ||manifest.native&&!recorded.has('native')||manifest.integration&&!recorded.has('integration'))throw malformed();
    if(manifest.complete&&raw.plannedSteps.some(id=>id.startsWith('unit:')
        ?!manifest.packages.some(item=>'unit:'+item.name===id):!manifest[id]))throw malformed();
    return {schemaVersion:1,state:raw.state,plannedSteps:[...raw.plannedSteps],steps,
        failure:primary,cancellation,finalizationErrors:errors};
}
