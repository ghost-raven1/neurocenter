'use strict';
const {createHash}=require('node:crypto');
const DEVICE_CODEX_PROTOCOL='device-codex-inference-v1',DEVICE_CODEX_CAPABILITY=DEVICE_CODEX_PROTOCOL,DEVICE_CODEX_JOB='infer-device-codex';
const record=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>record(v)&&Object.keys(v).every(k=>keys.includes(k))&&keys.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const count=v=>v===null||Number.isSafeInteger(v)&&v>=0;
const canonical=v=>Array.isArray(v)?v.map(canonical):record(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
/** Project already validated scan metadata onto the immutable provider identity used at import and dispatch. */
function deviceCodexCandidateIdentity(candidate){
 return {provider:candidate.provider,...(candidate.configKey===undefined?{}:{configKey:candidate.configKey}),model:candidate.model,
  modelVersion:candidate.modelVersion,capability:candidate.capability,baseUrl:candidate.baseUrl,
  ...(candidate.options===undefined?{}:{options:candidate.options})};
}
function source(v){
 if(exact(v,['scope'])&&v.scope==='global')return {scope:'global'};
 if(exact(v,['scope','projectId','bindingId','instanceId'])&&v.scope==='project'&&text(v.projectId,200)&&sha(v.bindingId)&&uuid(v.instanceId))return {...v};
 throw new TypeError('Invalid Codex source.');
}
/** Public queue metadata contains neither prompts, credentials nor generated content. */
function normalizeDeviceCodexPayload(v){
 if(!exact(v,['protocol','callId','modelId','modelPin','connectionRevision','source','deadlineAt'])||v.protocol!==DEVICE_CODEX_PROTOCOL
  ||!uuid(v.callId)||!text(v.modelId,200)||!sha(v.modelPin)||!Number.isSafeInteger(v.connectionRevision)||v.connectionRevision<1||!iso(v.deadlineAt))throw new TypeError('Invalid Codex job.');
 return {...v,source:source(v.source)};
}
function normalizeDeviceCodexRequest(v,capability){
 if(!record(v)||Object.keys(v).some(k=>!['messages','options'].includes(k))||!['chat','vision'].includes(capability)||!Array.isArray(v.messages)||!v.messages.length||v.messages.length>500)throw new TypeError('Invalid Codex request.');
 const messages=v.messages.map(m=>{
  if(!record(m)||Object.keys(m).some(k=>!['role','content','images'].includes(k))||!['system','user','assistant'].includes(m.role)||typeof m.content!=='string'||m.content.length>262144)throw new TypeError('Invalid Codex message.');
  if(m.images!==undefined&&(capability!=='vision'||!Array.isArray(m.images)||m.images.length>4||m.images.some(i=>typeof i!=='string'||i.length>8*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(i))))throw new TypeError('Invalid Codex image.');
  return {role:m.role,content:m.content,...(m.images===undefined?{}:{images:[...m.images]})};
 });
 const options=v.options===undefined?{}:v.options;
 if(!record(options)||Object.entries(options).some(([k,o])=>k==='reasoningEffort'?!['none','minimal','low','medium','high','xhigh','max'].includes(o):k==='store'?o!==false:true))throw new TypeError('Codex supports reasoningEffort and store:false only; sampling and output limits are unavailable.');
 const result={messages,options:{...options}};
 if(Buffer.byteLength(JSON.stringify(result))>12*1024*1024)throw new TypeError('Codex request too large.');
 return result;
}
function normalizeDeviceCodexContext(v){
 if(!exact(v,['protocol','callId','model','capability','messages','options','source','expectedCandidate','connectorPackage','deadlineAt'])||v.protocol!==DEVICE_CODEX_PROTOCOL||!uuid(v.callId)||!text(v.model,200)||!iso(v.deadlineAt)||!record(v.connectorPackage))throw new TypeError('Invalid Codex context.');
 const c=v.expectedCandidate;
 if(!record(c)||Object.keys(c).some(k=>!['provider','configKey','model','modelVersion','capability','baseUrl','options'].includes(k))||!text(c.provider,128)||!text(c.model,200)||!text(c.modelVersion,128)||!['chat','vision'].includes(c.capability)||!(c.baseUrl===null||text(c.baseUrl,1024))||c.configKey!==undefined&&!text(c.configKey,128)||c.options!==undefined&&!require('./opencode-model-scan.cjs').validModelOptions(c.options)||c.model!==v.model||c.capability!==v.capability)throw new TypeError('Invalid Codex source identity.');
 return {...v,...normalizeDeviceCodexRequest({messages:v.messages,options:v.options},v.capability),source:source(v.source)};
}
/** Only a bounded completed response or a non-secret error code can be saved as a private receipt. */
function normalizeDeviceCodexResult(v){
 if(!record(v)||v.protocol!==DEVICE_CODEX_PROTOCOL||!uuid(v.callId)||Buffer.byteLength(JSON.stringify(v))>512*1024)throw new TypeError('Invalid Codex receipt.');
 if(exact(v,['protocol','callId','error'])&&exact(v.error,['code'])&&['cancelled','deadline','authorization','unavailable','response','unknown-after-send'].includes(v.error.code))return {protocol:v.protocol,callId:v.callId,error:{code:v.error.code}};
 const r=v.response;
 if(!exact(v,['protocol','callId','response'])||!exact(r,['model','done','done_reason','message','prompt_eval_count','eval_count','usage_reported'])||!text(r.model,200)||r.done!==true||!['stop','length'].includes(r.done_reason)
  ||!exact(r.message,['role','content'])||r.message.role!=='assistant'||typeof r.message.content!=='string'||!r.message.content.trim()||Buffer.byteLength(r.message.content)>480*1024
  ||!count(r.prompt_eval_count)||!count(r.eval_count)||r.usage_reported!==(r.prompt_eval_count!==null||r.eval_count!==null))throw new TypeError('Invalid Codex response.');
 return {protocol:v.protocol,callId:v.callId,response:{...r,message:{...r.message}}};
}
const deviceCodexResultDigest=v=>createHash('sha256').update(JSON.stringify(canonical(normalizeDeviceCodexResult(v)))).digest('hex');
module.exports={DEVICE_CODEX_PROTOCOL,DEVICE_CODEX_CAPABILITY,DEVICE_CODEX_JOB,deviceCodexCandidateIdentity,normalizeDeviceCodexPayload,normalizeDeviceCodexRequest,normalizeDeviceCodexContext,normalizeDeviceCodexResult,deviceCodexResultDigest};
