'use strict';
const {createHash}=require('node:crypto');
const {normalizeLearningContext}=require('./project-learning.cjs');
const MEMORY_SYNC_JOB='sync-learning-memory',MEMORY_SYNC_CAPABILITY='project-learning-memory-v1';
const MEMORY_RECIPE={schemaVersion:1,package:'@modelcontextprotocol/server-memory',version:'1.0.0',projectionSchemaVersion:1};
const MEMORY_SYNC_LIMITS=Object.freeze({entities:1024,activeEntries:32,observationsPerEntity:512,ownedObservationBytes:20*1024,planBytes:1024*1024,journalBytes:4*1024*1024,readResponseBytes:2*1024*1024,stepsPerJob:256,concurrency:1});
const record=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v,max=512)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):record(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const memoryDigest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const invalid=()=>{throw new TypeError('Некорректный контракт синхронизации памяти.');};
/** An explicit producer descriptor, never a display name, declares the supported Memory ABI. */
function memoryRecipeSupported(pkg){
 const meta=pkg?.config?.extra?.learningMemory;
 return pkg?.schemaVersion===5&&pkg?.plugin?.kind==='mcp'&&pkg?.config?.transport!=='remote'&&pkg?.config?.entrypoint==='entrypoint.mjs'
  &&(!pkg.config.args||pkg.config.args.length===0)&&(!pkg.config.env||Object.keys(pkg.config.env).length===0)
  &&exact(meta,Object.keys(MEMORY_RECIPE))&&Object.entries(MEMORY_RECIPE).every(([k,v])=>meta[k]===v);
}
function normalizeMemorySyncPayload(v){
 const keys=['schemaVersion','projectId','bindingId','instanceId','assetId','version','manifest','learningRevision','learningDigest','mode'];
 if(!exact(v,keys)||v.schemaVersion!==1||!text(v.projectId,200)||!sha(v.bindingId)||typeof v.instanceId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.instanceId)||!text(v.assetId)
  ||!Number.isSafeInteger(v.version)||v.version<1||!sha(v.manifest)||!Number.isSafeInteger(v.learningRevision)||v.learningRevision<0||!sha(v.learningDigest)||!['sync','cleanup'].includes(v.mode))invalid();
 return {...v};
}
/** Only approved context can be projected; the device supplies its own site identity. */
function normalizeMemorySyncContext(v){
 if(!exact(v,['schemaVersion','payload','context','package'])||v.schemaVersion!==1||!memoryRecipeSupported(v.package))invalid();
 const payload=normalizeMemorySyncPayload(v.payload),context=normalizeLearningContext(v.context);
 if(context.projectId!==payload.projectId||context.revision!==payload.learningRevision||context.digest!==payload.learningDigest
  ||v.package.plugin.id!==payload.assetId||v.package.plugin.version!==payload.version||v.package.manifest?.sha256!==payload.manifest)invalid();
 return {schemaVersion:1,payload,context,package:v.package};
}
function memoryNamespace(site,projectId){if(!text(site,2048)||!text(projectId,200))invalid();return 'neurocenter:learning:'+memoryDigest([site,projectId]).slice(0,32)+':';}
function memoryEntity(namespace,entry){
 return {name:namespace+entry.key,entityType:'neurocenter.approved-project-knowledge.v1',observations:[JSON.stringify({schemaVersion:1,source:'neurocenter-approved-learning',
  id:entry.id,key:entry.key,version:entry.version,kind:entry.kind,title:entry.title,content:entry.content,targetAgentId:entry.targetAgentId,
  hypothesisId:entry.hypothesisId,checkId:entry.checkId,approvedAt:entry.approvedAt})]};
}
/** Public receipts contain counters and hashes, never graph contents or learned text. */
function normalizeMemorySyncResult(v,payload){
 const keys=['schemaVersion','protocol','projectId','bindingId','instanceId','assetId','manifest','learningDigest','mode','status','applied','removed','remaining','receiptDigest','code'];
 if(!exact(v,keys)||v.schemaVersion!==1||v.protocol!==MEMORY_SYNC_CAPABILITY||!['complete','partial'].includes(v.status)||!['none','authorization','conflict','unavailable','quota'].includes(v.code)||!sha(v.receiptDigest)
  ||['applied','removed','remaining'].some(k=>!Number.isSafeInteger(v[k])||v[k]<0||v[k]>1024)
  ||['projectId','bindingId','instanceId','assetId','manifest','learningDigest','mode'].some(k=>v[k]!==payload[k])||v.status==='complete'&&(v.remaining!==0||v.code!=='none'))invalid();
 return {...v};
}
module.exports={MEMORY_SYNC_JOB,MEMORY_SYNC_CAPABILITY,MEMORY_RECIPE,MEMORY_SYNC_LIMITS,memoryDigest,memoryNamespace,memoryEntity,memoryRecipeSupported,normalizeMemorySyncPayload,normalizeMemorySyncContext,normalizeMemorySyncResult};
