import {packages,logServices} from './constants.mjs';

const text=(maxLength=1200)=>({type:'string',maxLength});
const integer=(maximum=Number.MAX_SAFE_INTEGER)=>({type:'integer',minimum:0,maximum});
const boolean={type:'boolean'},nil={type:'null'};
const nullable=schema=>({anyOf:[schema,nil]});
const choices=values=>({enum:values});
const array=(items,maxItems)=>({type:'array',items,maxItems});
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const digest={type:'string',pattern:'^[a-f0-9]{64}$'};
const head={type:'string',pattern:'^(?:[a-f0-9]{40}|[a-f0-9]{64})$'};
const date=nullable({type:'string',pattern:'^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d{1,3})?Z$'});
const packageName=choices(packages.map(([name])=>name));
const checkStep=choices(['typecheck','build','test']);
const evidence=text(1000);
const metric=object({total:integer(),covered:integer(),skipped:nullable(integer()),pct:nullable({type:'number',minimum:0,maximum:100})},['total','covered','pct']);
const metrics=object(Object.fromEntries(['lines','statements','functions','branches'].map(name=>[name,metric])));
const counters=object({passed:nullable(integer()),failed:nullable(integer()),skipped:nullable(integer()),todo:nullable(integer()),cancelled:nullable(integer())},['passed','failed','skipped','todo']);
const testCounters=object({passed:integer(),failed:integer(),skipped:integer(),todo:integer(),cancelled:integer()},['passed','failed','skipped','todo']);
const selection=object({packages:array(packageName,8),steps:array(checkStep,3)});
const workingTree=choices(['clean','dirty','unknown']);
const processFields={ok:boolean,exitCode:nullable(integer(255)),signal:nullable({type:'string',pattern:'^SIG[A-Z0-9]{1,12}$'}),durationMs:integer()};
const cleanup=object({noLiveDescendants:boolean,signals:array(choices(['SIGTERM','SIGKILL']),4),zombieCount:integer()},['noLiveDescendants']);
const failure=nullable(object({code:{type:'string',pattern:'^[A-Z][A-Z0-9_]{0,79}$'}}));
const snapshot=object({head,sha256:digest,files:integer(20000),bytes:integer(512*1024**2),newFiles:integer(20000),deleted:integer(20000),exclusions:integer(20000)});

const git= {anyOf:[object({available:{const:false},reason:text(300)}),object({available:{const:true},head,branch:nullable(text(200)),detached:boolean,
    dirty:object({changed:integer(),untracked:integer(),conflicts:integer(),clean:boolean,scope:text(300)})})]};
const workspace=object({workspace:{const:'neurocenter-workspace'},node:text(100),node24:boolean,git,
    packages:array(object({name:packageName,version:nullable(text(100)),state:{const:'unavailable'}},['name','version']),8),
    checkCommands:array(text(300),16),note:text(500),evidence,
    developerTools:object({version:text(50),tools:array(text(128),32)})});

const probeStates=['http-ok','http-error','redirect-blocked','body-limit','timeout','cancelled','unreachable','response-error','skipped'];
const probe=object({path:nullable(text(180)),state:choices(probeStates),statusCode:nullable(integer(599)),ok:nullable(boolean),partialProbe:boolean,
    bodyBytes:integer(32768),durationMs:integer(),reason:nullable(text(80))});
const ownership=object({state:choices(['owned','foreign','unknown','disabled']),reason:text(80),pids:array(integer(),8)});
const health=object({scope:text(2000),services:array(object({service:choices(logServices),port:integer(65535),state:choices(probeStates),statusCode:nullable(integer(599)),
    ready:nullable(boolean),partialProbe:boolean,bodyBytes:integer(32768),durationMs:integer(),liveness:probe,readiness:probe,compilation:probe,ownership}),8),evidence});
const logTime={type:'string',pattern:'^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$'};
const logDetails=object({observedAt:logTime,fileModifiedAt:logTime,fileBytes:integer(),bytesRead:integer(32768),
    currentProcessCorrelation:object({state:{const:'unknown'},reason:{const:'append-log-without-launch-provenance'}})});
const launchId={type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'};
const requestId={type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'};
const launch=object({launchId,generation:nullable(launchId),entryDigest:digest,sourceSha256:nullable(digest),startedAt:logTime});
const correlation={anyOf:[object({state:{const:'owned'},reason:text(80),pid:integer()}),
    object({state:choices(['historical','unknown']),reason:text(80)})]};
const generationLogDetails=object({...logDetails.properties,launch,currentProcessCorrelation:correlation});
const logs=object({service:choices(logServices),text:text(32768),lines:integer(100),truncated:boolean,evidence,
    details:{anyOf:[logDetails,generationLogDetails]}},
    ['service','text','lines','truncated','evidence']);

const coverageSource=object({recordedHead:nullable(head),currentHead:nullable(head),currentHeadMatches:nullable(boolean),sourceChangedDuringRun:nullable(boolean),
    status:choices(['changed','clean-head-match','not-fully-verified'])});
const baseReport={report:text(180),reportSha256:digest,startedAt:date,finishedAt:date,status:text(80),complete:boolean,evidence};
const coverageLifecycle=object({schemaVersion:{const:1},state:choices(['preparing','running','finalizing','passed','failed','cancelled']),
    plannedSteps:array(choices([...packages.map(([id])=>'unit:'+id),'native','integration']),10),
    steps:array(object({id:choices([...packages.map(([id])=>'unit:'+id),'native','integration']),startedAt:date,finishedAt:date,
        result:nullable(object({...processFields,leaderReaped:boolean,cleanup,failure},[...Object.keys(processFields),'leaderReaped','cleanup']))}),10),
    failure,cancellation:nullable(object({signal:nullable(choices(['SIGINT','SIGTERM']))})),finalizationErrors:array(object({code:text(80)}),16)});
const coverageProperties={...baseReport,status:choices(['in-progress','failed','cancelled','incomplete','requested-suites-complete']),profile:text(120),
    coverageKind:nullable(choices(['vitest-ast-v8','native-c8-v8','experimental-mixed-instrumentation'])),comparablePercentages:boolean,
    packages:array(object({name:packageName,passed:nullable(integer()),failed:nullable(integer()),skipped:nullable(integer()),todo:nullable(integer()),cancelled:nullable(integer()),
        exitCode:nullable({type:'integer'}),excludedSuites:nullable(integer()),fileInventory:choices(['complete','incomplete','not-reported']),reportValid:choices(['valid','invalid','not-reported'])},
        ['name','passed','failed','skipped','todo','exitCode','excludedSuites','fileInventory','reportValid']),32),native:nullable(counters),integration:nullable(counters),retainedProfiles:array(object({native:nullable(counters),integration:nullable(counters)}),64),
    countScope:text(500),summary:object(metrics.properties,[]),sourceFiles:nullable(integer()),source:coverageSource,
    denominator:object({allWorkspaceSourcesIncluded:nullable(boolean),configuredPackageSourcesIncluded:nullable(boolean),httpOnlyExecutedSources:nullable(boolean),fileInventoryIsNotLineCoverage:nullable(boolean)})};
const coverage=object({...coverageProperties,lifecycle:coverageLifecycle},Object.keys(coverageProperties));

const checkSource=object({status:choices(['unknown','capturing','unchanged','changed']),available:boolean,head:nullable(head),workingTree,
    currentSourceEquivalent:{const:'unknown'},before:nullable(snapshot),after:nullable(snapshot),reason:nullable(text(100)),note:text(1000)},['status','currentSourceEquivalent']);
const check=object({...baseReport,kind:{const:'check'},status:choices(['requested-steps-complete','incomplete','failed','cancelled','in-progress']),
    reportedSuccess:boolean,observedStepsPassed:boolean,requested:nullable(object({...selection.properties,tooling:{const:true}},['packages','steps'])),requestedScope:choices(['recorded-selectors','unknown']),
    plannedSteps:nullable(array(text(200),64)),recordedStepCount:integer(64),plannedStepCount:nullable(integer(64)),
    steps:array(object({name:text(200),package:nullable(packageName),step:nullable(checkStep),...processFields,testRunner:choices(['node','vitest']),tests:testCounters,
        leaderReaped:boolean,cleanup,failure},['name','package','step',...Object.keys(processFields)]),64),
    testCounters:object({...Object.fromEntries(Object.keys(testCounters.properties).map(key=>[key,nullable(integer())])),countedSteps:integer(64),scope:text(500)}),source:checkSource,limits:array(text(1200),16),
    failure,cancellation:nullable(object({signal:nullable(choices(['SIGINT','SIGTERM']))}))},
    [...Object.keys(baseReport),'kind','reportedSuccess','observedStepsPassed','requested','requestedScope','plannedSteps','recordedStepCount','plannedStepCount','steps','testCounters','source','limits']);

const buildSource=object({status:choices(['head-mismatch','dirty-source-not-verified','not-fully-verified']),recordedHead:nullable(head),currentHead:nullable(head),
    currentWorkingTree:workingTree,currentSourceEquivalent:{const:'unknown'},snapshotSha256:digest,note:text(600)},
    ['status','recordedHead','currentHead','currentWorkingTree','currentSourceEquivalent','note']);
const build=object({...baseReport,kind:{const:'isolated-build'},status:choices(['built-snapshot','failed','cancelled','in-progress']),requestedPackages:array(packageName,8),recordedBuildCount:integer(8),
    builds:array(object({id:packageName,...processFields,processClean:boolean,artifacts:object({files:integer(20000),bytes:integer(512*1024**2),sha256:digest,requiredEntryPresent:boolean})},
        ['id',...Object.keys(processFields),'processClean']),8),inputs:nullable(snapshot),
    checks:object({sourceCurrent:nullable(boolean),candidateInputsUnchanged:nullable(boolean),liveOutputsUnchanged:nullable(boolean),dependencyLinksUnchanged:nullable(boolean)}),
    source:buildSource,limits:array(text(1200),16)});

const gaps=object({report:text(180),reportSha256:digest,gapsSha256:digest,package:packageName,profile:text(120),coverageKind:coverage.properties.coverageKind,
    comparablePercentages:boolean,verificationStatus:coverage.properties.status,complete:boolean,testCounters:array(counters,32),source:coverageSource,totalTargets:integer(),
    targets:array(object({file:text(512),summary:metrics,uncoveredBranches:integer(),uncoveredFunctionCount:integer(),
        uncoveredFunctions:array(object({name:text(120),line:{type:'integer',minimum:1}}),20),uncoveredStatementLines:array({type:'integer',minimum:1},40),detailsTruncated:boolean}),20),
    unrepresentedFileCount:integer(),unrepresentedFiles:array(text(512),20),excludedSuiteCount:integer(),excludedSuites:array(text(512),20),exclusionScope:text(500),truncated:boolean,scope:text(1000),evidence});
const plan=object({mode:{const:'plan'},selection,steps:array(object({package:packageName,step:checkStep,directory:choices(packages.map(([,folder])=>folder)),command:text(100)}),24),
    skipped:array(object({package:packageName,step:{const:'test'},reason:text(300)}),8),command:text(1000),scope:text(1000),effects:text(1000),evidence});

const evidenceFamily=choices(['check','coverage','isolated-build']);
const rejectionReason=choices(['MALFORMED_REPORT','UNSAFE_REPORT','REPORT_CHANGED','REPORT_UNAVAILABLE','REPORT_TOO_LARGE']);
const catalogEntry={anyOf:[object({family:evidenceFamily,report:text(180),state:{const:'available'},reportSha256:digest,status:text(80),complete:boolean,
    countScope:object({kind:choices(['check','coverage','build']),packages:array(packageName,8),steps:array(checkStep,3),tooling:nullable(boolean),profile:nullable(text(120)),reportedOnly:{const:true}}),
    startedAt:date,finishedAt:date}),object({family:evidenceFamily,report:text(180),state:{const:'rejected'},reason:rejectionReason})]};
const evidenceCatalog=object({evidence:{const:'recorded-local-evidence'},observedAt:logTime,entries:array(catalogEntry,20),
    scan:object({entryLimit:{type:'integer',minimum:1,maximum:20},scanLimit:{const:128},scannedDirectories:integer(128),scannedEntries:integer(128),
        attemptedReports:integer(128),truncated:boolean,complete:boolean,rejectedFamilies:array(object({family:evidenceFamily,reason:rejectionReason}),3)})});
const sourceVerification=object({report:text(180),reportSha256:nullable(digest),observedAt:logTime,recorded:object({status:nullable(text(80)),complete:nullable(boolean)}),
    comparison:object({state:choices(['match','mismatch','unknown']),reason:{type:'string',pattern:'^[A-Z][A-Z0-9_]{0,79}$'},
        scope:choices(['check-v3-recorded-after','isolated-build-source-snapshot','unsupported-source-protocol']),currentSource:nullable(snapshot)}),limits:array(text(1200),16)});
const traceCommon={schemaVersion:{const:1},kind:{const:'neurocenter-dev-trace'},timestamp:logTime,launchId};
const traceEvent={anyOf:[object({...traceCommon,flow:{const:'tool-build'},event:choices(['requested','accepted','replayed','started','cancel-requested','succeeded','failed','cancelled']),
    requestKey:requestId,buildId:requestId,operationId:{type:'string',pattern:'^tool-build-[a-f0-9-]{36}$'}},[...Object.keys(traceCommon),'flow','event','requestKey']),
    object({...traceCommon,flow:{const:'saved-chat'},event:choices(['accepted','retried','started','cancel-requested','succeeded','failed','cancelled']),
        conversationId:requestId,turnId:requestId,requestId,attemptId:requestId})]};
const requestTrace=object({flow:choices(['tool-build','saved-chat']),request:requestId,observedAt:logTime,launch:nullable(launch),currentProcessCorrelation:correlation,
    state:choices(['unavailable','observed','not-found']),events:array(traceEvent,100),rejectedRecords:integer(32769),truncated:boolean,scope:text(1000),evidence});
const impactPlan=object({schemaVersion:{const:1},baseRevision:head,
    sourceFingerprint:object({status:choices(['known','unknown']),head:nullable(head),sha256:nullable(digest),fileCount:nullable(integer(20000)),reason:nullable(text(80))}),
    changedPathsStatus:choices(['known','unknown']),changedPathsDigest:nullable(digest),changedPathsCount:nullable(integer(20000)),
    changedPathsReason:choices(['INPUT_LIMIT','GIT_UNAVAILABLE']),mode:choices(['scoped','fallback']),packages:array(packageName,8),
    reasons:array(object({rule:choices(['SOURCE_UNKNOWN','CHANGES_UNKNOWN','UNSAFE_PATH','NO_CHANGES','SHARED_INPUT','PLANNER_INPUT','GLOBAL_CONFIGURATION',
        'PACKAGE_OWNER','CATALOG_BUILDER','UNKNOWN_PATH','VERIFIED_CONSUMER']),package:packageName,count:{type:'integer',minimum:1}},['rule','count']),128),
    plannedChecks:object({selection:object({packages:array(packageName,8),steps:array(checkStep,0)}),
        checks:array(object({kind:choices(['npm','node','compose']),package:nullable(packageName),
            check:choices(['typecheck','build','test','common-contracts','agent-kit','compose-embeddings','compose-dev'])}),64),
        inputsCount:integer(20000),inputsSha256:digest,checksSha256:digest}),
    additionalAcceptance:array(object({kind:choices(['database-migrations','native-runtime','rag-integration','package-tests-unavailable']),package:packageName,
        count:{type:'integer',minimum:1},reason:choices(['OUTSIDE_DEFAULT_CHECK','NO_PACKAGE_TEST_SCRIPT'])},['kind','count','reason']),64),
    limits:array(text(1200),24),planFingerprint:digest,evidence},
    ['schemaVersion','baseRevision','sourceFingerprint','changedPathsStatus','changedPathsDigest','changedPathsCount','mode','packages','reasons','plannedChecks','additionalAcceptance','limits','planFingerprint','evidence']);

/** Public closed schemas describe successful results; protocol/tool errors remain separate. */
export const outputSchemas={workspace_status:workspace,services_health:health,service_logs:logs,verification_summary:{type:'object',anyOf:[coverage,check,build]},
    coverage_gaps:gaps,check_plan:plan,evidence_catalog:evidenceCatalog,verify_source:sourceVerification,request_trace:requestTrace,impact_plan:impactPlan};
