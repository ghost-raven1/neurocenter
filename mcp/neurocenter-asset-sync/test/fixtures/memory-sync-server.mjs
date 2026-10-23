import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

// This isolated protocol fixture uses the pinned Memory1.0.0 input ABI, without reading a graph file.
const graph=new Map(),entity=z.object({name:z.string(),entityType:z.string(),observations:z.array(z.string())});
const server=new McpServer({name:'memory-sync-fixture',version:'1.0.0'});
const reply=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
server.registerTool('open_nodes',{inputSchema:{names:z.array(z.string())}},async({names})=>reply({entities:names.flatMap(name=>graph.has(name)?[graph.get(name)]:[]),relations:[]}));
server.registerTool('create_entities',{inputSchema:{entities:z.array(entity)}},async({entities})=>{for(const item of entities)if(!graph.has(item.name))graph.set(item.name,item);return reply({});});
server.registerTool('add_observations',{inputSchema:{observations:z.array(z.object({entityName:z.string(),contents:z.array(z.string())}))}},async({observations})=>{
 for(const input of observations){const item=graph.get(input.entityName);if(!item)throw new Error('Missing fixture entity');item.observations=[...new Set([...item.observations,...input.contents])];}return reply({});
});
server.registerTool('delete_observations',{inputSchema:{deletions:z.array(z.object({entityName:z.string(),observations:z.array(z.string())}))}},async({deletions})=>{
 for(const input of deletions){const item=graph.get(input.entityName);if(item)item.observations=item.observations.filter(text=>!input.observations.includes(text));}return reply({});
});
await server.connect(new StdioServerTransport());
