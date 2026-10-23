'use strict';
const {createHash}=require('node:crypto');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const SCAN_WARNINGS=['read-failed','invalid-json','unsafe-path','source-changed','file-reference-not-expanded','env-reference-not-expanded','ancestor-config-not-scanned','organization-config-not-scanned','managed-preferences-not-scanned','entry-limit','ambiguous-config'];
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=scan=>{const {digest:_digest,...publicScan}=scan;return createHash('sha256').update(JSON.stringify(canonical(publicScan))).digest('hex');};
const bounded=(value,min,max,integer=false)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max&&(!integer||Number.isInteger(value));
const validOptions=value=>object(value)&&Object.entries(value).every(([key,option])=>key==='apiFormat'?['chat-completions','responses'].includes(option)
 :key==='reasoningEffort'?value.apiFormat==='responses'&&['none','minimal','low','medium','high','xhigh','max'].includes(option)
 :key==='store'?value.apiFormat==='responses'&&typeof option==='boolean'
 :key==='temperature'?bounded(option,0,2):key==='topP'?bounded(option,0,1):key==='contextWindow'?bounded(option,128,2097152,true):key==='maxOutputTokens'&&bounded(option,1,32768,true));
const validIssues=value=>Array.isArray(value)&&value.length>0&&value.length<=100&&value.every(item=>exact(item,['name','type'])
 &&typeof item.name==='string'&&/^(?:[a-zA-Z0-9_.-]{1,80}|\[недопустимое имя\])$/.test(item.name)&&['null','array','object','string','number','boolean','undefined'].includes(item.type));
/** Discovery happens on a computer; these transports cannot be moved to the server by copying a URL. */
function serverImportBlocker(candidate){
 if(candidate.provider==='codexbridge')return 'codex-local-auth';
 try{const url=new URL(candidate.baseUrl),host=url.hostname.toLowerCase();
  if(host==='chatgpt.com'&&/^\/backend-api\/codex(?:\/|$)/.test(url.pathname))return 'codex-local-auth';
  if(host==='localhost'||host==='localhost.'||host==='[::1]'||/^127\./.test(host))return 'device-local-endpoint';
 }catch{/* Missing and invalid endpoints have their own diagnostics. */}
 return null;
}
/** Exact metadata schema excludes API keys, auth contents, arbitrary paths and configuration fragments. */
function validModelScan(scan,source){
 const global=object(scan)&&scan.scope==='global';
 const sourceFields=global?['deviceId']:['projectId','bindingId','instanceId'];
 if(!exact(scan,['schemaVersion','scope',...sourceFields,'scanId','checkedAt','expiresAt','warnings','candidates','digest'])||scan.schemaVersion!==2||scan.scope!==source.scope
  ||(global?scan.deviceId!==source.deviceId||!uuid(scan.deviceId):scan.scope!=='project'||!text(scan.projectId,200)||scan.projectId!==source.projectId||scan.bindingId!==source.bindingId||scan.instanceId!==source.instanceId||!sha(scan.bindingId)||!uuid(scan.instanceId))||!uuid(scan.scanId)
  ||!iso(scan.checkedAt)||!iso(scan.expiresAt)||Date.parse(scan.expiresAt)-Date.parse(scan.checkedAt)!==900000||!sha(scan.digest)||digest(scan)!==scan.digest
  ||!Array.isArray(scan.warnings)||scan.warnings.length>SCAN_WARNINGS.length||scan.warnings.some(value=>!SCAN_WARNINGS.includes(value))
  ||!Array.isArray(scan.candidates)||scan.candidates.length>100||Buffer.byteLength(JSON.stringify(scan))>128*1024)return false;
 const ids=new Set();
 for(const item of scan.candidates){
  const keys=['candidateId','provider','name','model','modelVersion','capability','runtime','baseUrl','hasKey','credentialSource','blocker',...(object(item)&&Object.hasOwn(item,'configKey')?['configKey']:[]),...(object(item)&&Object.hasOwn(item,'outputTokenLimit')?['outputTokenLimit']:[]),...(object(item)&&Object.hasOwn(item,'options')?['options']:[]),...(object(item)&&Object.hasOwn(item,'parameterIssues')?['parameterIssues']:[]),...(object(item)&&Object.hasOwn(item,'timeoutMs')?['timeoutMs']:[])];
  if(!exact(item,keys)||!uuid(item.candidateId)||ids.has(item.candidateId)
   ||!text(item.provider,128)||!text(item.name,128)||!text(item.model,200)||!text(item.modelVersion,128)||!['chat','vision'].includes(item.capability)
   ||![null,'remote-openai','remote-ollama'].includes(item.runtime)||typeof item.hasKey!=='boolean'||!['none','inline','environment','file','auth'].includes(item.credentialSource)
   ||![null,'unsupported-provider','missing-endpoint','unresolved-endpoint','unsafe-endpoint','disabled-provider','codex-local-auth','local-provider-auth','device-local-endpoint'].includes(item.blocker)
   ||Object.hasOwn(item,'outputTokenLimit')&&!bounded(item.outputTokenLimit,1,2097152,true)||Object.hasOwn(item,'configKey')&&!text(item.configKey,128)||Object.hasOwn(item,'options')&&!validOptions(item.options)||Object.hasOwn(item,'timeoutMs')&&!bounded(item.timeoutMs,1000,300000,true))return false;
  if(Object.hasOwn(item,'parameterIssues')&&(!item.blocker||!validIssues(item.parameterIssues)))return false;
  if(item.baseUrl!==null){try{const url=new URL(item.baseUrl);if(!text(item.baseUrl,1024)||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return false;}catch{return false;}}
  if(!item.blocker&&(!item.runtime||!item.baseUrl))return false;
  if(!item.blocker&&serverImportBlocker(item))return false;
  ids.add(item.candidateId);
 }
 return true;
}
module.exports={modelScanDigest:digest,validModelScan,validModelOptions:validOptions,serverImportBlocker,SCAN_WARNINGS};
