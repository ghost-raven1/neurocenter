import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {MEMORY_SYNC_LIMITS as limits,type MemoryEntity} from './contract.js';

export interface MemoryPort {nodes(names:string[]):Promise<MemoryEntity[]>;create(entity:MemoryEntity):Promise<void>;add(name:string,observations:string[]):Promise<void>;remove(name:string,observations:string[]):Promise<void>;close():Promise<void>}
const tools=['open_nodes','create_entities','add_observations','delete_observations'];
/** Every read names only this projection's entities; read_graph and arbitrary tool invocation are absent. */
export async function connectMemory(entrypoint:string,cwd:string,signal:AbortSignal):Promise<MemoryPort>{
 signal.throwIfAborted();
 const client=new Client({name:'neurocenter-learning-memory',version:'1.0.0'},{capabilities:{}});
 const transport=new StdioClientTransport({command:process.execPath,args:[entrypoint],cwd,env:{NODE_ENV:'production'},stderr:'pipe'});
 try{
  await client.connect(transport,{signal,timeout:10000});transport.stderr?.on('data',()=>{});
  const listed=await client.listTools({}, {signal,timeout:10000});
  if(tools.some(name=>!listed.tools.some(tool=>tool.name===name)))throw new Error('Версия Memory не поддерживает управляемую синхронизацию.');
  const call=async(name:string,args:Record<string,unknown>)=>{
   signal.throwIfAborted();const result=await client.callTool({name,arguments:args},undefined,{signal,timeout:10000});
   if(result.isError)throw new Error('Memory не подтвердил изменение. Проверьте сохранённый план.');return result;
  };
  return {
   async nodes(names){
    if(names.length>32||new Set(names).size!==names.length)throw new Error('Неверный ограниченный запрос Memory.');
    if(!names.length)return [];
    const result=await call('open_nodes',{names});
    if(!Array.isArray(result.content)||result.content.some(item=>!item||typeof item!=='object'||item.type!=='text'||typeof item.text!=='string'))throw new Error('Memory вернул неподдерживаемый ответ.');
    const raw=result.content.map(item=>item.text as string).join('\n');
    if(Buffer.byteLength(raw)>limits.readResponseBytes)throw Object.assign(new Error('Ответ Memory превышает квоту.'),{code:'quota'});
    const graph=JSON.parse(raw) as {entities?:MemoryEntity[]};
    if(!Array.isArray(graph.entities)||graph.entities.length>names.length||new Set(graph.entities.map(entity=>entity.name)).size!==graph.entities.length
     ||graph.entities.some(entity=>!entity||!names.includes(entity.name)||typeof entity.entityType!=='string'||!Array.isArray(entity.observations)||entity.observations.length>512
      ||entity.observations.some(value=>typeof value!=='string'||Buffer.byteLength(value)>128*1024)))throw new Error('Memory вернул данные вне выбранных управляемых записей.');
    return graph.entities;
   },
   async create(entity){await call('create_entities',{entities:[entity]});},
   async add(entityName,contents){await call('add_observations',{observations:[{entityName,contents}]});},
   async remove(entityName,observations){await call('delete_observations',{deletions:[{entityName,observations}]});},
   async close(){await client.close().catch(()=>{});await transport.close().catch(()=>{});},
  };
 }catch(error){await client.close().catch(()=>{});await transport.close().catch(()=>{});throw error;}
}
