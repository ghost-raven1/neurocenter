import {describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {startRoleMcpPoller} from '../src/features/system-role-mcp/poller.js';
import type {SessionJob} from '../src/features/system-role-mcp/worker.js';

describe('bounded MCP transport sessions',()=>{
 it('lets an independent session complete while its peer stalls and awaits both on shutdown',async()=>{
  const deviceId=randomUUID(),jobs=[1,2].map(()=>{const id=randomUUID();return {id,lease:randomUUID(),payload:{sessionId:id}}as SessionJob;});
  let claims=0;const completed:string[]=[],closed:string[]=[];
  const poller=startRoleMcpPoller({credentials:async()=>({deviceId,token:'fixture',email:'owner@example.test'}),recover:async()=>{},
   claim:async()=>jobs[claims++]??null,authorize:async()=>{},
   run:async(job,_device,_authorize,_deps,signal)=>{
    if(job.id===jobs[0].id)await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));
    closed.push(job.id);return {state:'succeeded',message:'closed',result:{schemaVersion:1,sessionId:job.id,closed:true}};
   },complete:async job=>{completed.push(job.id);}});
  try{await vi.waitFor(()=>expect(completed).toContain(jobs[1].id));expect(completed).not.toContain(jobs[0].id);expect(poller.active).toBe(1);}
  finally{await poller.stop();}
  expect(closed).toContain(jobs[0].id);expect(poller.active).toBe(0);expect(claims).toBeLessThanOrEqual(3);
 });
});
