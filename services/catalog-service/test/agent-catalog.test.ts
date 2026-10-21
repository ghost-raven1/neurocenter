import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {AgentRepository} from '../src/agents/agent.repository';
import {ProjectAgentRepository} from '../src/agents/project-agent.repository';
import {connection,database,reset,main,admin,developer,definition} from './agent-postgres.fixture';
import {checkCatalogSchema} from '../src/database/catalog-schema';
import {effectiveDefinition} from '../src/agents/agent-validation';

describe.skipIf(!connection)('Native agents — actual canonical PostgreSQL',()=>{
 let fixture:Awaited<ReturnType<typeof database>>,pool:Pool,cards:AgentRepository,projects:ProjectAgentRepository;
 beforeAll(async()=>{fixture=await database();pool=fixture.pool;cards=new AgentRepository(pool);projects=new ProjectAgentRepository(pool);});
 afterAll(async()=>{await fixture?.close();});beforeEach(async()=>reset(pool));
 const create=async(fields={})=>cards.create(main,{requestKey:randomUUID(),slug:'nc-review',name:'Ревью',definition,...fields});
 const assign=async()=>{const card=await create();const result=await projects.assign(admin,'prj-agents',{requestKey:randomUUID(),expectedRevision:0,agentId:card.id,version:card.version,manifest:card.manifest});return {card,...result};};
 it('creates a durable idempotent card, rejects request reuse and preserves immutable history',async()=>{
  const input={requestKey:randomUUID(),slug:'nc-review',name:'Ревью',definition},first=await cards.create(main,input);
  expect(await cards.create(main,input)).toEqual(first);await expect(cards.create(main,{...input,name:'Changed'})).rejects.toMatchObject({status:409});
  const updated=await cards.update(main,first.id,{requestKey:randomUUID(),expectedVersion:1,definition:{...definition,prompt:'Новый промпт'}});
  expect(updated.version).toBe(2);expect((await cards.pinned(first.id,1,first.manifest)).definition.prompt).toBe(definition.prompt);
  await expect(pool.query('UPDATE agent_catalog_versions SET name=$2 WHERE agent_id=$1',[first.id,'Changed'])).rejects.toThrow('immutable');
  await expect(pool.query('DELETE FROM agent_catalog_versions WHERE agent_id=$1',[first.id])).rejects.toThrow('immutable');
  const audit=await pool.query('SELECT after_state AS after FROM security_events WHERE resource_id=$1',[first.id]);expect(JSON.stringify(audit.rows)).not.toContain(definition.prompt);expect(audit.rows[0].after.promptSha256).toMatch(/^[a-f0-9]{64}$/);
 });
 it('CAS rejects a stale editor; metadata-only description works; semantic no-op keeps its version',async()=>{
  const card=await create(),updated=await cards.update(main,card.id,{requestKey:randomUUID(),expectedVersion:1,description:'Новое описание'});
  expect(updated.definition.description).toBe('Новое описание');await expect(cards.update(main,card.id,{requestKey:randomUUID(),expectedVersion:1,name:'Old tab'})).rejects.toMatchObject({status:409});
  expect((await cards.update(main,card.id,{requestKey:randomUUID(),expectedVersion:2,name:updated.name})).version).toBe(2);
 });
 it('serializes concurrent card editors without losing a version',async()=>{
  const card=await create(),results=await Promise.allSettled(['One','Two'].map(name=>cards.update(main,card.id,{requestKey:randomUUID(),expectedVersion:1,name})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await cards.get(card.id)).version).toBe(2);
 });
 it('rolls back the card and request receipt when audit persistence fails',async()=>{
  await pool.query("CREATE FUNCTION reject_agent_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;CREATE TRIGGER reject_agent_audit BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION reject_agent_audit()");
  const input={requestKey:randomUUID(),slug:'nc-review',name:'Ревью',definition};
  try{await expect(cards.create(main,input)).rejects.toThrow('audit unavailable');expect((await cards.list())).toHaveLength(0);expect((await pool.query('SELECT * FROM agent_mutation_requests')).rowCount).toBe(0);}
  finally{await pool.query('DROP TRIGGER reject_agent_audit ON security_events;DROP FUNCTION reject_agent_audit()');}
  expect((await cards.create(main,input)).version).toBe(1);
 });
 it.each([admin,developer])('restricts common CRUD to the currently assigned main admin: $activeRole',async actor=>{await expect(cards.create(actor,{requestKey:randomUUID(),slug:'nc-review',name:'Ревью',definition})).rejects.toMatchObject({status:403});});
 it('revocation blocks even replay of a previously successful request',async()=>{
  const input={requestKey:randomUUID(),slug:'nc-review',name:'Ревью',definition};await cards.create(main,input);await pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[main.email]);
  await expect(cards.create(main,input)).rejects.toMatchObject({status:403});
 });
 it.each([
  {slug:'build'},{slug:'nc-../escape'},{name:' '},{name:'x'.repeat(129)},{name:'\ud800'}, {description:'Mismatch'},
  {definition:{...definition,prompt:' '}},{definition:{...definition,prompt:'я'.repeat(32769)}},{definition:{...definition,prompt:'\u0000'}},
  {definition:{...definition,description:'\ud800'}},{definition:{...definition,description:'я'.repeat(513)}},
  {definition:{...definition,permission:{edit:{'*':'allow'}}}},{definition:{...definition,permission:{shell:'allow'}}},
  {definition:{...definition,model:'https://user:secret@example.test/model'}},{definition:{...definition,temperature:3}},
  {definition:{...definition,topP:2}},{definition:{...definition,steps:0}},{definition:{...definition,tools:{bash:true}}},{extra:'unsupported'}
 ])('rejects unsupported or oversized input before any write #%#',async fields=>{await expect(create(fields)).rejects.toMatchObject({status:400});expect(await cards.list()).toEqual([]);});
 it('reserves a native slug without overwriting another card',async()=>{await create();await expect(create()).rejects.toMatchObject({status:409});expect(await cards.list()).toHaveLength(1);});
 it('pins exact immutable template bytes and starts disabled',async()=>{
  const {card,assignment,revision}=await assign();expect(revision).toBe(1);expect(assignment.enabled).toBe(false);
  await cards.update(main,card.id,{requestKey:randomUUID(),expectedVersion:1,definition:{...definition,prompt:'Changed global'}});
  expect((await projects.assignments('prj-agents'))[0].effective.prompt).toBe(definition.prompt);
 });
 it('applies project overrides, clears optional model values explicitly, resets and removes without losing settings',async()=>{
  const {card}=await assign();let saved=await projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,enabled:true,overrides:{prompt:'Project prompt',model:'provider/model',temperature:1}});
  expect(saved.assignment.effective.model).toBe('provider/model');expect(saved.assignment.enabled).toBe(true);
  saved=await projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:2,overrides:{prompt:'Keep me',model:null,temperature:null}});expect(saved.assignment.effective.model).toBeUndefined();
  const removed=await projects.remove(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:3});expect(removed.assignment).toMatchObject({enabled:false,removed:true});expect((await projects.snapshot('prj-agents')).agents).toEqual([]);
  const restored=await projects.assign(admin,'prj-agents',{requestKey:randomUUID(),expectedRevision:4,agentId:card.id,version:1,manifest:card.manifest});expect(restored.assignment).toMatchObject({enabled:false,removed:false,effective:{prompt:'Keep me'}});
  saved=await projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:5,overrides:{}});expect(saved.assignment.effective.prompt).toBe(definition.prompt);
 });
 it('null optional overrides clear values inherited from the template while omission inherits',()=>{
  const base={...definition,model:'provider/model',temperature:1,topP:0.9,steps:12};expect(effectiveDefinition(base,{}).effective).toEqual(base);
  expect(effectiveDefinition(base,{model:null,temperature:null,topP:null,steps:null}).effective).toEqual(definition);
 });
 it('rejects false version pins, duplicate assignment, stale mutation and invalid project overrides atomically',async()=>{
  const {card}=await assign();await expect(projects.assign(admin,'prj-agents',{requestKey:randomUUID(),expectedRevision:1,agentId:card.id,version:1,manifest:card.manifest})).rejects.toMatchObject({status:409});
  await expect(projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:0,enabled:true})).rejects.toMatchObject({status:409});
  await expect(projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,version:2,manifest:'a'.repeat(64)})).rejects.toMatchObject({status:409});
  await expect(projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,overrides:{permission:{shell:'allow'}}})).rejects.toMatchObject({status:400});expect(await projects.currentRevision('prj-agents')).toBe(1);
 });
 it('project permissions are checked from fresh rows, including revoked main role',async()=>{
  const {card}=await assign(),write={requestKey:randomUUID(),expectedRevision:1,enabled:true};
  await expect(projects.update(developer,'prj-agents',card.id,write)).rejects.toMatchObject({status:403});
  await pool.query('DELETE FROM project_members WHERE principal_name=$1',[admin.email]);await expect(projects.update(admin,'prj-agents',card.id,write)).rejects.toMatchObject({status:403});
  await pool.query("UPDATE platform_users SET is_main_admin=false WHERE email=$1;",[main.email]);await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES('prj-agents',$1,$1,'Admin','Админ проекта')",[main.email]);await expect(projects.update(main,'prj-agents',card.id,write)).rejects.toMatchObject({status:403});
 });
 it('serializes project editors and keeps audit prompt hashes safe',async()=>{
  const {card}=await assign(),results=await Promise.allSettled(['One','Two'].map(prompt=>projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,overrides:{prompt}})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await projects.currentRevision('prj-agents')).toBe(2);
  const audit=(await pool.query("SELECT before_state AS before,after_state AS after FROM security_events WHERE action='project.agent.update'")).rows[0];expect(audit.before.promptSha256).not.toBe(audit.after.promptSha256);expect(audit.before.revision).toBe(1);
 });
 it('semantic no-op project edits preserve revision and reject an explicit null overrides object',async()=>{
  const {card}=await assign();expect((await projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,enabled:false,overrides:{}})).revision).toBe(1);
  await expect(projects.update(admin,'prj-agents',card.id,{requestKey:randomUUID(),expectedRevision:1,overrides:null})).rejects.toMatchObject({status:400});expect(await projects.currentRevision('prj-agents')).toBe(1);
 });
 it('developer reads are limited to exact assigned versions rather than the new common head',async()=>{
  const {card}=await assign();await cards.update(main,card.id,{requestKey:randomUUID(),expectedVersion:1,definition:{...definition,prompt:'Unassigned new common prompt'}});
  expect((await cards.assigned(['prj-agents']))[0]).toMatchObject({version:1,definition:{prompt:definition.prompt}});expect(await cards.assigned(['prj-other'])).toEqual([]);
 });
 it('rejects native slug collisions across pinned historical versions without partial assignment',async()=>{
  const {card}=await assign();await cards.update(main,card.id,{requestKey:randomUUID(),expectedVersion:1,slug:'nc-renamed'});const another=await create();
  await expect(projects.assign(admin,'prj-agents',{requestKey:randomUUID(),expectedRevision:1,agentId:another.id,version:1,manifest:another.manifest})).rejects.toMatchObject({status:400});expect(await projects.currentRevision('prj-agents')).toBe(1);expect(await projects.assignments('prj-agents')).toHaveLength(1);
 });
 it('enforces the 32-agent full snapshot budget before committing the 33rd assignment',async()=>{
  for(let n=0;n<32;n++){const card=await create({slug:'nc-budget-'+n});await projects.assign(admin,'prj-agents',{requestKey:randomUUID(),expectedRevision:n,agentId:card.id,version:1,manifest:card.manifest});}
  const extra=await create({slug:'nc-budget-extra'});await expect(projects.assign(admin,'prj-agents',{requestKey:randomUUID(),expectedRevision:32,agentId:extra.id,version:1,manifest:extra.manifest})).rejects.toMatchObject({status:400});expect(await projects.currentRevision('prj-agents')).toBe(32);expect((await projects.snapshot('prj-agents')).agents).toHaveLength(32);
 });
 it('current readiness catches agent physical drift while frozen v0–6 remains untouched',async()=>{
  expect((await checkCatalogSchema(pool,true)).ready).toBe(true);await pool.query('ALTER TABLE agent_catalog DISABLE TRIGGER ALL');
  // The immutable version trigger is an owned physical contract.
  await pool.query('ALTER TABLE agent_catalog_versions DISABLE TRIGGER neurocenter_agent_version_immutable');await expect(checkCatalogSchema(pool,true)).rejects.toThrow('Схема агентов');
  await pool.query('ALTER TABLE agent_catalog ENABLE TRIGGER ALL;ALTER TABLE agent_catalog_versions ENABLE TRIGGER neurocenter_agent_version_immutable');
 });
});
