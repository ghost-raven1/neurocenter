import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

/** Executed by the unpacked archive's Node against one owned temporary project and HTTP API. */
const content=process.cwd(),directory=path.resolve(process.argv[2]??'');
assert.ok(process.argv[2]&&directory!==content&&path.isAbsolute(directory));
await fs.mkdir(directory,{mode:0o700});
const load=relative=>import(pathToFileURL(path.join(content,'dist',relative)).href);
const projectId='runtime-role-mcp-fixture',deviceId=randomUUID(),token=randomUUID(),marker='owned-marker-'+randomUUID();
const project=path.join(directory,'проекты','проект с пробелами');await fs.mkdir(project,{recursive:true});
await fs.writeFile(path.join(project,'marker.txt'),marker);
const source=`import fs from 'node:fs/promises';import {appendFileSync} from 'node:fs';import {createRequire} from 'node:module';import {spawn} from 'node:child_process';
const require=createRequire(${JSON.stringify(path.join(content,'package.json'))});
const {Server}=require('@modelcontextprotocol/sdk/server/index.js'),{StdioServerTransport}=require('@modelcontextprotocol/sdk/server/stdio.js'),{ListToolsRequestSchema,CallToolRequestSchema}=require('@modelcontextprotocol/sdk/types.js');
const trace=value=>appendFileSync('mcp-trace.jsonl',JSON.stringify(value)+'\\n');await fs.writeFile('tool.pid',String(process.pid));
const server=new Server({name:'owned-file-runtime-fixture',version:'1'},{capabilities:{tools:{}}});
const tools=[{name:'read_fixture',inputSchema:{type:'object',properties:{file:{type:'string',enum:['marker.txt']}},required:['file'],additionalProperties:false}},
{name:'hold_fixture',inputSchema:{type:'object',properties:{},additionalProperties:false}},{name:'disconnect_fixture',inputSchema:{type:'object',properties:{},additionalProperties:false}}];
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
server.setRequestHandler(CallToolRequestSchema,async request=>{const name=request.params.name;trace({tool:name});
 if(name==='read_fixture'){assertFile(request.params.arguments?.file);return {content:[{type:'text',text:await fs.readFile('marker.txt','utf8')}]};}
 if(name==='disconnect_fixture'){setTimeout(()=>process.exit(0),5);await new Promise(()=>{});}
 if(name!=='hold_fixture')throw Error('Unknown fixture tool');
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','--','--owned-runtime-fixture',${JSON.stringify(deviceId)}],{stdio:'ignore'});await fs.writeFile('descendant.pid',String(child.pid));await new Promise(()=>{});
});function assertFile(value){if(value!=='marker.txt')throw Error('Only the owned fixture marker is available');}
const transport=new StdioServerTransport(),start=transport.start.bind(transport);transport.start=async()=>{const receive=transport.onmessage;transport.onmessage=(message,extra)=>{if(message.method)trace({method:message.method});receive?.(message,extra);};return start();};await server.connect(transport);
`;
const state=await load('bridge/state.js'),packageModule=await load('bridge/package.js');
const file={path:'fixture.mjs',content:source,size:Buffer.byteLength(source),sha256:state.hash(source)};
const pkg={schemaVersion:4,plugin:{id:'owned-runtime-fixture',name:'Owned runtime fixture',kind:'mcp',version:1},config:{transport:'stdio',command:'node',entrypoint:'fixture.mjs'},files:[file],manifest:{filesCount:1}};
pkg.manifest.sha256=state.hash(JSON.stringify(packageModule.canonicalV4({schemaVersion:pkg.schemaVersion,plugin:pkg.plugin,config:pkg.config,files:[{path:file.path,size:file.size,sha256:file.sha256}]})));
packageModule.verify(pkg);
const records=[],results=new Map(),resultBytes=new Map();let active,server,pending,controller,dropReadAck=true;
const response=(res,value)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value));
server=http.createServer(async(req,res)=>{
 try{
  assert.equal(req.headers.authorization,'Bearer '+token);let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1024*1024)throw Error('Fixture request bound');}
  const body=JSON.parse(raw||'{}'),route=req.url.split('/').at(-1);assert.ok(active);assert.equal(body.jobId,active.job.id);assert.equal(body.lease,active.job.lease);
  records.push({scenario:active.name,route,callId:body.callId});
  if(route==='authorize')return response(res,{ok:true});
  if(route==='context')return response(res,active.context);
  if(route==='dispatch'){assert.ok(!active.dispatched.has(body.callId),'No dispatch is repeated');active.dispatched.add(body.callId);return response(res,{ok:true});}
  if(route==='next'){
   if(!active.listed)return response(res,{id:active.listId,kind:'list',deadlineAt:active.context.deadlineAt});
   if(!active.executed){const tool=active.tools.find(item=>item.name===active.tool);assert.ok(tool);return response(res,{id:active.callId,kind:'call',name:tool.name,schemaDigest:tool.schemaDigest,arguments:active.tool==='read_fixture'?{file:'marker.txt'}:{},deadlineAt:active.context.deadlineAt});}
   return response(res,{closed:true});
  }
  if(route==='result'){
   const key=body.callId,previous=results.get(key);if(previous){assert.deepEqual(body,previous);assert.equal(raw,resultBytes.get(key));}else{results.set(key,body);resultBytes.set(key,raw);}
   if(key===active.listId){assert.equal(body.result.state,'succeeded');active.listed=true;active.tools=body.result.value.tools;return response(res,{ok:true});}
   assert.equal(key,active.callId);active.executed=true;active.result=body.result;
   if(active.name==='read'&&dropReadAck){dropReadAck=false;req.socket.destroy();return;}
   return response(res,{ok:true});
  }
  throw Error('Unexpected fixture route');
 }catch(error){res.destroy(error);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
process.env.NEUROCENTER_URL='http://127.0.0.1:'+server.address().port;
process.env.NEUROCENTER_API_URL=process.env.NEUROCENTER_URL;
process.env.NEUROCENTER_BRIDGE_HOME=path.join(directory,'private');
const workspace=await load('bridge/workspace.js'),installer=await load('bridge/installer.js');
const {runSystemRoleMcpJob}=await load('features/system-role-mcp/worker.js');
const {roleMcpApi}=await load('features/system-role-mcp/api.js');
const {deliverRoleMcpResults}=await load('features/system-role-mcp/receipts.js');
const {inspectInstallation}=await load('bridge/installation-inspection.js');
const waitFor=async(predicate,label)=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(await predicate())return;await delay(20);}throw Error('Fixture timeout: '+label);};
const gone=pid=>{try{process.kill(pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}};
const traces=async()=>JSON.parse('['+(await fs.readFile(path.join(project,'mcp-trace.jsonl'),'utf8')).trim().split('\n').join(',')+']');
const scenario=(name,tool)=>{
 const id=randomUUID(),job={id,lease:randomUUID(),project_id:projectId,payload:{sessionId:id}};
 const value={name,tool,job,listId:randomUUID(),callId:randomUUID(),listed:false,executed:false,dispatched:new Set()};
 value.context={jobId:id,sessionId:id,projectId,package:pkg,target,deadlineAt:new Date(Date.now()+30000).toISOString()};return value;
};
let target;
try{
 await workspace.setRoot(path.dirname(project));await workspace.bindProject(projectId,path.basename(project));
 await state.writeState('credentials',{deviceId,token,email:'archive-fixture@example.test'});
 await installer.install(projectId,pkg,async()=>({}),async()=>{});
 assert.equal((await inspectInstallation(projectId,pkg)).status,'synced');
 target={runtime:'device',deviceId,assetKind:'mcp',assetId:pkg.plugin.id,version:1,manifest:pkg.manifest.sha256,
  bindingId:await workspace.projectBindingId(projectId),instanceId:await workspace.projectInstanceId(projectId),configurationRevisions:[]};
 const run=()=>runSystemRoleMcpJob(active.job,deviceId,()=>roleMcpApi('authorize',{jobId:active.job.id,lease:active.job.lease}),{},controller.signal);
 active=scenario('read','read_fixture');controller=new AbortController();pending=run();
 assert.equal((await pending).state,'succeeded');pending=undefined;
 assert.equal(active.result.state,'succeeded');assert.equal(active.result.value.text,marker);
 const readResult=results.get(active.callId),readId=active.callId;
 const receiptDirectory=path.join(state.stateDir(),'system-role-mcp-receipts');
 assert.ok((await fs.readdir(receiptDirectory)).includes(readId+'.json'));
 await deliverRoleMcpResults(deviceId);
 assert.ok(!(await fs.readdir(receiptDirectory)).includes(readId+'.json'));
 assert.deepEqual(results.get(readId),readResult);
 assert.equal(records.filter(row=>row.route==='result'&&row.callId===readId).length,2);
 assert.equal((await traces()).filter(row=>row.tool==='read_fixture').length,1);
 active=scenario('cancel','hold_fixture');controller=new AbortController();pending=run();
 await waitFor(()=>fs.access(path.join(project,'descendant.pid')).then(()=>true,()=>false),'owned descendant started');
 const descendant=Number(await fs.readFile(path.join(project,'descendant.pid'),'utf8'));assert.ok(Number.isInteger(descendant)&&descendant>1&&descendant!==process.pid);
 controller.abort(new Error('Owned fixture cancellation'));
 assert.equal((await pending).state,'failed');pending=undefined;
 await waitFor(()=>gone(descendant),'owned descendant closed');await deliverRoleMcpResults(deviceId);
 assert.equal(active.result.state,'unknown');assert.equal((await traces()).filter(row=>row.tool==='hold_fixture').length,1);
 active=scenario('disconnect','disconnect_fixture');controller=new AbortController();pending=run();
 assert.equal((await pending).state,'failed');pending=undefined;assert.equal(active.result.state,'unknown');
 assert.equal((await traces()).filter(row=>row.tool==='disconnect_fixture').length,1);
 const protocol=await traces();assert.ok(protocol.some(row=>row.method==='initialize'));assert.ok(protocol.some(row=>row.method==='tools/list'));assert.ok(protocol.some(row=>row.method==='tools/call'));
 assert.equal(await fs.readFile(path.join(project,'marker.txt'),'utf8'),marker);
 assert.equal((await inspectInstallation(projectId,pkg)).status,'synced');
 const report={native:true,compiledWorker:true,managedInstallationInspected:true,initialize:true,toolsList:true,toolsCall:true,readExecutions:1,
  lostResultAckSameReceipt:true,toolNotReplayed:true,cancelledOwnedDescendant:true,disconnectUnknown:true,projectMarkerUnchanged:true,
  sourcePackageUnchanged:true,externalModels:false,userFilesTouched:false};
 await fs.writeFile(path.join(directory,'receipt.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{
 controller?.abort();if(pending)await pending.catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
