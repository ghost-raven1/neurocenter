import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {assetDigest,serializeAsset,type AgentAsset,type ResolvedAsset} from '@neurocenter/asset-contract';
import {AgentRepository} from '../src/agents/agent.repository';
import {ProjectAgentRepository} from '../src/agents/project-agent.repository';
import {AgentAssetAdapter} from '../src/asset-sources/asset-agent-adapter';
import {AssetManagementService} from '../src/asset-sources/asset-management.service';
import type {AssetSourcesService} from '../src/asset-sources/asset-sources.service';
import type {IImportItem,ISourceReceipt} from '../src/asset-sources/import-types';
import {agentNativeHash} from '../src/agents/agent-validation';
import {connection,database,reset,main,admin,definition} from './agent-postgres.fixture';
const asset=(prompt=definition.prompt,version='1.0.0'):ResolvedAsset=>{
 const item:AgentAsset={schemaVersion:1,id:'agent-review',version,kind:'agent',card:{id:'agent-review',slug:'nc-review',name:'Ревью',definition:{...definition,prompt}},source:{type:'git',repository:'https://github.com/example/agents',commit:'a'.repeat(40),path:'review.md'},license:{spdx:'MIT'},delivery:{type:'inline'},compatibility:{bridgeProtocol:2}};
 return {asset:item,sha256:assetDigest(serializeAsset(item)),path:'assets/'+item.id+'/'+version+'/asset.json',current:true};
};
describe.skipIf(!connection)('Agent source import and deletion impact — actual PostgreSQL',()=>{
 let fixture:Awaited<ReturnType<typeof database>>,pool:Pool,cards:AgentRepository,projects:ProjectAgentRepository,adapter:AgentAssetAdapter,management:AssetManagementService;
 beforeAll(async()=>{fixture=await database();pool=fixture.pool;cards=new AgentRepository(pool);projects=new ProjectAgentRepository(pool);adapter=new AgentAssetAdapter(pool);management=new AssetManagementService({pool} as AssetSourcesService);});
 afterAll(async()=>fixture?.close());beforeEach(async()=>reset(pool));
 const publish=async(item:IImportItem)=>{const db=await pool.connect();try{await db.query('BEGIN');const native=await adapter.publish(item,main.email,db);await db.query('COMMIT');return native;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}};
 const assign=async(id:string)=>{const card=await cards.get(id);return projects.assign(admin,'prj-agents',{requestKey:randomUUID(),expectedRevision:0,agentId:id,version:card.version,manifest:card.manifest});};
 const receipt=(item:IImportItem):ISourceReceipt=>({native_id:item.native!.id,native_hash:item.native!.hash,native_version:item.native!.version,descriptor_sha256:item.resolved.sha256} as ISourceReceipt);
 const archive=async(id:string,mode='catalog-only')=>{const impact=await management.impact(main.email,{kind:'agent',id});return management.archive(main.email,{impactId:impact.impactId,expectedDigest:impact.digest,mode});};
 it('imports a native agent without tool publication, preserves source version mapping and exact project pins',async()=>{
  const first=await adapter.preview(asset(),randomUUID(),[]);expect(first).toMatchObject({action:'create',native:{kind:'agent',id:'agent-review',version:1}});expect(await publish(first)).toEqual(first.native);
  await assign('agent-review');const next=await adapter.preview(asset('New upstream prompt','2.0.0'),randomUUID(),[],receipt(first));expect(next.action).toBe('update');await publish(next);
  expect((await cards.get('agent-review')).version).toBe(2);expect((await projects.assignments('prj-agents'))[0].effective.prompt).toBe(definition.prompt);
  const old=await adapter.preview(asset(),randomUUID(),[],receipt(next),receipt(first));expect(old).toMatchObject({action:'unchanged',preserveHead:true,native:{version:1}});await publish(old);expect((await cards.get('agent-review')).version).toBe(2);
 });
 it('stores a historical source snapshot without moving the current head',async()=>{
  const first=await adapter.preview(asset(),randomUUID(),[]);await publish(first);const historical={...asset('Historical prompt','0.9.0'),current:false};
  const plan=await adapter.preview(historical,randomUUID(),[],receipt(first));expect(plan).toMatchObject({action:'snapshot',preserveHead:true,native:{version:2}});await publish(plan);
  expect((await cards.get('agent-review')).version).toBe(1);expect((await cards.pinned('agent-review',2,plan.native!.manifest!)).definition.prompt).toBe('Historical prompt');
 });
 it('requires explicit local replacement and refuses a stale preview/version race',async()=>{
  const first=await adapter.preview(asset(),randomUUID(),[]);await publish(first);await cards.update(main,'agent-review',{requestKey:randomUUID(),expectedVersion:1,name:'My local name'});
  const conflict=await adapter.preview(asset('Upstream','2.0.0'),randomUUID(),[],receipt(first));expect(conflict).toMatchObject({action:'conflict',replaceable:true});
  const approved=await adapter.preview(asset('Upstream','2.0.0'),randomUUID(),[],receipt(first),undefined,agentNativeHash(await cards.get('agent-review')));expect(approved).toMatchObject({action:'update',replacesLocal:true,native:{version:3}});
  await cards.update(main,'agent-review',{requestKey:randomUUID(),expectedVersion:2,name:'Second local edit'});await expect(publish(approved)).rejects.toMatchObject({status:409});
 });
 it('blocks slug collisions and imports into archived heads',async()=>{
  await cards.create(main,{requestKey:randomUUID(),slug:'nc-review',name:'Other agent',definition});expect((await adapter.preview(asset(),randomUUID(),[])).action).toBe('conflict');
  await pool.query('TRUNCATE agent_catalog CASCADE');const first=await adapter.preview(asset(),randomUUID(),[]);await publish(first);await archive('agent-review');expect((await adapter.preview(asset(),randomUUID(),[],receipt(first))).action).toBe('conflict');
 });
 it('catalog-only archive preserves active immutable pins and allows their project settings',async()=>{
  await publish(await adapter.preview(asset(),randomUUID(),[]));await assign('agent-review');const result=await archive('agent-review');expect(result.state).toBe('SUCCEEDED');expect((await cards.get('agent-review')).archivedAt).not.toBeNull();
  const pinned=(await projects.assignments('prj-agents'))[0].card;expect(pinned.archivedAt).toBeNull();expect((await cards.withArchiveState([pinned]))[0]).toMatchObject({archivedAt:expect.any(String),definition:{prompt:definition.prompt}});expect(pinned.archivedAt).toBeNull();
  expect((await projects.assignments('prj-agents'))[0]).toMatchObject({removed:false,version:1,effective:{prompt:definition.prompt}});
  await projects.update(admin,'prj-agents','agent-review',{requestKey:randomUUID(),expectedRevision:1,enabled:true});
  await expect(projects.assign(main,'prj-other',{requestKey:randomUUID(),expectedRevision:0,agentId:'agent-review',version:1,manifest:(await cards.get('agent-review')).manifest})).rejects.toMatchObject({status:409});
  await archive('agent-review','restore');expect((await cards.get('agent-review')).archivedAt).toBeNull();expect((await cards.get('agent-review')).version).toBe(1);
 });
 it('catalog-and-projects tombstones desired state with a new revision and honest pending local cleanup',async()=>{
  await publish(await adapter.preview(asset(),randomUUID(),[]));await assign('agent-review');await projects.update(admin,'prj-agents','agent-review',{requestKey:randomUUID(),expectedRevision:1,enabled:true,overrides:{prompt:'Project customization'}});
  const impact=await management.impact(main.email,{kind:'agent',id:'agent-review'});expect(impact.projects).toHaveLength(1);expect(impact.projects[0].version).toBe(1);
  const input={impactId:impact.impactId,expectedDigest:impact.digest,mode:'catalog-and-projects'},result=await management.archive(main.email,input);expect(result).toMatchObject({state:'SUCCEEDED',message:expect.stringContaining('на каждом компьютере')});expect(await management.archive(main.email,input)).toEqual(result);
  expect(await projects.snapshot('prj-agents')).toEqual({revision:3,agents:[]});expect((await projects.assignments('prj-agents'))[0]).toMatchObject({removed:true,enabled:false,overrides:{prompt:'Project customization'}});
  const audit=(await pool.query("SELECT before_state,after_state FROM security_events WHERE action='asset.archive'")).rows[0];expect(audit.before_state).toMatchObject({kind:'agent',name:'Ревью',slug:'nc-review',version:1});expect(JSON.stringify(audit)).not.toContain('Project customization');
 });
 it('deletion impact invalidates after project overrides change and rejects lost admin rights',async()=>{
  await publish(await adapter.preview(asset(),randomUUID(),[]));await assign('agent-review');const impact=await management.impact(main.email,{kind:'agent',id:'agent-review'}),input={impactId:impact.impactId,expectedDigest:impact.digest,mode:'catalog-and-projects'};
  await projects.update(admin,'prj-agents','agent-review',{requestKey:randomUUID(),expectedRevision:1,enabled:true});await expect(management.archive(main.email,input)).rejects.toMatchObject({status:409});expect((await cards.get('agent-review')).archivedAt).toBeNull();
  const fresh=await management.impact(main.email,{kind:'agent',id:'agent-review'});await pool.query('UPDATE platform_users SET enabled=false WHERE email=$1',[main.email]);await expect(management.archive(main.email,{...input,impactId:fresh.impactId,expectedDigest:fresh.digest})).rejects.toMatchObject({status:403});
 });
});
