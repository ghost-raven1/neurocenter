import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema,EmptyResultSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {buildPackage} from '../../catalog-service/src/catalog/bundle-package';
import {roleHostedPackage} from '../src/features/system-role-mcp/package';
import {McpHostService} from '../src/features/mcp-host/host';
import {operationRemoteTransport} from '../src/features/mcp-host/operation-remote';

const latch=()=>{let open!:()=>void;const promise=new Promise<void>(resolve=>{open=resolve;});return {promise,open};};
const bounded=async<T>(promise:Promise<T>,message:string,milliseconds=1500):Promise<T>=>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),milliseconds);})]);}
 finally{clearTimeout(timer);}
};
const observed=<T>(promise:Promise<T>)=>promise.then(value=>({state:'fulfilled' as const,value}),error=>({state:'rejected' as const,error}));

/** Actual SDK sessions and owned HTTP barriers: no private transport fields, fake clocks, external MCP or package processes. */
describe.sequential('remote MCP closes local resources without waiting for remote termination acknowledgement',()=>{
 const nativeFetch=globalThis.fetch;
 let fixtures:Array<Awaited<ReturnType<typeof remote>>>,clients:Client[],hosts:McpHostService[],allowed:Set<string>;
 beforeEach(()=>{
  fixtures=[];clients=[];hosts=[];allowed=new Set();
  vi.stubGlobal('fetch',(input:RequestInfo|URL,init?:RequestInit)=>{
   const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
   if(!allowed.has(url.href))throw new Error('HTTP is outside the owned remote lifecycle fixture');
   return nativeFetch(input,init);
  });
 });
 afterEach(async()=>{
  // Even a RED assertion releases our barriers before awaiting actual SDK shutdown; it never waits for a product 30s deadline.
  fixtures.forEach(f=>{f.releaseDelete();f.releaseCall();});
  try{
   const results=await Promise.allSettled([...clients.map(client=>bounded(client.close(),'SDK cleanup did not finish',5000)),
    ...hosts.map(host=>bounded(host.onModuleDestroy(),'Host cleanup did not finish',5000))]);
   const failures=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
   for(const f of fixtures)try{await f.close();}catch(error){failures.push(error);}
   if(failures.length)throw new AggregateError(failures,'Owned remote lifecycle cleanup failed');
  }finally{vi.unstubAllGlobals();}
 });

 async function remote({holdDelete=false,holdCall=false}={}){
  const deleteSeen=latch(),deleteGate=latch(),callSeen=latch(),callGate=latch(),callResponseClosed=latch();
  const state={initializes:0,deletes:0,writes:0,calls:0};
  const sdk=new Server({name:'owned-lifecycle-fixture',version:'1'},{capabilities:{tools:{}}});
  sdk.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
   {name:'echo',inputSchema:{type:'object',properties:{value:{type:'string'}},additionalProperties:false}},
   {name:'write_then_wait',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  ]}));
  sdk.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
   state.calls++;
   if(request.params.name==='write_then_wait'){
    state.writes++;
    // A public server->client ping on this POST proves that the client consumed its SSE response before we close it.
    await sdk.request({method:'ping'},EmptyResultSchema,{relatedRequestId:extra.requestId,timeout:4000});
    callSeen.open();if(holdCall)await callGate.promise;
    return {content:[{type:'text',text:'Remote write completed'}]};
   }
   return {content:[{type:'text',text:String(request.params.arguments?.value??'echo')}]};
  });
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID()});await sdk.connect(transport);
  const listener=http.createServer(async(req,res)=>{
   try{
    if(req.url!=='/mcp'){res.writeHead(451).end();return;}
    const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));
    const text=Buffer.concat(parts).toString(),body=text?JSON.parse(text):undefined;
    if(body?.method==='initialize')state.initializes++;
    if(body?.method==='tools/call'&&body.params?.name==='write_then_wait')res.once('close',()=>callResponseClosed.open());
    if(req.method==='DELETE'){
     state.deletes++;deleteSeen.open();if(holdDelete)await deleteGate.promise;
    }
    if(!res.destroyed)await transport.handleRequest(req,res,body);
   }catch{if(!res.headersSent)res.writeHead(500);res.end();}
  });
  await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const address=listener.address();if(!address||typeof address==='string')throw new Error('Owned HTTP listener did not bind');
  const url='http://127.0.0.1:'+address.port+'/mcp';allowed.add(url);
  const claim=roleHostedPackage(buildPackage({id:'remote-lifecycle',name:'Owned remote lifecycle',kind:'mcp',version:1},[],'',
   {transport:'remote',url}),randomUUID());
  const fixture={url,claim,state,deleteSeen:deleteSeen.promise,callSeen:callSeen.promise,callResponseClosed:callResponseClosed.promise,
   releaseDelete:deleteGate.open,releaseCall:callGate.open,
   async close(){
    deleteGate.open();callGate.open();
    try{await bounded(sdk.close(),'Owned MCP server did not close',5000);}
    finally{listener.closeAllConnections();await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));}
   },
  };
  fixtures.push(fixture);return fixture;
 }
 async function clientFor(f:Awaited<ReturnType<typeof remote>>){
  const client=new Client({name:'owned-lifecycle-client',version:'1'},{capabilities:{}});clients.push(client);
  await client.connect(operationRemoteTransport({url:f.url,headers:{}}),{timeout:4000});return client;
 }
 function host(){const instance=new McpHostService('http://catalog.invalid','owned-lifecycle-token');hosts.push(instance);return instance;}

 it('gracefully terminates an actual useful host session once when DELETE is acknowledged',async()=>{
  const f=await remote(),h=host();
  expect((await h.operationTools(f.claim,AbortSignal.timeout(4000))).tools.map(tool=>tool.name)).toContain('echo');
  expect(await h.operationCall(f.claim,'echo',{value:'Useful fixture reply'},AbortSignal.timeout(4000)))
   .toMatchObject({content:[{type:'text',text:'Useful fixture reply'}]});
  await bounded(h.closeOperationSession(f.claim),'Acknowledged session close did not finish');
  await h.closeOperationSession(f.claim);
  expect(f.state).toEqual({initializes:1,deletes:1,writes:0,calls:1});
 });

 it('closes an in-flight HTTP response before a withheld DELETE acknowledgement without replaying an uncertain write',async()=>{
  const f=await remote({holdDelete:true,holdCall:true}),client=await clientFor(f);
  const pending=observed(client.callTool({name:'write_then_wait',arguments:{}},undefined,{timeout:10000}));
  await bounded(f.callSeen,'The real remote write did not start',4000);
  const closing=client.close();
  try{
   await bounded(f.deleteSeen,'The real DELETE did not reach its owned peer',4000);
   await bounded(f.callResponseClosed,'Local HTTP response stayed open while remote DELETE acknowledgement was withheld');
   await bounded(closing,'Local session close waited for remote DELETE acknowledgement');
   expect((await bounded(pending,'The local caller did not receive connection closure')).state).toBe('rejected');
   expect(f.state.writes).toBe(1);expect(f.state.initializes).toBe(1);
   // The peer already performed its write. A locally closed response proves no remote cancellation or rollback.
  }finally{f.releaseDelete();f.releaseCall();await closing;await pending;}
 });

 it('coalesces concurrent SDK close requests into one physical session DELETE',async()=>{
  const f=await remote({holdDelete:true}),client=await clientFor(f);
  const first=client.close(),second=client.close();
  try{
   await bounded(f.deleteSeen,'The first actual DELETE did not reach the peer',4000);f.releaseDelete();
   await bounded(Promise.all([first,second]),'Concurrent closes did not finish');
   await client.close();expect(f.state.deletes).toBe(1);expect(f.state.initializes).toBe(1);
  }finally{f.releaseDelete();await Promise.all([first,second]);}
 });

 it('keeps another operation session usable while one remote host withholds its close acknowledgement',async()=>{
  const blocked=await remote({holdDelete:true}),healthy=await remote(),h=host(),signal=AbortSignal.timeout(5000);
  await h.operationTools(blocked.claim,signal);await h.operationTools(healthy.claim,signal);
  const closing=h.closeOperationSession(blocked.claim);
  try{
   await bounded(blocked.deleteSeen,'The blocked session did not receive DELETE',4000);
   expect(await bounded(h.operationCall(healthy.claim,'echo',{value:'Independent session'},signal),'An unrelated operation was blocked'))
    .toMatchObject({content:[{type:'text',text:'Independent session'}]});
   expect(healthy.state.deletes).toBe(0);expect(blocked.state.deletes).toBe(1);
  }finally{blocked.releaseDelete();await closing;}
 });

 it('bounds actual host shutdown even when a remote session never acknowledges its DELETE',async()=>{
  const f=await remote({holdDelete:true}),h=host();await h.operationTools(f.claim,AbortSignal.timeout(4000));
  const closing=h.onModuleDestroy();
  try{
   await bounded(f.deleteSeen,'Host shutdown did not send its actual DELETE',4000);
   await bounded(closing,'A remote DELETE acknowledgement blocked host shutdown');
   expect(f.state.deletes).toBe(1);
  }finally{f.releaseDelete();await closing;}
 });

 it('rejects an actual host caller after its local response closes without requiring the caller to cancel separately',async()=>{
  const f=await remote({holdDelete:true,holdCall:true}),h=host(),caller=new AbortController();
  await h.operationTools(f.claim,AbortSignal.timeout(4000));
  const pending=observed(h.operationCall(f.claim,'write_then_wait',{},caller.signal));
  await bounded(f.callSeen,'The actual host write did not reach its owned peer',4000);
  const closing=h.closeOperationSession(f.claim);
  try{
   await bounded(f.callResponseClosed,'The actual host response did not close');
   expect((await bounded(pending,'The actual host caller remained pending after local connection close')).state).toBe('rejected');
   expect(caller.signal.aborted).toBe(false);expect(f.state.writes).toBe(1);
  }finally{
   // Own cleanup may cancel the test's still-pending caller after RED; this is not evidence of product cancellation.
   f.releaseDelete();f.releaseCall();caller.abort(new Error('Owned lifecycle fixture cleanup'));
   await closing;await pending;
  }
 });
});
