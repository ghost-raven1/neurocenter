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
/** Exact metadata schema excludes API keys, auth contents, arbitrary paths and configuration fragments. */
function validModelScan(scan,source){
 if(!exact(scan,['schemaVersion','projectId','bindingId','instanceId','scanId','checkedAt','expiresAt','warnings','candidates','digest'])||scan.schemaVersion!==1
  ||scan.projectId!==source.projectId||scan.bindingId!==source.bindingId||scan.instanceId!==source.instanceId||!sha(scan.bindingId)||!uuid(scan.instanceId)||!uuid(scan.scanId)
  ||!iso(scan.checkedAt)||!iso(scan.expiresAt)||Date.parse(scan.expiresAt)-Date.parse(scan.checkedAt)!==900000||!sha(scan.digest)||digest(scan)!==scan.digest
  ||!Array.isArray(scan.warnings)||scan.warnings.length>SCAN_WARNINGS.length||scan.warnings.some(value=>!SCAN_WARNINGS.includes(value))
  ||!Array.isArray(scan.candidates)||scan.candidates.length>100||Buffer.byteLength(JSON.stringify(scan))>128*1024)return false;
 const ids=new Set();
 for(const item of scan.candidates){
  if(!exact(item,['candidateId','provider','name','model','modelVersion','capability','runtime','baseUrl','hasKey','credentialSource','blocker'])||!uuid(item.candidateId)||ids.has(item.candidateId)
   ||!text(item.provider,128)||!text(item.name,128)||!text(item.model,200)||!text(item.modelVersion,128)||!['chat','vision'].includes(item.capability)
   ||![null,'remote-openai','remote-ollama'].includes(item.runtime)||typeof item.hasKey!=='boolean'||!['none','inline','environment','file','auth'].includes(item.credentialSource)
   ||![null,'unsupported-provider','missing-endpoint','unresolved-endpoint','unsafe-endpoint','disabled-provider'].includes(item.blocker))return false;
  if(item.baseUrl!==null){try{const url=new URL(item.baseUrl);if(!text(item.baseUrl,1024)||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return false;}catch{return false;}}
  if(!item.blocker&&(!item.runtime||!item.baseUrl))return false;
  ids.add(item.candidateId);
 }
 return true;
}
module.exports={modelScanDigest:digest,validModelScan,SCAN_WARNINGS};
