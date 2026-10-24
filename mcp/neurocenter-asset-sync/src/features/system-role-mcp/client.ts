import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {Package} from '../../bridge/package.js';
import {ProbeScope} from '../runtime-probe/process.js';
import {ProbeStdioTransport} from '../runtime-probe/mcp-transport.js';
import {SYSTEM_ROLE_MCP_LIMITS as limits,normalizeRoleMcpDiscovery,normalizeRoleMcpOutput,boundedMcpJson,type RoleMcpTool,type RoleMcpOutput} from './contract.js';

export interface RoleMcpLaunch {pkg:Package;command?:string;args?:string[];cwd:string;env:NodeJS.ProcessEnv;headers?:Record<string,string>}
export interface RoleMcpPort {list():Promise<RoleMcpTool[]>;call(name:string,schemaDigest:string,args:Record<string,unknown>,dispatch:()=>Promise<void>):Promise<RoleMcpOutput>;close():Promise<void>}
export const roleMcpOutput=normalizeRoleMcpOutput;

/** A run owns one transport. Existing process-group primitives close all descendants on cancellation or loss of authority. */
export async function connectRoleMcp(launch:RoleMcpLaunch,signal:AbortSignal,authorize:()=>Promise<void>):Promise<RoleMcpPort>{
 signal.throwIfAborted();const scope=new ProbeScope(limits.sessionMs),client=new Client({name:'neurocenter-system-role',version:'1'},{capabilities:{}});
 let transport:Transport;
 const abort=()=>scope.close();signal.addEventListener('abort',abort,{once:true});
 const active=async()=>{signal.throwIfAborted();scope.remaining();await authorize();signal.throwIfAborted();};
 try{
  await active();
  if(launch.pkg.config?.transport==='remote'){
   const url=new URL(launch.pkg.config.url??'');
   if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw new Error('Не задан точный адрес MCP из закреплённого пакета.');
   let received=0;
   transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:launch.headers,redirect:'error'},
    reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1,maxReconnectionDelay:1,reconnectionDelayGrowFactor:1},
    fetch:async(input,init)=>{
     await active();if(new URL(input).href!==url.href)throw new Error('MCP изменил адрес транспорта.');
     const response=await fetch(input,{...init,redirect:'error',signal:AbortSignal.any([scope.controller.signal,signal,...(init?.signal?[init.signal]:[])])});
     const body=response.body?.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){
      received+=chunk.byteLength;if(received>8*1024*1024)throw new Error('MCP превысил предел транспорта.');controller.enqueue(chunk);
     }}));
     return new Response(body??null,{status:response.status,statusText:response.statusText,headers:response.headers});
    }});
  }else{
   if(!launch.command||!launch.args)throw new Error('Не подтверждён установленный комплект MCP.');
   transport=new ProbeStdioTransport(scope,launch.command,launch.args,launch.cwd,launch.env,active);
  }
  const callSignal=AbortSignal.any([signal,scope.controller.signal]);
  await scope.wait(client.connect(transport,{signal:callSignal,timeout:limits.connectMs}));
  const list=async()=>{
   const tools:unknown[]=[],seen=new Set<string>();let cursor:string|undefined;
   for(let page=0;page<limits.pages;page++){
    await active();const data=await scope.wait(client.listTools(cursor?{cursor}:undefined,{signal:callSignal,timeout:limits.callMs}));
    tools.push(...data.tools);if(tools.length>limits.discoveredTools)throw new Error('MCP объявил слишком много инструментов.');
    cursor=data.nextCursor;if(!cursor)return normalizeRoleMcpDiscovery(tools);
    if(seen.has(cursor))throw new Error('MCP повторил страницу инструментов.');seen.add(cursor);
   }
   throw new Error('Список инструментов MCP превысил предел страниц.');
  };
  const validator=new AjvJsonSchemaValidator();
  return {list,async call(name,schemaDigest,args,dispatch){
   const tool=(await list()).find(item=>item.name===name&&item.schemaDigest===schemaDigest);
   if(!tool)throw new Error('Инструмент или его схема изменились. Обнаружьте MCP заново.');
   boundedMcpJson(args,limits.argumentsBytes);
   if(!validator.getValidator(tool.inputSchema)(args).valid)throw new Error('Аргументы не соответствуют обнаруженной схеме MCP.');
   await active();await dispatch();callSignal.throwIfAborted();
   return roleMcpOutput(await scope.wait(client.callTool({name,arguments:args},undefined,{signal:callSignal,timeout:limits.callMs})));
  },async close(){signal.removeEventListener('abort',abort);scope.close();await client.close().catch(()=>{});await transport.close().catch(()=>{});}};
 }catch(error){signal.removeEventListener('abort',abort);scope.close();await client.close().catch(()=>{});throw error;}
}
