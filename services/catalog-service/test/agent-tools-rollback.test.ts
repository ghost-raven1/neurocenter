import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {AgentToolsRepository} from '../src/agent-tools/agent-tools.repository';
import type {AgentToolOwner} from '../src/agent-tools/agent-tools.types';

it.each(['confirmed','not-dispatched','ack-lost'] as const)('retains the original failure and discards an uncertain transaction: %s',async mode=>{
 const primary=Object.assign(new Error('Insertion acknowledgement lost'),{code:'ECONNRESET'}),release=vi.fn(),query=vi.fn(async(sql:string)=>{
  if(sql.startsWith('INSERT INTO agent_tool_steps'))throw primary;if(sql==='ROLLBACK'&&mode!=='confirmed')throw Error('Rollback unknown');return{rows:[]};
 });
 const repository=new AgentToolsRepository({connect:async()=>({query,release})} as unknown as ConstructorParameters<typeof AgentToolsRepository>[0]);
 const owner:AgentToolOwner={kind:'model-chat',originId:randomUUID(),turnId:randomUUID(),recipientId:randomUUID(),generation:randomUUID(),ownerEmail:'fixture@invalid.test',actorRole:'Разработчик',projectId:'prj-fixture',agentId:null,modelId:'model-fixture',modelPin:'a'.repeat(64),grant:{protocol:'json-actions-v1',rag:true}};
 await expect(repository.reserve(owner,1,'planner',{},Date.now()+30000,async()=>{})).rejects.toBe(primary);expect(query.mock.calls.filter(([sql])=>sql==='ROLLBACK')).toHaveLength(1);
 expect(query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);if(mode==='confirmed')expect(release).toHaveBeenCalledExactlyOnceWith();else expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
