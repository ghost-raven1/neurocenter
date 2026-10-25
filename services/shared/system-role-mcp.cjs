'use strict';
const {createHash}=require('node:crypto');
const {localRagCore}=require('./rag-core-contract.cjs');

const SYSTEM_ROLE_MCP_JOB='system-role-mcp-session';
const SYSTEM_ROLE_MCP_CAPABILITY='system-role-mcp-v2';
/** Initial verified execution bounds, shared by admission, transport and the role loop. */
const SYSTEM_ROLE_MCP_LIMITS=Object.freeze({targets:2,selectedTools:8,discoveredTools:128,pages:8,calls:6,
 schemaBytes:16384,discoveryBytes:262144,argumentsBytes:16384,outputBytes:65536,contextBytes:32768,
 sessionMs:120000,callMs:20000,connectMs:15000,discoveryTtlMs:300000});
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const text=(value,max)=>typeof value==='string'&&!!value.trim()&&!value.includes('\0')&&Buffer.byteLength(value)<=max;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const invalid=()=>{throw new Error('Нужен точный выбор обнаруженных MCP и инструментов выбранного проекта.');};
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.entries(value)
 .filter(([,item])=>item!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
const systemRoleMcpDigest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const toolName=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value);

/** JSON stays bounded before schema compilation and cannot contain runtime objects or non-finite numbers. */
function boundedMcpJson(value,maxBytes){
 let elements=0;
 const visit=(item,depth)=>{
  if(++elements>2048||depth>16)invalid();
  if(item===null||typeof item==='boolean'||typeof item==='string')return;
  if(typeof item==='number'&&Number.isFinite(item))return;
  if(Array.isArray(item)){for(const entry of item)visit(entry,depth+1);return;}
  if(object(item)&&[Object.prototype,null].includes(Object.getPrototypeOf(item))){for(const [key,entry]of Object.entries(item)){if(key.includes('\0'))invalid();visit(entry,depth+1);}return;}
  invalid();
 };
 visit(value,0);if(Buffer.byteLength(JSON.stringify(value))>maxBytes)invalid();return structuredClone(value);
}
function normalizeRoleMcpTarget(raw,selected=true){
 const common=['runtime','assetId','assetKind','version','manifest',...(selected?['discoveryId','tools']:[])];
 const local=['deviceId','bindingId','instanceId','configurationRevisions'];
 if(!exact(raw,[...common,...(raw?.runtime==='device'?local:[])])||!['server','device'].includes(raw.runtime)
  ||!text(raw.assetId,200)||raw.assetKind!==undefined&&!['mcp','plugin'].includes(raw.assetKind)||!Number.isSafeInteger(raw.version)||raw.version<1||!sha(raw.manifest))invalid();
 const value={runtime:raw.runtime,assetId:raw.assetId,...(raw.assetKind==='plugin'?{assetKind:'plugin'}:{}),version:raw.version,manifest:raw.manifest};
 if(raw.runtime==='device'){
  if(!uuid(raw.deviceId)||!text(raw.bindingId,200)||!text(raw.instanceId,200)||!Array.isArray(raw.configurationRevisions)||raw.configurationRevisions.length>20)invalid();
  const revisions=raw.configurationRevisions.map(item=>{
   if(!exact(item,['assetId','manifest','revision'])||!text(item.assetId,200)||!sha(item.manifest)||item.revision!==null&&!uuid(item.revision))invalid();
   return {assetId:item.assetId,manifest:item.manifest,revision:item.revision};
  }).sort((a,b)=>a.assetId.localeCompare(b.assetId));
  if(new Set(revisions.map(item=>item.assetId)).size!==revisions.length)invalid();
  Object.assign(value,{deviceId:raw.deviceId,bindingId:raw.bindingId,instanceId:raw.instanceId,configurationRevisions:revisions});
 }
 if(selected){
  if(!uuid(raw.discoveryId)||!Array.isArray(raw.tools)||!raw.tools.length||raw.tools.length>SYSTEM_ROLE_MCP_LIMITS.selectedTools)invalid();
  const tools=raw.tools.map(item=>{if(!exact(item,['name','schemaDigest'])||!toolName(item.name)||!sha(item.schemaDigest))invalid();return {name:item.name,schemaDigest:item.schemaDigest};})
   .sort((a,b)=>a.name.localeCompare(b.name));
  if(new Set(tools.map(item=>item.name)).size!==tools.length)invalid();Object.assign(value,{discoveryId:raw.discoveryId,tools});
 }
 return value;
}
function normalizeRoleMcpSelection(value){
 if(value===undefined)return undefined;
 if(!Array.isArray(value)||value.length>SYSTEM_ROLE_MCP_LIMITS.targets)invalid();
 const targets=value.map(item=>normalizeRoleMcpTarget(item));
 if(targets.reduce((sum,item)=>sum+item.tools.length,0)>SYSTEM_ROLE_MCP_LIMITS.selectedTools
  ||new Set(targets.map(item=>item.assetId)).size!==targets.length)invalid();
 return targets.sort((a,b)=>a.assetId.localeCompare(b.assetId));
}
const roleMcpToolKey=(target,name)=>systemRoleMcpDigest({runtime:target.runtime,assetId:target.assetId,version:target.version,manifest:target.manifest,
 ...(target.assetKind==='plugin'?{assetKind:'plugin'}:{}),
 ...(target.runtime==='device'?{deviceId:target.deviceId,bindingId:target.bindingId,instanceId:target.instanceId}:{}),name});
/** Only an explicit verified producer ABI can expose MCP from an asset whose catalogue kind is plugin. */
function roleMcpProducer(pkg){
 if(pkg?.plugin?.kind==='mcp')return {assetKind:'mcp',entrypoint:pkg.config?.entrypoint,args:pkg.config?.args??[]};
 if(pkg?.plugin?.kind==='plugin'){
  const core=localRagCore(pkg);if(core)return {assetKind:'plugin',entrypoint:core.entrypoint,args:['mcp']};
 }
 return undefined;
}
/** The digest covers the actual server schema and annotations, including changes at an unchanged package version. */
function normalizeRoleMcpTool(raw){
 if(!object(raw)||!toolName(raw.name)||raw.description!==undefined&&!text(raw.description,8192)||!object(raw.inputSchema)||raw.inputSchema.type!=='object'
  ||raw.execution?.taskSupport==='required')invalid();
 const tool={name:raw.name,description:raw.description??raw.name,inputSchema:boundedMcpJson(raw.inputSchema,SYSTEM_ROLE_MCP_LIMITS.schemaBytes),
  ...(raw.outputSchema?{outputSchema:boundedMcpJson(raw.outputSchema,SYSTEM_ROLE_MCP_LIMITS.schemaBytes)}:{}),
  ...(raw.annotations?{annotations:boundedMcpJson(raw.annotations,4096)}:{})};
 return {...tool,schemaDigest:systemRoleMcpDigest(tool)};
}
function normalizeRoleMcpDiscovery(raw){
 if(!Array.isArray(raw)||raw.length>SYSTEM_ROLE_MCP_LIMITS.discoveredTools)invalid();
 const tools=raw.map(normalizeRoleMcpTool).sort((a,b)=>a.name.localeCompare(b.name));
 if(new Set(tools.map(item=>item.name)).size!==tools.length||Buffer.byteLength(JSON.stringify(tools))>SYSTEM_ROLE_MCP_LIMITS.discoveryBytes)invalid();
 return tools;
}
function roleMcpCommand(content,tools){
 if(typeof content!=='string'||Buffer.byteLength(content)>SYSTEM_ROLE_MCP_LIMITS.argumentsBytes+1024)invalid();
 let raw;try{raw=JSON.parse(content);}catch{invalid();}
 if(exact(raw,['kind'])&&raw.kind==='finish')return {kind:'finish'};
 if(!exact(raw,['kind','toolKey','arguments'])||raw.kind!=='tool'||!sha(raw.toolKey)||!object(raw.arguments)||!tools.some(item=>item.toolKey===raw.toolKey))invalid();
 return {kind:'tool',toolKey:raw.toolKey,arguments:boundedMcpJson(raw.arguments,SYSTEM_ROLE_MCP_LIMITS.argumentsBytes)};
}
/** Successful execution is not replayed merely because its display output needs truncation. */
function normalizeRoleMcpOutput(raw){
 if(!object(raw)||!Array.isArray(raw.content))invalid();
 let text='',truncated=false;
 for(const item of raw.content){
  if(!object(item))continue;
  if(item.type!=='text')truncated=true;
  const value=item.type==='text'&&typeof item.text==='string'?item.text:`[Содержимое MCP: ${String(item.type).slice(0,40)}]`;
  const remaining=SYSTEM_ROLE_MCP_LIMITS.outputBytes-Buffer.byteLength(text)-4;
  if(remaining<=0){truncated=true;break;}
  const bytes=Buffer.from(value);text+=(text?'\n':'')+bytes.subarray(0,remaining).toString('utf8');
  if(bytes.length>remaining){truncated=true;break;}
 }
 let structuredContent;
 if(raw.structuredContent!==undefined){try{structuredContent=boundedMcpJson(raw.structuredContent,SYSTEM_ROLE_MCP_LIMITS.outputBytes-Buffer.byteLength(text));}catch{truncated=true;}}
 return {text,isError:raw.isError===true,truncated,...(structuredContent!==undefined?{structuredContent}:{})};
}
/** Private acknowledgements carry bounded data; late acknowledgements use this same validator without reopening work. */
function normalizeRoleMcpResult(raw,kind){
 if(!exact(raw,['state','value','message'])||!['succeeded','failed','unknown'].includes(raw.state))invalid();
 if(raw.state!=='succeeded'){
  if(!text(raw.message,2048)||raw.value!==undefined)invalid();return {state:raw.state,message:raw.message};
 }
 if(raw.message!==undefined)invalid();
 if(kind==='list'){
  if(!exact(raw.value,['tools']))invalid();return {state:'succeeded',value:{tools:normalizeRoleMcpDiscovery(raw.value.tools)}};
 }
 const value=raw.value;
 if(!exact(value,['text','isError','truncated','structuredContent'])||typeof value.text!=='string'||Buffer.byteLength(value.text)>SYSTEM_ROLE_MCP_LIMITS.outputBytes
  ||typeof value.isError!=='boolean'||typeof value.truncated!=='boolean')invalid();
 const result={text:value.text,isError:value.isError,truncated:value.truncated,...(value.structuredContent!==undefined?
  {structuredContent:boundedMcpJson(value.structuredContent,SYSTEM_ROLE_MCP_LIMITS.outputBytes-Buffer.byteLength(value.text))}:{})};
 return {state:'succeeded',value:result};
}
module.exports={SYSTEM_ROLE_MCP_JOB,SYSTEM_ROLE_MCP_CAPABILITY,SYSTEM_ROLE_MCP_LIMITS,systemRoleMcpDigest,boundedMcpJson,
 normalizeRoleMcpTarget,normalizeRoleMcpSelection,normalizeRoleMcpTool,normalizeRoleMcpDiscovery,normalizeRoleMcpOutput,normalizeRoleMcpResult,roleMcpProducer,roleMcpToolKey,roleMcpCommand};
