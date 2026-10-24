import fs from 'node:fs/promises';
import {watch} from 'node:fs';
import path from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

// Only the test-owned cwd is used. A new SDK process sees the same durable graph.
const root=process.cwd(),file=name=>path.join(root,name);
const control=JSON.parse(await fs.readFile(file('control.json'),'utf8'));
if(control.fixture!=='memory-sync-durable-v1')throw new Error('Missing durable fixture ownership marker');
async function publish(name,value){
 const temporary=file(name+'.tmp'),handle=await fs.open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
 await fs.rename(temporary,file(name));
 const directory=await fs.open(root,'r');try{await directory.sync();}finally{await directory.close();}
}
async function event(value){
 const handle=await fs.open(file('events.jsonl'),'a',0o600);
 try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}
}
async function graph(){return JSON.parse(await fs.readFile(file('graph.json'),'utf8'));}
async function released(){try{await fs.access(file('release-ack'));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
/** The barrier is published only after graph and invocation count are durable. */
async function holdAck(){
 await publish('create-held.json',{pid:process.pid});
 await new Promise((resolve,reject)=>{
  const watcher=watch(root,()=>{void check();});
  watcher.on('error',error=>{watcher.close();reject(error);});
  async function check(){try{if(await released()){watcher.close();resolve();}}catch(error){watcher.close();reject(error);}}
  void check();
 });
}
await event({kind:'connect',pid:process.pid});
const entity=z.object({name:z.string(),entityType:z.string(),observations:z.array(z.string())});
const server=new McpServer({name:'memory-sync-durable-fixture',version:'1.0.0'});
const reply=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
server.registerTool('open_nodes',{inputSchema:{names:z.array(z.string())}},async({names})=>{
 const saved=await graph();await event({kind:'open',names});
 return reply({entities:saved.entities.filter(item=>names.includes(item.name)),relations:[]});
});
server.registerTool('create_entities',{inputSchema:{entities:z.array(entity)}},async({entities})=>{
 const saved=await graph();for(const item of entities)if(!saved.entities.some(existing=>existing.name===item.name))saved.entities.push(item);
 await publish('graph.json',saved);await event({kind:'create',names:entities.map(item=>item.name)});
 if(control.holdCreateAck)await holdAck();
 await event({kind:'create-ack'});return reply({});
});
server.registerTool('add_observations',{inputSchema:{observations:z.array(z.object({entityName:z.string(),contents:z.array(z.string())}))}},async({observations})=>{
 const saved=await graph();for(const input of observations){const item=saved.entities.find(item=>item.name===input.entityName);if(!item)throw new Error('Missing fixture entity');item.observations=[...new Set([...item.observations,...input.contents])];}
 await publish('graph.json',saved);await event({kind:'add'});return reply({});
});
server.registerTool('delete_observations',{inputSchema:{deletions:z.array(z.object({entityName:z.string(),observations:z.array(z.string())}))}},async({deletions})=>{
 const saved=await graph();for(const input of deletions){const item=saved.entities.find(item=>item.name===input.entityName);if(item)item.observations=item.observations.filter(value=>!input.observations.includes(value));}
 await publish('graph.json',saved);await event({kind:'remove'});return reply({});
});
await server.connect(new StdioServerTransport());
