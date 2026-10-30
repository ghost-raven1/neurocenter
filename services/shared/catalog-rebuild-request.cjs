const {randomUUID,createHash}=require('node:crypto');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** A local rebuild selects only the current verified source revision, never an actor, command or path. */
function parseCatalogRebuildRequest(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='requestId,requestedAt,schemaVersion,sourceRevision'
        ||value.schemaVersion!==1||typeof value.requestId!=='string'||!uuid.test(value.requestId)
        ||typeof value.sourceRevision!=='string'||!/^[a-f0-9]{64}$/.test(value.sourceRevision)
        ||typeof value.requestedAt!=='string'||!Number.isFinite(Date.parse(value.requestedAt))||new Date(value.requestedAt).toISOString()!==value.requestedAt)throw Error('Запрос актуализации каталога повреждён. Повторите пересборку приложения.');
    return {...value};
}
function makeCatalogRebuildRequest(sourceRevision){return parseCatalogRebuildRequest({schemaVersion:1,requestId:randomUUID(),sourceRevision,requestedAt:new Date().toISOString()});}
/** A lost ACK or process restart retains one key per component of the same explicit rebuild. */
function catalogRebuildRequestKey(requestId,component){
    if(!uuid.test(requestId)||typeof component!=='string'||!component||component.length>240)throw Error('Некорректная операция актуализации каталога.');
    const bytes=createHash('sha256').update(requestId+'\0'+component).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=bytes.toString('hex');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
module.exports={parseCatalogRebuildRequest,makeCatalogRebuildRequest,catalogRebuildRequestKey};
