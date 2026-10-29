'use strict';

const OPENCODE_CLI_INSPECT_JOB='inspect-opencode-cli';
const OPENCODE_CLI_CAPABILITY='opencode-cli-v1';
/** CLI device and job identities are the issued canonical lowercase UUIDs. */
const UUID_PATTERN='^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$';
const REQUEST_KEY_PATTERN='^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$';
const VERSION_PATTERN='^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$';
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=value=>typeof value==='string'&&new RegExp(UUID_PATTERN).test(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const version=value=>typeof value==='string'&&value.length<=128&&new RegExp(VERSION_PATTERN).test(value);
const time=value=>typeof value==='string'&&value.length<=32&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const objectSchema=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const identitySchema={schemaVersion:{type:'integer',enum:[1]},scope:{type:'string',enum:['global']},deviceId:{type:'string',format:'uuid',pattern:UUID_PATTERN}};
const observationSchema={...identitySchema,jobId:{type:'string',format:'uuid',pattern:UUID_PATTERN},checkedAt:{type:'string',format:'date-time',maxLength:32,description:'Canonical ISO timestamp produced by Date.toISOString().'}};
/** Published schemas use the same literal kinds, UUID and version patterns as runtime admission. */
const OPENCODE_CLI_SCHEMAS={
    request:objectSchema({deviceId:identitySchema.deviceId,kind:{type:'string',enum:[OPENCODE_CLI_INSPECT_JOB]},scope:identitySchema.scope,requestKey:{type:'string',format:'uuid',pattern:REQUEST_KEY_PATTERN}}),
    payload:objectSchema(identitySchema),
    observation:{oneOf:[objectSchema({...observationSchema,status:{type:'string',enum:['installed']},version:{type:'string',maxLength:128,pattern:VERSION_PATTERN}}),
        objectSchema({...observationSchema,status:{type:'string',enum:['missing','failed','timed-out']}})]},
};

/** Browser admission has one fixed target and request identity, with no local process options. */
function normalizeOpenCodeCliRequest(value){
    if(!exact(value,['deviceId','kind','scope','requestKey'])||value.kind!==OPENCODE_CLI_INSPECT_JOB||value.scope!=='global'||!uuid(value.deviceId)
        ||typeof value.requestKey!=='string'||!new RegExp(REQUEST_KEY_PATTERN).test(value.requestKey)){
        throw new Error('Проверка OpenCode принимает только компьютер, глобальную область и UUID ключа запроса.');
    }
    return {deviceId:value.deviceId,kind:OPENCODE_CLI_INSPECT_JOB,scope:'global',requestKey:value.requestKey};
}

/** One fixed device observation: browser-supplied commands, paths and credentials are rejected. */
function normalizeOpenCodeCliPayload(value){
    if(!exact(value,['schemaVersion','scope','deviceId'])||value.schemaVersion!==1||value.scope!=='global'||!uuid(value.deviceId)){
        throw new Error('Некорректный контекст проверки OpenCode на компьютере.');
    }
    return {schemaVersion:1,scope:'global',deviceId:value.deviceId};
}

/** Only a validated version may leave the computer; raw process output is never part of this receipt. */
function normalizeOpenCodeCliResult(value,expected){
    const installed=record(value)&&value.status==='installed';
    const keys=['schemaVersion','scope','deviceId','jobId','checkedAt','status',...(installed?['version']:[])];
    if(!exact(value,keys)||value.schemaVersion!==1||value.scope!=='global'||!uuid(value.deviceId)||!uuid(value.jobId)||!time(value.checkedAt)
        ||!['installed','missing','failed','timed-out'].includes(value.status)||installed&&!version(value.version)
        ||expected&&(value.deviceId!==expected.deviceId||value.jobId!==expected.jobId)){
        throw new Error('Квитанция проверки OpenCode содержит неподдерживаемые данные или другой компьютер.');
    }
    return {schemaVersion:1,scope:'global',deviceId:value.deviceId,jobId:value.jobId,checkedAt:value.checkedAt,status:value.status,...(installed?{version:value.version}:{})};
}

module.exports={OPENCODE_CLI_INSPECT_JOB,OPENCODE_CLI_CAPABILITY,OPENCODE_CLI_SCHEMAS,normalizeOpenCodeCliRequest,normalizeOpenCodeCliPayload,normalizeOpenCodeCliResult};
