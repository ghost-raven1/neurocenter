'use strict';
const {isDeepStrictEqual}=require('node:util');
const PROJECT_CONFIGURATION_JOB='open-project-configuration';
const PROJECT_CONFIGURATION_CAPABILITY='project-configuration-v1';
const keys=['schemaVersion','deviceId','projectId','bindingId','instanceId','sessionId','expiresAt','ragInstallations'];
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const exact=(value,fields)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
/** Only server-pinned identity crosses the device channel; file contents and local URLs never do. */
function normalizeProjectConfigurationSession(value){
    if(!exact(value,keys)||value.schemaVersion!==1||!uuid(value.deviceId)||!uuid(value.instanceId)||!uuid(value.sessionId)
        ||typeof value.projectId!=='string'||!value.projectId||value.projectId.length>200||/[\x00-\x1f\x7f]/.test(value.projectId)
        ||typeof value.bindingId!=='string'||!/^[a-f0-9]{64}$/.test(value.bindingId)
        ||typeof value.expiresAt!=='string'||!Number.isFinite(Date.parse(value.expiresAt))||new Date(value.expiresAt).toISOString()!==value.expiresAt)throw Error('Invalid project configuration identity');
    if(!Array.isArray(value.ragInstallations)||value.ragInstallations.length>20||value.ragInstallations.some(ref=>!exact(ref,['kind','id','version','manifest'])||!['mcp','plugin'].includes(ref.kind)||typeof ref.id!=='string'||!ref.id||ref.id.length>500||/[\x00-\x1f\x7f]/.test(ref.id)||!Number.isSafeInteger(ref.version)||ref.version<1||typeof ref.manifest!=='string'||!/^[a-f0-9]{64}$/.test(ref.manifest))||new Set(value.ragInstallations.map(ref=>ref.kind+':'+ref.id)).size!==value.ragInstallations.length)throw Error('Invalid RAG installation references');
    return structuredClone(Object.fromEntries(keys.map(key=>[key,value[key]])));
}
function normalizeProjectConfigurationReport(value,session,failed=false){
    if(failed){if(!exact(value,[]))throw Error('Configuration failure must not carry local data');return {};}
    const identity=normalizeProjectConfigurationSession(session);
    if(!exact(value,[...keys,'opened'])||value.opened!==true||keys.some(key=>!isDeepStrictEqual(value[key],identity[key])))throw Error('Configuration report differs from pinned identity');
    return {...identity,opened:true};
}
module.exports={PROJECT_CONFIGURATION_JOB,PROJECT_CONFIGURATION_CAPABILITY,normalizeProjectConfigurationSession,normalizeProjectConfigurationReport};
