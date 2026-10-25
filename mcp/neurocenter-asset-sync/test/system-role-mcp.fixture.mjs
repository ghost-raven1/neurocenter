import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
await fs.writeFile('tool.pid',String(process.pid));
const server=new Server({name:'role-mcp-test-fixture',version:'1'},{capabilities:{tools:{}}});
let current='about:blank';
const definitions=[
 {name:'browser_navigate',description:'Synthetic test state only',inputSchema:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}},
 {name:'browser_snapshot',description:'Read synthetic test state',inputSchema:{type:'object',properties:{large:{type:'boolean'}},additionalProperties:false}},
 {name:'browser_slow',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'browser_disconnect',inputSchema:{type:'object',properties:{},additionalProperties:false}},
];
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:definitions}));
server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
 await fs.appendFile('calls.txt',request.params.name+'\n');
 if(request.params.name==='browser_navigate'){current=request.params.arguments.url;return {content:[{type:'text',text:'Navigated fixture state'}]};}
 if(request.params.name==='browser_snapshot')return {content:[{type:'text',text:request.params.arguments?.large?'x'.repeat(100000):current+'\n'+process.argv.slice(2).join('\n')}]};
 if(request.params.name==='browser_disconnect'){setTimeout(()=>process.exit(0),1);await new Promise(()=>{});}
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','--','--owned-fixture',process.env.ROLE_MCP_FIXTURE_NONCE??'fixture'],{stdio:'ignore',detached:process.argv.includes('--detached-child')});
 await fs.writeFile('descendant.pid',String(child.pid));
 await new Promise((resolve,reject)=>{extra.signal.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true});});
 return {content:[]};
});
await server.connect(new StdioServerTransport());
