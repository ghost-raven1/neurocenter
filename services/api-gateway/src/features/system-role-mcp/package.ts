import {BadRequestException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import {normalizeRuntimeArtifacts} from '../../../../shared/runtime-artifacts.cjs';
import {systemRoleMcpDigest,roleMcpProducer} from '../../../../shared/system-role-mcp.cjs';
import {hostRuntimeTarget} from '../mcp-host/host-target';
import type {HostedMcpClaim} from '../mcp-host/ticket';
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const invalid=()=>new BadRequestException('Нужен закреплённый серверный пакет MCP с проверенным комплектом.');
/** Internal catalogue pins replace arbitrary commands, endpoints and configuration on the server host. */
export function roleHostedPackage(raw:unknown,sessionId:string,target=hostRuntimeTarget()):HostedMcpClaim {
 if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(sessionId)||!object(raw)||![4,5].includes(raw.schemaVersion)||!object(raw.plugin)||!['mcp','plugin'].includes(raw.plugin.kind)
  ||!object(raw.config)||!['local','stdio','remote'].includes(raw.config.transport??'local')
  ||raw.config.extra?.localConfiguration||Object.keys(raw.config.env??{}).length
  ||!object(raw.manifest)||!Array.isArray(raw.files)||raw.files.length!==raw.manifest.filesCount||raw.files.length>20000
  ||typeof raw.plugin.id!=='string'||!raw.plugin.id||typeof raw.plugin.name!=='string'||!raw.plugin.name||raw.plugin.name.length>200
  ||!Number.isSafeInteger(raw.plugin.version)||raw.plugin.version<1||!/^([a-f0-9]{64})$/.test(raw.manifest.sha256))throw invalid();
 const paths=new Set<string>();let total=0;
 for(const file of raw.files){
  if(!object(file)||typeof file.path!=='string'||!file.path||paths.has(file.path)||typeof file.content!=='string'||![undefined,'base64'].includes(file.encoding)
   ||!Number.isSafeInteger(file.size)||file.size<0||file.size>1024*1024)throw invalid();
  paths.add(file.path);const bytes=Buffer.from(file.content,file.encoding==='base64'?'base64':'utf8');total+=bytes.length;
  if(total>8*1024*1024||bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==file.sha256
   ||file.encoding==='base64'&&bytes.toString('base64')!==file.content)throw invalid();
 }
 const content={schemaVersion:raw.schemaVersion,plugin:raw.plugin,config:raw.config,
  files:raw.files.map(({path,size,sha256,encoding}:any)=>({path,size,sha256,...(encoding?{encoding}:{})})).sort((a:any,b:any)=>a.path<b.path?-1:a.path>b.path?1:0)};
 if(systemRoleMcpDigest(content)!==raw.manifest.sha256)throw invalid();
 let producer;try{producer=roleMcpProducer(raw);}catch{throw invalid();}if(!producer)throw invalid();
 if(!Array.isArray(producer.args)||producer.args.length>64||producer.args.some(arg=>typeof arg!=='string'||arg.includes('\0')||Buffer.byteLength(arg)>8192))throw invalid();
 if(raw.config.transport==='remote'){
  let url:URL;try{url=new URL(raw.config.url);}catch{throw invalid();}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hash)throw invalid();
  const headers:Record<string,string>={};
  if(raw.config.headers!==undefined&&!object(raw.config.headers))throw invalid();
  for(const [key,value]of Object.entries(raw.config.headers??{})){
   if(typeof value!=='string'||Buffer.byteLength(value)>8192||/\{env:|\$\{/.test(value)||key.length>256||/authorization|cookie|api.?key|token|secret|credential/i.test(key))throw invalid();headers[key]=value;
  }
  try{new Headers(headers);}catch{throw invalid();}
  return {artifactSha256:raw.manifest.sha256,entrypoint:'',executable:false,name:raw.plugin.name,compressedBytes:0,
   operationSessionId:sessionId,operationRemote:{url:url.href,headers},exp:Date.now()+120000};
 }
 if(raw.schemaVersion!==5||raw.config.extra?.hostedMcp!==true&&producer.assetKind!=='plugin')throw invalid();
 let artifacts;try{artifacts=normalizeRuntimeArtifacts(raw.config.extra.runtimeArtifacts);}catch{throw invalid();}
 const artifact=artifacts.find(item=>item.target===target);if(!artifact)throw invalid();
 return {artifactSha256:artifact.sha256,entrypoint:producer.assetKind==='plugin'?producer.entrypoint!:artifact.entrypoint,
  executable:producer.assetKind==='plugin'?false:artifact.executable??false,name:raw.plugin.name,operationArgs:producer.args,
  compressedBytes:artifact.compressedBytes,unpackedBytes:artifact.unpackedBytes,filesCount:artifact.filesCount,operationSessionId:sessionId,exp:Date.now()+120000};
}
