import type {Request} from 'express';
import type {ModuleRef} from '@nestjs/core';
import {expect,it,vi} from 'vitest';
import {AgentToolsService} from '../src/agent-tools/agent-tools.service';
import {AgentToolsLoop} from '../src/agent-tools/agent-tools.loop';
import {ChatSearchService} from '../src/chat-search/chat-search.service';
import type {ModelsService} from '../src/models/models.service';
import type {ModelRuntime} from '../src/models/model-runtime';
import type {AgentToolOwner,AgentToolStepRow} from '../src/agent-tools/agent-tools.types';

/** A created search remains our responsibility when retaining its ledger reference fails. */
it('cancels the created public search exactly once when its receipt cannot be retained',async()=>{
 const req={headers:{}} as Request,primary=new Error('Receipt rejected after search admission');
 const search={create:vi.fn(async()=>({id:'search-owned',state:'RUNNING'})),cancel:vi.fn(async()=>{}),get:vi.fn()};
 const modules={get:vi.fn((token:unknown)=>{expect(token).toBe(ChatSearchService);return search;})} as unknown as ModuleRef;
 const tools=new AgentToolsService({pool:{}} as ModelsService,{} as ModelRuntime,modules);
 const reference=vi.fn().mockRejectedValue(primary),owner:AgentToolOwner={kind:'model-chat',originId:'chat-owned',turnId:'turn-owned',recipientId:'turn-owned',generation:'generation-owned',
  ownerEmail:'fixture@invalid.test',actorRole:'Разработчик',projectId:'prj-owned',agentId:null,modelId:'model-owned',modelPin:'a'.repeat(64),
  grant:{protocol:'json-actions-v1',rag:false,publicChats:{modelId:'embedding-owned',expectedModelPin:'b'.repeat(64),consent:true}}};
 vi.spyOn(tools,'admit').mockResolvedValue();
 vi.spyOn(AgentToolsLoop.prototype,'run').mockImplementation(async scope=>{
  await scope.execute({action:'public_chat_search',query:'Find project context'},{id:'step-owned'} as AgentToolStepRow,reference);return [];
 });
 const evidence={status:'none' as const,sources:[]};
 try{
  await expect(tools.run(req,{owner,messages:[],settings:{contextWindowTokens:32768},signal:new AbortController().signal,assertCurrent:async()=>{}},
   {messages:[],evidence,requiredFeatures:[],assertCurrent:async()=>{},beforeInference:async()=>{},fit:messages=>({messages,evidence})},'Question')).rejects.toBe(primary);
  expect(search.create).toHaveBeenCalledOnce();expect(reference).toHaveBeenCalledOnce();
  expect(search.cancel).toHaveBeenCalledExactlyOnceWith(req,'prj-owned','search-owned');expect(search.get).not.toHaveBeenCalled();
 }finally{vi.restoreAllMocks();await tools.onModuleDestroy();}
});
