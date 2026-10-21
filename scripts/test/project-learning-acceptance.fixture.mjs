import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Executed only by the disposable acceptance runner with its own HOME and bridge state.
const [mode,runtime]=process.argv.slice(2),load=name=>import(pathToFileURL(path.join(runtime,'dist',name+'.js')).href);
let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw||'{}');
assert.ok(process.env.NEUROCENTER_BRIDGE_HOME&&process.env.HOME);
const state=await load('bridge/state'),workspace=await load('bridge/workspace');
if(mode==='bootstrap'){
 await state.writeState('credentials',input.credentials);await workspace.setRoot(input.root);
}
if(mode==='bootstrap'||mode==='report'){
 const report=await workspace.workspaceReport();await state.api('heartbeat',report);
 const protocol=await load('bridge/protocol');
 console.log(JSON.stringify({version:protocol.BRIDGE_VERSION,buildId:await protocol.bridgeBuildId(),capabilities:report.capabilities,bindings:report.bindings}));
}else if(mode==='collect'){
 const plugin=path.join(input.project,'.opencode/plugins/neurocenter-learning.js');
 const collector=await import(pathToFileURL(plugin).href),hooks=await collector.default({directory:input.project});
 await hooks['tool.execute.after']({tool:'read',sessionID:input.sessionId,args:'SECRET_SENTINEL'}, {output:'SECRET_SENTINEL'});
 await hooks['tool.execute.after']({tool:'bash',sessionID:input.sessionId,args:'SECRET_SENTINEL'}, {output:'SECRET_SENTINEL'});
 await hooks['tool.execute.after']({tool:'unknown-secret-name',sessionID:input.sessionId},{});
 await hooks.event({event:{type:'session.idle',properties:{sessionID:input.sessionId}}});
 const queue=await load('features/project-learning/observation-queue'),directory=path.join(queue.learningQueueRoot(),input.target.bindingId);
 const names=(await fs.readdir(directory)).filter(name=>name.endsWith('.json'));assert.equal(names.length,1);
 const file=path.join(directory,names[0]),bytes=await fs.readFile(file,'utf8');assert.ok(!bytes.includes('SECRET_SENTINEL'));
 assert.ok(!bytes.includes(input.sessionId));assert.ok(!bytes.includes('unknown-secret-name'));
 const observation=JSON.parse(bytes);assert.equal(observation.input.outcome,'unknown');
 const facts=JSON.parse(observation.input.evidence[0].summary);assert.deepEqual(facts.toolObservations,{read:1,bash:1});assert.equal(facts.calls,2);assert.equal(facts.sessionEvent,'idle');
 console.log(JSON.stringify({file,input:observation.input,sha256:state.hash(bytes)}));
}else if(mode==='copied-binding'){
 const queue=await load('features/project-learning/observation-queue');await queue.enqueueLearningObservation(input.source,input.input);
 const originalFile=path.join(queue.learningQueueRoot(),input.source.bindingId,input.input.requestKey+'.json'),bytes=await fs.readFile(originalFile);
 const directory=path.join(queue.learningQueueRoot(),input.target.bindingId);await fs.mkdir(directory,{mode:0o700});
 const copied=path.join(directory,input.input.requestKey+'.json');await fs.writeFile(copied,bytes,{mode:0o600});
 const originalFetch=globalThis.fetch;let requests=0;globalThis.fetch=async(...args)=>{requests++;return originalFetch(...args);};
 try{await assert.rejects(queue.flushLearningObservations(input.target));assert.equal(requests,0);assert.deepEqual(await fs.readFile(copied),bytes);assert.deepEqual(await fs.readFile(originalFile),bytes);}
 finally{globalThis.fetch=originalFetch;}
 await fs.unlink(copied);assert.equal(await queue.flushLearningObservations(input.source),1);console.log(JSON.stringify({networkRequestsForCopiedBinding:requests,requestKey:input.input.requestKey}));
}else if(mode==='substituted-ack'){
 const queue=await load('features/project-learning/observation-queue');await queue.enqueueLearningObservation(input.target,input.input);
 const file=path.join(queue.learningQueueRoot(),input.target.bindingId,input.input.requestKey+'.json'),originalBytes=await fs.readFile(file);
 const changed=JSON.parse(originalBytes.toString('utf8'));changed.input.summary='QA replacement after real COMMIT';const changedBytes=Buffer.from(JSON.stringify(changed)+'\n');
 const originalFetch=globalThis.fetch,requests=[];let replaced=false;
 globalThis.fetch=async(url,options)=>{const response=await originalFetch(url,options);requests.push({status:response.status});
  if(String(url).endsWith('/learning/observe')&&response.ok&&!replaced){replaced=true;await fs.writeFile(file,changedBytes,{mode:0o600});}return response;};
 try{
  await assert.rejects(queue.flushLearningObservations(input.target));assert.equal(replaced,true);assert.deepEqual(await fs.readFile(file),changedBytes);
  await assert.rejects(queue.flushLearningObservations(input.target),error=>error.status===409);assert.deepEqual(await fs.readFile(file),changedBytes);
  // Only the harness restores its own deliberately damaged fixture so the original exact replay can complete.
  await fs.writeFile(file,originalBytes,{mode:0o600});assert.equal(await queue.flushLearningObservations(input.target),1);
  assert.deepEqual(requests.map(item=>item.status),[201,409,201]);console.log(JSON.stringify({requests,requestKey:input.input.requestKey}));
 }finally{globalThis.fetch=originalFetch;}
}else if(mode==='flush'||mode==='lost-ack'){
 const queue=await load('features/project-learning/observation-queue');let committed=false;
 if(mode==='lost-ack'){
  const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{const response=await original(url,options);
   if(String(url).endsWith('/learning/observe')&&response.ok&&!committed){committed=true;await response.text();throw Error('Acceptance fixture: ACK lost after real committed HTTP2xx');}
   return response;};
 }
 if(mode==='lost-ack'){await assert.rejects(queue.flushLearningObservations(input.target),/ACK lost/);assert.equal(committed,true);}
 else assert.equal(await queue.flushLearningObservations(input.target),1);
 console.log(JSON.stringify({committed,mode}));
}else if(mode==='inventory'){
 const inventory=await load('bridge/project-inventory');console.log(JSON.stringify(await inventory.scanProjectInventory(input.projectId,async()=>undefined)));
}else throw Error('Unknown isolated fixture mode');
