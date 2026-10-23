import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createContainerObserver} from '../snapshots/container-state.mjs';
import {containerObservation} from '../../services/shared/container-observation.cjs';

test('host observation uses fixed read-only argv and strips private Docker attributes',async()=>{
 let calls=0,argsSeen,optionsSeen;
 const observer=createContainerObserver('neurocenter-fixture',{now:()=>Date.parse('2026-10-23T00:00:00.000Z'),run:async(command,args,options)=>{
  calls++;assert.equal(command,'docker');argsSeen=args;optionsSeen=options;
  return {stdout:JSON.stringify({Labels:'private=password,com.docker.compose.project=neurocenter-fixture,com.docker.compose.service=catalog',State:'running',Status:'Up (healthy)',Names:'private-name',Ports:'secret-address'})+'\n'};
 }});
 const report=await observer(new AbortController().signal);assert.equal(calls,1);
 assert.deepEqual(argsSeen,['ps','--all','--filter','label=com.docker.compose.project=neurocenter-fixture','--format','{{json .}}']);
 assert.equal(optionsSeen.timeout,3000);assert.equal(optionsSeen.maxBuffer,65536);assert.equal(optionsSeen.shell,undefined);
 assert.deepEqual(report.items,[{service:'catalog',state:'running',health:'healthy'}]);assert(!JSON.stringify(report).includes('private'));assert(!JSON.stringify(report).includes('secret'));
 await observer();assert.equal(calls,1,'cached observation avoids polling Docker every heartbeat');
});
test('missing/unsafe operator project never executes Docker',async()=>{
 for(const project of [undefined,'','../other','all; docker exec','UPPER']){
  let called=false;const report=await createContainerObserver(project,{run:async()=>{called=true;throw Error('unexpected');}})();
  assert.equal(called,false);assert.equal(report,undefined);
 }
});
test('does not accept an unrelated Compose project or expose Docker error logs',async()=>{
 const inspect=async stdout=>createContainerObserver('owned',{run:async()=>({stdout})})();
 const unrelated=await inspect(JSON.stringify({Labels:'com.docker.compose.project=foreign,com.docker.compose.service=catalog',State:'running',Status:'Up'}));
 assert.equal(unrelated.available,false);assert.equal(unrelated.reason,'docker-unavailable');
 const failed=await createContainerObserver('owned',{run:async()=>{throw Error('private API address and password');}})();
 assert.equal(failed.available,false);assert(!JSON.stringify(failed).includes('password'));
});
test('observation contract rejects extra fields, unbounded output and unsupported state',()=>{
 const base={schema:1,project:'owned',checkedAt:'2026-10-23T00:00:00.000Z',available:true,items:[]};
 for(const value of [{...base,logs:'secret'},{...base,items:Array(65).fill({service:'db',state:'running',health:'healthy'})},{...base,items:[{service:'db',state:'invented',health:'healthy'}]}])assert.throws(()=>containerObservation(value));
});
