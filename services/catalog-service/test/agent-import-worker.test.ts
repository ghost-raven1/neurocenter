import {afterEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {assetDigest,serializeAsset,type AgentAsset,type ResolvedAsset} from '@neurocenter/asset-contract';
import {databaseFixture,actor} from './asset-import-db.fixture';
import {AgentRepository} from '../src/agents/agent.repository';
import {ProjectAgentRepository} from '../src/agents/project-agent.repository';
import {definition,connection} from './agent-postgres.fixture';
const created:Array<Awaited<ReturnType<typeof databaseFixture>>>=[];
afterEach(async()=>{for(const item of created.splice(0))await item.dispose();});
function agent(role:string):ResolvedAsset{
 const asset:AgentAsset={schemaVersion:1,id:'agent-'+role,kind:'agent',version:'1.0.0',card:{id:'agent-'+role,slug:'nc-'+role,name:role,definition:{...definition,prompt:'Native '+role+' prompt'}},source:{type:'git',repository:'https://github.com/example/agents',commit:'a'.repeat(40),path:role+'.md'},license:{spdx:'MIT'},compatibility:{bridgeProtocol:2},delivery:{type:'inline'}};
 return {asset,sha256:assetDigest(serializeAsset(asset)),path:'assets/'+asset.id+'/1.0.0/asset.json',current:true};
}
describe.skipIf(!connection)('Native agent selective source pipeline',()=>{
 it('imports selected basic agents only, retains exact source receipts and replays after worker restart without duplicate versions',async()=>{
  const f=await databaseFixture();created.push(f);const records=['planner','developer','reviewer','tester','documenter'].map(agent),pin=await f.snapshot(records),selected=['agent-planner','agent-reviewer'];
  const job=await f.jobs.create(actor,randomUUID(),pin,selected),worker=f.worker();try{await worker.flush();}finally{await worker.stop();}
  const saved=await f.jobs.get(job.id);expect(saved.state,saved.message).toBe('SUCCEEDED');expect(saved.items.map(item=>item.native?.kind)).toEqual(['agent','agent']);
  const cards=new AgentRepository(f.pool);expect((await cards.list()).map(card=>card.id).sort()).toEqual(selected.sort());expect((await f.jobs.receipts(pin.repository)).map(row=>({id:row.native_id,version:row.native_version,blobs:row.blobs}))).toEqual(selected.map(id=>({id,version:1,blobs:[]})));
  expect((await f.pool.query('SELECT * FROM ai_plugins')).rows).toEqual([]);
  const repeated=await f.jobs.create(actor,randomUUID(),pin,selected),restart=f.worker();try{await restart.flush();}finally{await restart.stop();}
  expect((await f.jobs.get(repeated.id)).state).toBe('SUCCEEDED');expect((await f.pool.query('SELECT * FROM agent_catalog_versions')).rowCount).toBe(2);
  await f.pool.query("INSERT INTO projects(id,name) VALUES('prj-agent-import','Imported agent')");const card=await cards.get('agent-reviewer');const assigned=await new ProjectAgentRepository(f.pool).assign({email:actor,activeRole:'Главный админ'},'prj-agent-import',{requestKey:randomUUID(),expectedRevision:0,agentId:card.id,version:card.version,manifest:card.manifest});expect(assigned.assignment.effective.prompt).toBe('Native reviewer prompt');
 });
});
