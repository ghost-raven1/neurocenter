import {createHash} from 'node:crypto';
import {DiagnosticError,evidenceNote,packages} from './constants.mjs';
import {readOwnedFile} from './safe-file.mjs';

const limit=1024**2,maxSteps=64;
const ids=new Set(packages.map(([id])=>id)),folders=new Map(packages.map(([id,folder])=>[folder,id]));
const specialSteps=new Set(['Agent kit: актуальность генерации','Общие контракты, production и упаковка','Compose: dev','Compose: локальные эмбеддинги']);
const stepTypes=new Set(['typecheck','build','test']);
const signals=new Set(['SIGABRT','SIGALRM','SIGBUS','SIGCHLD','SIGCONT','SIGFPE','SIGHUP','SIGILL','SIGINT','SIGIO','SIGIOT','SIGKILL',
    'SIGPIPE','SIGPOLL','SIGPROF','SIGPWR','SIGQUIT','SIGSEGV','SIGSTKFLT','SIGSTOP','SIGSYS','SIGTERM','SIGTRAP','SIGTSTP','SIGTTIN',
    'SIGTTOU','SIGUNUSED','SIGURG','SIGUSR1','SIGUSR2','SIGVTALRM','SIGWINCH','SIGXCPU','SIGXFSZ','SIGBREAK','SIGLOST','SIGINFO']);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const head=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const malformed=()=>new DiagnosticError('MALFORMED_REPORT','The selected run report has missing or inconsistent fields; inspect the retained run locally.');
const own=(value,key)=>Object.hasOwn(value,key);

function timestamp(value){
    if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))throw malformed();
    const canonical=new Date(value).toISOString();if(canonical.slice(0,19)!==value.slice(0,19))throw malformed();return canonical;
}
function timing(value){
    const startedAt=timestamp(value.startedAt),finishedAt=own(value,'finishedAt')?timestamp(value.finishedAt):null;
    if(finishedAt&&Date.parse(finishedAt)<Date.parse(startedAt))throw malformed();
    return {startedAt,finishedAt};
}
function uniqueStrings(value,allowed,{empty=true,max=maxSteps}={}){
    if(!Array.isArray(value)||value.length>max||!empty&&!value.length||new Set(value).size!==value.length||value.some(item=>!allowed.has(item)))throw malformed();
    return [...value];
}
function stepIdentity(name){
    if(specialSteps.has(name))return {name,package:null,step:null};
    if(typeof name!=='string')throw malformed();
    const match=/^([^:]+): (typecheck|build|test)$/.exec(name);
    if(!match||!folders.has(match[1]))throw malformed();
    return {name:match[0],package:folders.get(match[1]),step:match[2]};
}
function processResult(value){
    if(!object(value)||typeof value.ok!=='boolean'||!count(value.durationMs)
        ||!(value.exitCode===null||count(value.exitCode)&&value.exitCode<=255)
        ||!(value.signal===null||signals.has(value.signal)))throw malformed();
    if(value.ok&&(value.exitCode!==0||value.signal!==null||own(value,'errorCode')||own(value,'reportError')||value.failure))throw malformed();
    return {ok:value.ok,exitCode:value.exitCode,signal:value.signal,durationMs:value.durationMs};
}
function testCounters(value){
    if(!object(value)||['passed','failed','skipped','todo'].some(key=>!count(value[key])))throw malformed();
    if(own(value,'cancelled')&&!count(value.cancelled))throw malformed();
    return {...Object.fromEntries(['passed','failed','skipped','todo'].map(key=>[key,value[key]])),...(own(value,'cancelled')?{cancelled:value.cancelled}:{})};
}
const nodeGate=name=>name==='Общие контракты, production и упаковка';
const testGate=step=>step.step==='test'||nodeGate(step.name);
function observation(git){
    return {available:git?.available===true,head:git?.available===true&&head(git.head)?git.head:null,
        workingTree:git?.available===true&&typeof git.dirty?.clean==='boolean'?(git.dirty.clean?'clean':'dirty'):'unknown'};
}
function sourceSummary(input,git){
    const current=observation(git),recordedHead=input?.head??null;
    return {status:recordedHead&&current.head&&recordedHead!==current.head?'head-mismatch':current.workingTree==='dirty'?'dirty-source-not-verified':'not-fully-verified',
        recordedHead,currentHead:current.head,currentWorkingTree:current.workingTree,currentSourceEquivalent:'unknown',
        ...(input?{snapshotSha256:input.sha256}:{}),
        note:'HEAD and Git cleanliness do not compare current source bytes with the retained snapshot. No current source equivalence is established.'};
}
const checkFailures=new Set(['CANCELLED','SOURCE_CHANGED','CHECK_TIMEOUT','CHECK_FAILED','CHECK_LOG_LIMIT','SPAWN_FAILED','PROCESS_CLEANUP_FAILED',
    'PROCESS_INSPECTION_FAILED','SURVIVING_DESCENDANTS','TEST_REPORT_FAILED','CHECK_EXECUTION_FAILED','PLAN_SOURCE_CHANGED']);
const sourceReasons=new Set(['SOURCE_DISABLED','NOT_GIT_REPOSITORY','SOURCE_UNAVAILABLE','INPUT_LIMIT','UNSAFE_SOURCE','SOURCE_CHANGED','CANCELLED','CAPTURE_PENDING']);
function checkSourceSummary(source,currentGit,terminal){
    if(!object(source)||!['capturing','unchanged','changed','unknown'].includes(source.status))throw malformed();
    const before=buildInputs(source.before),after=buildInputs(source.after);
    if(['unchanged','changed'].includes(source.status)&&(!before||!after||own(source,'reason'))
        ||source.status==='unchanged'&&JSON.stringify(before)!==JSON.stringify(after)
        ||source.status==='capturing'&&(terminal||before||after||own(source,'reason'))
        ||source.status==='unknown'&&(!sourceReasons.has(source.reason)||before&&after||terminal&&source.reason==='CAPTURE_PENDING'))throw malformed();
    return {status:source.status,before,after,...(source.status==='unknown'?{reason:source.reason}:{}),...observation(currentGit),currentSourceEquivalent:'unknown',
        note:'Source bytes were compared only at the recorded run boundaries. This diagnostic does not rehash current source or establish current equivalence.'};
}
function cleanupResult(raw){
    if(typeof raw.leaderReaped!=='boolean'||!object(raw.cleanup)||typeof raw.cleanup.noLiveDescendants!=='boolean'
        ||!count(raw.cleanup.zombieCount)||raw.cleanup.zombieCount>20000||!Array.isArray(raw.cleanup.signals)||raw.cleanup.signals.length>2
        ||raw.cleanup.signals.some((signal,index)=>signal!==['SIGTERM','SIGKILL'][index]))throw malformed();
    if(raw.ok&&(!raw.leaderReaped||!raw.cleanup.noLiveDescendants))throw malformed();
    if(raw.failure!==undefined&&(!object(raw.failure)||!checkFailures.has(raw.failure.code)))throw malformed();
    return {leaderReaped:raw.leaderReaped,cleanup:{noLiveDescendants:raw.cleanup.noLiveDescendants,zombieCount:raw.cleanup.zombieCount,signals:[...raw.cleanup.signals]},
        ...(raw.failure?{failure:{code:raw.failure.code}}:{})};
}
function checkSummary(value,currentGit){
    if(!object(value)||typeof value.success!=='boolean'||!Array.isArray(value.steps)||value.steps.length>maxSteps)throw malformed();
    const selectionKnown=own(value,'selection');
    if(!selectionKnown&&value.schemaVersion!==undefined||selectionKnown&&!object(value.selection))throw malformed();
    const requested=selectionKnown?{packages:uniqueStrings(value.selection.packages,ids,{max:8}),steps:uniqueStrings(value.selection.steps,stepTypes,{max:3})}:null;
    const times=timing(value),seen=new Set();
    const validateIdentity=name=>{
        const item=stepIdentity(name);
        if((requested?.packages.length&&(!item.package||!requested.packages.includes(item.package)))
            ||(requested?.steps.length&&(!item.step||!requested.steps.includes(item.step))))throw malformed();
        return item;
    };
    const steps=value.steps.map(raw=>{
        if(!object(raw))throw malformed();const identity=validateIdentity(raw.name);
        if(seen.has(identity.name))throw malformed();seen.add(identity.name);
        const item={...identity,...processResult(raw),...(value.schemaVersion===3?cleanupResult(raw):{})};
        if(own(raw,'testRunner')){
            if(!['node','vitest'].includes(raw.testRunner)||!testGate(item))throw malformed();item.testRunner=raw.testRunner;
        }
        if(own(raw,'tests')){
            item.tests=testCounters(raw.tests);
            if(item.ok&&(item.tests.failed||item.tests.cancelled)||item.testRunner==='node'&&!own(item.tests,'cancelled'))throw malformed();
        }else if(item.testRunner&&item.ok)throw malformed();
        return item;
    });
    const failed=steps.some(step=>!step.ok),cancelled=steps.some(step=>!step.ok&&['SIGINT','SIGTERM'].includes(step.signal));
    const skipped=steps.some(step=>step.tests&&(step.tests.skipped||step.tests.todo));
    const unknownTests=steps.some(step=>testGate(step)&&(!step.tests||nodeGate(step.name)&&!own(step.tests,'cancelled')));
    let status=cancelled?'cancelled':failed?'failed':times.finishedAt?'incomplete':'in-progress',complete=false,plannedSteps=null;
    if(value.schemaVersion!==undefined&&![2,3].includes(value.schemaVersion))throw malformed();
    if([2,3].includes(value.schemaVersion)){
        if(!Array.isArray(value.plannedSteps)||!value.plannedSteps.length||value.plannedSteps.length>maxSteps
            ||new Set(value.plannedSteps).size!==value.plannedSteps.length||!(value.schemaVersion===3?['running','passed','failed','cancelled']:['running','passed','failed']).includes(value.state))throw malformed();
        plannedSteps=value.plannedSteps.map(name=>validateIdentity(name).name);
        if(steps.length>plannedSteps.length||steps.some((step,index)=>step.name!==plannedSteps[index])
            ||value.state==='running'&&(times.finishedAt||value.success)
            ||value.state!=='running'&&!times.finishedAt
            ||value.state==='passed'&&(!value.success||failed||steps.length!==plannedSteps.length)
            ||value.state==='failed'&&(value.success||value.schemaVersion===2&&!failed))throw malformed();
        if(value.updatedAt!==undefined){const updatedAt=timestamp(value.updatedAt);if(Date.parse(updatedAt)<Date.parse(times.startedAt)||times.finishedAt&&Date.parse(updatedAt)>Date.parse(times.finishedAt))throw malformed();}
        if(value.state==='running')status=cancelled?'cancelled':failed?'failed':'in-progress';
        if(value.state==='passed'&&!skipped&&!unknownTests){status='requested-steps-complete';complete=true;}
    }
    let source={status:'unknown',...observation(currentGit),currentSourceEquivalent:'unknown'},failure,cancellation;
    if(value.schemaVersion===3){
        source=checkSourceSummary(value.source,currentGit,!!times.finishedAt);
        if(value.failure!==null&&(!object(value.failure)||!checkFailures.has(value.failure.code))
            ||value.cancellation!==null&&(!object(value.cancellation)||![null,'SIGINT','SIGTERM'].includes(value.cancellation.signal))
            ||value.state==='passed'&&(value.failure!==null||value.cancellation!==null||source.status==='changed'||source.reason==='SOURCE_CHANGED')
            ||value.state==='failed'&&value.failure===null
            ||value.state==='cancelled'&&(value.success||value.failure?.code!=='CANCELLED'||value.cancellation===null)
            ||value.state!=='cancelled'&&value.cancellation!==null)throw malformed();
        failure=value.failure?{code:value.failure.code}:null;cancellation=value.cancellation?{signal:value.cancellation.signal}:null;
        if(value.state==='cancelled')status='cancelled';
        else if(value.state==='failed')status='failed';
        else if(value.state==='passed'&&source.status!=='unchanged'){status='incomplete';complete=false;}
    }
    if(value.success&&(failed||!times.finishedAt||!steps.length))throw malformed();
    const totals={passed:0,failed:0,skipped:0,todo:0,cancelled:0};let countedSteps=0;
    for(const step of steps)if(step.tests){countedSteps++;for(const key of Object.keys(totals)){
        if(key==='cancelled'&&!own(step.tests,key)){totals[key]=null;continue;}
        if(totals[key]!==null){totals[key]+=step.tests[key];if(!count(totals[key]))throw malformed();}
    }}
    if(steps.some(step=>testGate(step)&&!step.tests))for(const key of Object.keys(totals))totals[key]=null;
    return {kind:'check',...times,status,complete,reportedSuccess:value.success,observedStepsPassed:steps.length>0&&!failed,requested,requestedScope:selectionKnown?'recorded-selectors':'unknown',
        plannedSteps,recordedStepCount:steps.length,plannedStepCount:plannedSteps?.length??null,steps,
        testCounters:{...totals,countedSteps,scope:'Recorded counters only. Null marks an unknown total when a recorded test gate omits that counter; other step types are not test gates.'},
        source,...(value.schemaVersion===3?{failure,cancellation}:{}),
        limits:[...([2,3].includes(value.schemaVersion)?[]:['Legacy reports omit the complete planned step list and terminal state; a success flag alone cannot establish completed scope.']),
            ...(!selectionKnown?['This historical report omits selectors; requested package and step scope is unknown.']:[]),
            'Planned scope and process outcomes are reported by this local JSON, not independently rerun or authenticated by the diagnostic.',
            ...(value.schemaVersion===3?['Before/after source provenance excludes generated outputs and active private configuration; dependencies and intermediate source edits are not frozen. Current source equivalence is unknown.']:['No source HEAD or source-content hashes are recorded. Results do not establish applicability to current source.']),
            'In-progress describes a retained state and does not establish that its process is still running.',
            'Skipped, todo and unknown test-gate counters prevent a complete result. Historical reports can omit Node cancelled counters. Local check evidence does not establish runtime, CI or production acceptance.']};
}

function buildInputs(value){
    if(value===null)return null;
    if(!object(value)||!head(value.head)||!sha(value.sha256)||['files','bytes','newFiles','deleted','exclusions'].some(key=>!count(value[key]))
        ||value.files+value.deleted+value.exclusions>20000||value.bytes>512*1024**2||value.newFiles>value.files)throw malformed();
    return Object.fromEntries(['head','sha256','files','bytes','newFiles','deleted','exclusions'].map(key=>[key,value[key]]));
}
function buildSummary(value,currentGit){
    if(!object(value)||value.schemaVersion!==1||typeof value.ok!=='boolean'||!['preparing','building','built-current-snapshot','cancelled','failed'].includes(value.status)
        ||!Array.isArray(value.builds))throw malformed();
    const requested=uniqueStrings(value.selectedPackages,ids,{empty:false,max:8}),times=timing(value),inputs=buildInputs(value.inputs);
    if(value.builds.length>requested.length)throw malformed();
    const builds=value.builds.map((raw,index)=>{
        if(!object(raw)||raw.id!==requested[index])throw malformed();
        const item={id:raw.id,...processResult(raw)};
        if(typeof raw.leaderReaped!=='boolean'||!object(raw.cleanup)||typeof raw.cleanup.noLiveDescendants!=='boolean')throw malformed();
        item.processClean=raw.leaderReaped&&raw.cleanup.noLiveDescendants;
        if(item.ok&&!item.processClean)throw malformed();
        if(raw.artifacts!==undefined){
            const artifact=raw.artifacts;
            if(!object(artifact)||!count(artifact.files)||artifact.files>20000||!count(artifact.bytes)||artifact.bytes>512*1024**2
                ||!sha(artifact.sha256)||typeof artifact.requiredEntryPresent!=='boolean'
                ||artifact.requiredEntry!==(raw.id==='frontend'?'index.html':raw.id==='bridge'?'index.js':'main.js'))throw malformed();
            item.artifacts={files:artifact.files,bytes:artifact.bytes,sha256:artifact.sha256,requiredEntryPresent:artifact.requiredEntryPresent};
            if(item.ok&&(!artifact.requiredEntryPresent||!artifact.files))throw malformed();
        }else if(item.ok)throw malformed();
        if(item.ok){const log=raw.log;if(!object(log)||!count(log.bytes)||log.bytes>32*1024**2||log.hashedBytes!==log.bytes||log.complete!==true||log.sha256Scope!=='complete-file'||!sha(log.sha256))throw malformed();}
        return item;
    });
    const checks={};
    for(const key of ['sourceCurrent','candidateInputsUnchanged','liveOutputsUnchanged','dependencyLinksUnchanged']){
        if(value[key]!==undefined&&value[key]!==null&&typeof value[key]!=='boolean')throw malformed();checks[key]=value[key]??null;
    }
    const terminal=['built-current-snapshot','cancelled','failed'].includes(value.status);
    if(terminal!==!!times.finishedAt||!terminal&&value.ok)throw malformed();
    if(value.finalizationErrors!==undefined&&(!Array.isArray(value.finalizationErrors)||value.finalizationErrors.length>maxSteps||value.finalizationErrors.some(item=>!object(item))))throw malformed();
    if(value.primaryFailure!==undefined&&value.primaryFailure!==null&&!object(value.primaryFailure))throw malformed();
    const failed=builds.some(build=>!build.ok),success=value.ok&&value.status==='built-current-snapshot'&&inputs&&builds.length===requested.length&&!failed
        &&Object.values(checks).every(check=>check===true)&&value.primaryFailure===null&&Array.isArray(value.finalizationErrors)&&value.finalizationErrors.length===0;
    if(value.ok&&!success||value.status==='built-current-snapshot'&&!success)throw malformed();
    if(value.status==='cancelled'&&value.primaryFailure?.code!=='CANCELLED')throw malformed();
    const source=sourceSummary(inputs,currentGit),cancelled=value.status==='cancelled'||value.builds.some(build=>!build.ok&&build.failure?.code==='CANCELLED');
    return {kind:'isolated-build',...times,status:success?'built-snapshot':cancelled?'cancelled':terminal||failed?'failed':'in-progress',complete:!!success,
        requestedPackages:requested,recordedBuildCount:builds.length,builds,inputs,checks,source,
        limits:['This receipt records an excluded-input source snapshot at build time; current dirty or clean files are not rehashed by this diagnostic.',
            'In-progress describes a retained state and does not establish that its process is still running.',
            'Dependencies were linked and are not content-frozen. No compiler logs, commands, environment values or arbitrary paths are returned.',
            'Candidate artifacts are retained locally. Compilation does not establish runtime, test, CI, deployment or production acceptance.']};
}

/** Summarize one bounded retained local run, exposing only validated counters and fixed vocabulary. */
export async function readRunSummary(root,report,currentGit){
    const match=typeof report==='string'&&/^\.run\/(check|isolated-build)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(report|receipt)\.json$/.exec(report);
    if(!match||match[1]==='check'&&match[3]!=='report'||match[1]==='isolated-build'&&match[3]!=='receipt')throw new DiagnosticError('INVALID_ARGUMENT','Choose one .run/check/<run>/report.json or .run/isolated-build/<run>/receipt.json.');
    const text=(await readOwnedFile(root,report,{limit})).text;let value;
    try{value=JSON.parse(text);}catch{throw malformed();}
    const summary=match[1]==='check'?checkSummary(value,currentGit):buildSummary(value,currentGit);
    return {report,reportSha256:createHash('sha256').update(text).digest('hex'),...summary,evidence:evidenceNote};
}
