import { beforeEach, expect, it, vi } from 'vitest';
import api from '../src/core/api/base';
import { agentCatalogApi } from '../src/features/AgentCatalog/api';
import { agent, target } from './agent-fixtures';
vi.mock('../src/core/api/base',()=>({default:{get:vi.fn(),post:vi.fn(),patch:vi.fn(),delete:vi.fn()}}));
beforeEach(()=>{vi.clearAllMocks();for(const call of [api.get,api.post,api.patch,api.delete])vi.mocked(call).mockResolvedValue({data:{ok:true}});});
it('Передаёт exact project pin и единую revision на назначение',async()=>{
    await agentCatalogApi.assign('project/a',agent(),3,'key-one');
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/projects/project%2Fa/agents',{agentId:agent().id,version:1,manifest:agent().manifest,expectedRevision:3,requestKey:'key-one'});
});
it('Редактирует/удаляет с CAS, nullable clear и requestKey; DELETE не теряет body',async()=>{
    await agentCatalogApi.configure('p','agent/a',{enabled:true,overrides:{model:null,prompt:'Мой промпт'}},7,'key-two');
    expect(api.patch).toHaveBeenCalledExactlyOnceWith('/api/projects/p/agents/agent%2Fa',{enabled:true,overrides:{model:null,prompt:'Мой промпт'},expectedRevision:7,requestKey:'key-two'});
    await agentCatalogApi.remove('p','agent/a',8,'key-three');expect(api.delete).toHaveBeenCalledExactlyOnceWith('/api/projects/p/agents/agent%2Fa',{data:{expectedRevision:8,requestKey:'key-three'}});
});
it('Доставляет только выбранную папку/instance/revision, не prompt с клиента',async()=>{
    await agentCatalogApi.connect('p',target,8,'key-four');expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/projects/p/agents/connect',{...target,expectedRevision:8,requestKey:'key-four'});
});
it('Обновление общего шаблона передаёт expectedVersion и не вызывает project mutation',async()=>{
    const value={slug:agent().slug,name:agent().name,description:agent().description,definition:agent().definition};
    await agentCatalogApi.update(agent({id:'agent/a'}),value,'key-five');expect(api.patch).toHaveBeenCalledExactlyOnceWith('/api/agents/agent%2Fa',{...value,expectedVersion:1,requestKey:'key-five'});expect(api.post).not.toHaveBeenCalled();
});
