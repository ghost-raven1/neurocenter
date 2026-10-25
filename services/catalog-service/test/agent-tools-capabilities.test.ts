import type {Request} from 'express';
import type {ModuleRef} from '@nestjs/core';
import {afterEach,expect,it,vi} from 'vitest';
import {AgentToolsService} from '../src/agent-tools/agent-tools.service';
import type {ModelsService} from '../src/models/models.service';
import type {ModelRuntime} from '../src/models/model-runtime';
import type {IModel} from '../src/models/model.types';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
const req={headers:{}} as Request;
const instances=new Set<AgentToolsService>();
afterEach(async()=>{for(const tools of instances)await tools.onModuleDestroy();instances.clear();vi.unstubAllGlobals();});
function fixture(role='Разработчик',off=false){
 const card=(id:string,extra:Partial<IModel>={}):IModel=>({id,name:id,description:'Fixture',capability:'embedding',runtime:'ollama',model:id,manifestSha256:'a'.repeat(64),dimension:3,source:'custom',revision:1,createdAt:'2026-10-25',updatedAt:'2026-10-25',...extra});
 const items=[card('model-first'),card('model-unassigned'),card('model-chat',{capability:'chat'}),card('model-archived',{archivedAt:'2026-10-25'}),card('model-unverified',{runtime:'remote-openai',manifestSha256:null})];
 const list=vi.fn(async()=>({items,assignedModelIds:['model-first','model-chat','model-archived','model-unverified']})),infer=vi.fn(),get=vi.fn();
 const models={pool:{},actor:async()=>({email:'fixture@invalid.test',activeRole:role,claims:{email:'fixture@invalid.test',userRoles:[role],projects:[{projectId:'prj-owned',role}],pluginIds:[],skillPaths:[]}}),resolveProject:vi.fn(async()=>({id:'prj-owned'})),list,getUsable:vi.fn(async(id:string)=>items.find(item=>item.id===id)!)} as unknown as ModelsService;
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(evaluateFeatureFlags({...defaultFeatureFlags(),project_agent_tools:!off})))));
 const tools=new AgentToolsService(models,{infer} as unknown as ModelRuntime,{get} as unknown as ModuleRef);instances.add(tools);return {tools,list,infer,get,items,models};
}
it('offers only actual assigned verified embedding pins without model calls or private helper tasks',async()=>{
 const f=fixture(),result=await f.tools.capabilities(req,'prj-owned');expect(result).toMatchObject({protocol:'json-actions-v1',available:true,mcp:{available:false},limits:{steps:3}});
 expect(result.publicChats.models).toEqual([{id:'model-first',name:'model-first',pin:projectEmbeddingPin(f.items[0]),dimension:3}]);expect(result.systemRoles.available).toBe(true);
 expect(f.infer).not.toHaveBeenCalled();expect(f.get).not.toHaveBeenCalled();
});
it.each([['Наблюдатель',false],['Разработчик',true]] as const)('reports unavailable for %s with toolsOff=%s without loading models',async(role,off)=>{
 const f=fixture(role,off),result=await f.tools.capabilities(req,'prj-owned');expect(result.available).toBe(false);expect(result.reason).toBeTruthy();expect(f.list).not.toHaveBeenCalled();expect(f.infer).not.toHaveBeenCalled();
});
