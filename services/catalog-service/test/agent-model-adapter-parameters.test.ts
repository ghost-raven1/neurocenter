import {describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {agentModelRequirements} from '../src/agents/agent-model-requirements';
import type {ProjectAgent} from '../../shared/project-agents.cjs';
import type {IModelRow} from '../src/models/model-history';

const row:IModelRow={id:'model-fixture',name:'Fixture',descriptor:{description:'',runtime:'remote-openai',model:'exact',modelVersion:'exact-v1',capability:'chat',source:'custom',dimension:null,manifestSha256:null,verificationSha256:'d'.repeat(64)},revision:1,created_at:new Date(0),updated_at:new Date(0),archived_at:null};
const agent:ProjectAgent={id:'agent-fixture',slug:'nc-fixture',version:1,enabled:true,description:'Fixture',prompt:'Fixture',mode:'subagent',permission:{bash:'deny'},model:'neurocenter/'+row.id};
function fixture(options:unknown){const query=vi.fn(async(sql:string)=>({rows:sql.includes('SELECT c.*')?[row]:[{base_url:'https://fixture.example/v1',options}]}));return {query,db:{query} as unknown as Pick<PoolClient,'query'>};}

describe('Agent model adapter fidelity without credential access',()=>{
 it('retains safe protocol, reasoning and retention policy instead of projecting only numbers',async()=>{
  const options={apiFormat:'responses',reasoningEffort:'high',store:false,contextWindow:200000},f=fixture(options);
  expect(await agentModelRequirements(f.db,'prj-fixture',[agent])).toMatchObject([{kind:'catalog',options}]);
  expect(f.query.mock.calls.every(([sql])=>!sql.includes('credential'))).toBe(true);
 });
 it.each([{providerParameters:{custom:{value:'PRIVATE_FIXTURE_VALUE'}}},{tokenLimitParameter:'max_completion_tokens'}])('private/unrepresentable local options are refused without dropping or disclosing them: %j',async options=>{
  const f=fixture(options),error=await agentModelRequirements(f.db,'prj-fixture',[agent]).catch(value=>value);
  expect(error).toMatchObject({status:409,response:{code:'OPENCODE_AGENT_MODEL_SETUP_REQUIRED',agentId:agent.id}});expect(JSON.stringify(error.response)).not.toContain('PRIVATE_FIXTURE_VALUE');expect(f.query.mock.calls.every(([sql])=>!sql.includes('credential'))).toBe(true);
 });
});
