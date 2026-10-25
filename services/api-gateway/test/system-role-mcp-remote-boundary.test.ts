import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it} from 'vitest';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {buildPackage} from '../../catalog-service/src/catalog/bundle-package';
import {roleHostedPackage} from '../src/features/system-role-mcp/package';
import {McpHostService} from '../src/features/mcp-host/host';

describe('server role actual StreamableHTTP MCP boundary (owned fixture)',()=>{
 let listener:http.Server|undefined,host:McpHostService|undefined,server:Server|undefined;
 afterEach(async()=>{await host?.onModuleDestroy();await server?.close();if(listener){listener.closeAllConnections();await new Promise<void>(resolve=>listener!.close(()=>resolve()));}});
 it('performs initialize, actual discovery and useful stateful tool calls through the same generic host',async()=>{
  server=new Server({name:'owned-http-fixture',version:'1'},{capabilities:{tools:{}}});let state='initial';
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'set_value',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},description:'Fixture write'},
   {name:'read_value',inputSchema:{type:'object',properties:{}},description:'Fixture read'}]}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{if(request.params.name==='set_value')state=String(request.params.arguments?.value);return {content:[{type:'text',text:state}]};});
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID()});await server.connect(transport);
  listener=http.createServer(async(req,res)=>{
   try{
    const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const text=Buffer.concat(parts).toString();
    await transport.handleRequest(req,res,text?JSON.parse(text):undefined);
   }catch{if(!res.headersSent)res.writeHead(500);res.end();}
  });
  await new Promise<void>(resolve=>listener!.listen(0,'127.0.0.1',resolve));const address=listener.address()as {port:number};
  const pkg=buildPackage({id:'remote-fixture',name:'Owned remote fixture',kind:'mcp',version:1},[],'',{transport:'remote',url:'http://127.0.0.1:'+address.port+'/mcp'});
  const claim=roleHostedPackage(pkg,randomUUID());host=new McpHostService('http://catalog.invalid','fixture-token');const signal=AbortSignal.timeout(10000);
  expect((await host.operationTools(claim,signal)).tools).toEqual(expect.arrayContaining([expect.objectContaining({name:'set_value'}),expect.objectContaining({name:'read_value'})]));
  await host.operationCall(claim,'set_value',{value:'Actual fixture evidence'},signal);
  expect(await host.operationCall(claim,'read_value',{},signal)).toMatchObject({content:[{type:'text',text:'Actual fixture evidence'}]});
  await host.closeOperationSession(claim);
 });
});
