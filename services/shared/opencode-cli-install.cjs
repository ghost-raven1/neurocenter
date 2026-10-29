'use strict';
const OPENCODE_CLI_INSTALL_JOB='install-opencode-cli',OPENCODE_CLI_INSTALL_CAPABILITY='opencode-cli-install-v1',OPENCODE_CLI_INSTALL_VERSION='1.14.48';
const TARGETS=Object.freeze(['darwin-arm64','darwin-x64','linux-arm64','linux-x64','linux-arm64-musl','linux-x64-musl']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const version=value=>typeof value==='string'&&value.length<=128&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value);
const time=value=>typeof value==='string'&&value.length<=32&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const invalid=()=>{throw Error('Некорректный контекст установки OpenCode. Исходная установка сохранена.');};
/** Only the authenticated device and request identity are supplied by the browser. */
function normalizeOpenCodeInstallRequest(value){
    if(!exact(value,['deviceId','kind','scope','requestKey'])||!uuid(value.deviceId)||!uuid(value.requestKey)||value.kind!==OPENCODE_CLI_INSTALL_JOB||value.scope!=='global')invalid();
    return {deviceId:value.deviceId,kind:OPENCODE_CLI_INSTALL_JOB,scope:'global',requestKey:value.requestKey};
}
/** The server pins public metadata from the installed bridge; local paths are never input. */
function normalizeOpenCodeInstallSupply(value){
    if(!exact(value,['buildId','target','version','sha256'])||!sha(value.buildId)||!sha(value.sha256)||!TARGETS.includes(value.target)||value.version!==OPENCODE_CLI_INSTALL_VERSION)invalid();
    return {buildId:value.buildId,target:value.target,version:OPENCODE_CLI_INSTALL_VERSION,sha256:value.sha256};
}
/** Bridge package targets predate the separate runtime-artifact glibc namespace. */
function openCodeInstallRuntimeTarget(target){
    if(!TARGETS.includes(target))invalid();return target==='linux-arm64'||target==='linux-x64'?target+'-glibc':target;
}
function normalizeOpenCodeInstallPayload(value){
    if(!exact(value,['schemaVersion','scope','deviceId','source'])||value.schemaVersion!==1||value.scope!=='global'||!uuid(value.deviceId))invalid();
    return {schemaVersion:1,scope:'global',deviceId:value.deviceId,source:normalizeOpenCodeInstallSupply(value.source)};
}
const failures=Object.freeze(['source-changed','source-unavailable','existing-cli-unavailable','destination-unsafe','destination-changed','install-busy','verification-failed','cancelled','authorization-lost','interrupted','install-failed']);
const objectSchema=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const uuidSchema={type:'string',format:'uuid',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'},shaSchema={type:'string',pattern:'^[a-f0-9]{64}$'};
const versionSchema={type:'string',maxLength:128,pattern:'^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$'};
const supplySchema=objectSchema({buildId:shaSchema,target:{type:'string',enum:TARGETS},version:{type:'string',enum:[OPENCODE_CLI_INSTALL_VERSION]},sha256:shaSchema});
const identitySchema={schemaVersion:{type:'integer',enum:[1]},scope:{type:'string',enum:['global']},deviceId:uuidSchema,source:supplySchema};
const resultIdentity={...identitySchema,jobId:uuidSchema,checkedAt:{type:'string',format:'date-time',maxLength:32,description:'Canonical Date.toISOString() timestamp.'}};
const successResult=objectSchema({...resultIdentity,status:{type:'string',enum:['installed','unchanged']},installedVersion:versionSchema,
    commandVersion:{anyOf:[versionSchema,{type:'null'}]},commandReady:{type:'boolean'},nextAction:{type:'string',enum:['none','inspect-path']}});
successResult.description='installed requires installedVersion=1.14.48; unchanged preserves the existing version. commandReady is true exactly when commandVersion equals installedVersion; nextAction is then none, otherwise inspect-path.';
const failedResult=objectSchema({...resultIdentity,status:{type:'string',enum:['failed','unknown']},installedVersion:{type:'null'},commandVersion:{type:'null'},commandReady:{type:'boolean',enum:[false]},nextAction:{type:'string',enum:['retry','reconcile']},failure:{type:'string',enum:failures}});
failedResult.description='unknown requires reconcile after a durable publication marker; failed requires retry. Neither claims CLI absence or availability.';
const OPENCODE_CLI_INSTALL_SCHEMAS={request:objectSchema({deviceId:uuidSchema,kind:{type:'string',enum:[OPENCODE_CLI_INSTALL_JOB]},scope:identitySchema.scope,requestKey:uuidSchema}),
    supply:supplySchema,payload:objectSchema(identitySchema),success:successResult,failure:failedResult,result:{oneOf:[successResult,failedResult]}};
/** A published binary and a usable ordinary PATH command remain distinct measured outcomes. */
function normalizeOpenCodeInstallResult(value,expected){
    const keys=['schemaVersion','scope','deviceId','source','jobId','checkedAt','status','installedVersion','commandVersion','commandReady','nextAction'];
    if(!exact(value,[...keys,...(object(value)&&Object.hasOwn(value,'failure')?['failure']:[])])||!uuid(value.jobId)||!time(value.checkedAt)
        ||!['installed','unchanged','failed','unknown'].includes(value.status)||typeof value.commandReady!=='boolean'
        ||!(value.installedVersion===null||version(value.installedVersion))||!(value.commandVersion===null||version(value.commandVersion))
        ||value.failure!==undefined&&!failures.includes(value.failure))invalid();
    const payload=normalizeOpenCodeInstallPayload(Object.fromEntries(['schemaVersion','scope','deviceId','source'].map(key=>[key,value[key]])));
    const success=['installed','unchanged'].includes(value.status);
    if(success?(!version(value.installedVersion)||value.failure!==undefined||value.status==='installed'&&value.installedVersion!==OPENCODE_CLI_INSTALL_VERSION
        ||value.commandReady!==(value.commandVersion===value.installedVersion)||value.nextAction!==(value.commandReady?'none':'inspect-path'))
        :value.installedVersion!==null||value.commandVersion!==null||value.commandReady||!value.failure||value.nextAction!==(value.status==='unknown'?'reconcile':'retry'))invalid();
    if(expected&&(value.deviceId!==expected.deviceId||value.jobId!==expected.jobId||JSON.stringify(payload.source)!==JSON.stringify(normalizeOpenCodeInstallSupply(expected.source))))invalid();
    return {...payload,jobId:value.jobId,checkedAt:value.checkedAt,status:value.status,installedVersion:value.installedVersion,commandVersion:value.commandVersion,
        commandReady:value.commandReady,nextAction:value.nextAction,...(value.failure?{failure:value.failure}:{})};
}
module.exports={OPENCODE_CLI_INSTALL_JOB,OPENCODE_CLI_INSTALL_CAPABILITY,OPENCODE_CLI_INSTALL_VERSION,OPENCODE_CLI_INSTALL_TARGETS:TARGETS,
    OPENCODE_CLI_INSTALL_SCHEMAS,openCodeInstallRuntimeTarget,normalizeOpenCodeInstallRequest,normalizeOpenCodeInstallSupply,normalizeOpenCodeInstallPayload,normalizeOpenCodeInstallResult};
