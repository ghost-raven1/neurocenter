import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {ownedAccessTestAdminUrl} from './access-write-postgres.fixture';
import {AccessDb} from '../src/access/access-db';
import {AccessController} from '../src/access/access.controller';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {CatalogController} from '../src/catalog/catalog.controller';
import {ProjectMemberRepository,projectMemberFromRow} from '../src/catalog/project-member-repository';

const adminUrl=process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL,cleanup:Array<()=>Promise<void>>=[];
const created:string[]=[],dropped:string[]=[];
const actor='actor@example.test',keeper='keeper@example.test',target='target@example.test';
const acting={email:actor,activeRole:'Главный админ'},keeping={email:keeper,activeRole:'Главный админ'},projectActor={email:actor,activeRole:'Админ проекта'};
const token='owned-earlier-access-qa-token';
const previousToken=process.env.NEUROCENTER_INTERNAL_TOKEN;
const request={headers:{'x-neurocenter-internal':token,'x-bridge-actor':encodeURIComponent(JSON.stringify({email:actor,activeRole:'Главный админ'}))}};
const deferred=()=>{let resolve!:(value?:unknown)=>void;return{promise:new Promise(resolve_=>{resolve=resolve_;}),resolve};};
function access(pool:unknown){const db=Object.create(AccessDb.prototype) as AccessDb;Object.defineProperty(db,'pool',{value:pool});return db;}
describe.skipIf(!adminUrl).sequential('Administrative write serialization on actual owned PostgreSQL',()=>{
 beforeAll(()=>{ownedAccessTestAdminUrl(adminUrl!);process.env.NEUROCENTER_INTERNAL_TOKEN=token;});
 afterAll(async()=>{if(previousToken===undefined)delete process.env.NEUROCENTER_INTERNAL_TOKEN;else process.env.NEUROCENTER_INTERNAL_TOKEN=previousToken;if(process.env.ACCESS_WRITE_TEST_CLEANUP)await writeFile(process.env.ACCESS_WRITE_TEST_CLEANUP,JSON.stringify({created,dropped},null,2)+'\n',{flag:'wx',mode:0o600});});
 afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
 async function fixture(){
  const url=ownedAccessTestAdminUrl(adminUrl!);
  const database='nc_earlier_access_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:adminUrl,max:1});await admin.query('CREATE DATABASE '+database);created.push(database);url.pathname='/'+database;
  const pool=new Pool({connectionString:url.href,max:4}),observer=new Pool({connectionString:url.href,max:1});cleanup.push(async()=>{await observer.end();await pool.end();await admin.query('DROP DATABASE '+database);dropped.push(database);await admin.end();});
  await ensureCatalogSchema(pool);await pool.query('INSERT INTO platform_users(email,display_name,is_main_admin) VALUES($1,$1,true),($2,$2,true),($3,$3,false)',[actor,keeper,target]);
  return{pool,observer,database,access:access(pool)};
 }
 it('denies a fresh main-admin request after platform rights have been revoked',async()=>{
  const f=await fixture();await f.access.save({email:actor,isMainAdmin:false},keeping);
  await expect(new AccessController(f.access).save(request as never,{email:target,isMainAdmin:true})).rejects.toMatchObject({status:403});
  expect((await f.observer.query('SELECT is_main_admin FROM platform_users WHERE email=$1',[target])).rows[0].is_main_admin).toBe(false);
 });
 it.each(['demote','disable'] as const)('denies a main-admin mutation queued behind a committed %s',async reason=>{
  const f=await fixture(),paused=deferred(),resume=deferred();let commitPaused=false;
  const revoker=access({connect:async()=>{const client=await f.pool.connect(),query=client.query.bind(client);return{query:async(sql:string,...args:unknown[])=>{if(sql==='COMMIT'&&!commitPaused){commitPaused=true;paused.resolve();await resume.promise;}return (query as (...input:unknown[])=>Promise<unknown>)(sql,...args);},release:()=>client.release()};}});
  const revocation=revoker.save({email:actor,...(reason==='demote'?{isMainAdmin:false}:{enabled:false})},keeping);
  let pending:Promise<unknown>|undefined;
  try{
   await paused.promise;
   // The old request can still read committed main-admin rights while the revocation transaction is open.
   pending=new AccessController(f.access).save(request as never,{email:target,isMainAdmin:true});pending.catch(()=>undefined);
   let waiting=false;for(let i=0;i<200;i++){const rows=(await f.observer.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock(72465381)%'",[f.database])).rows;if(rows.length){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
   expect(waiting).toBe(true);
   resume.resolve();await revocation;
   const result=await pending.then(value=>({status:'fulfilled',value}),error=>({status:'rejected',code:error.getStatus?.()}));
   const saved=(await f.observer.query('SELECT is_main_admin FROM platform_users WHERE email=$1',[target])).rows[0].is_main_admin;
   expect(result).toMatchObject({status:'rejected',code:403});expect(saved).toBe(false);
  }finally{resume.resolve();await revocation.catch(()=>undefined);await pending?.catch(()=>undefined);}
 });
 it.each(['revoke-project','disable-account'] as const)('denies a project-member mutation queued behind a committed %s',async reason=>{
  const f=await fixture(),project='prj-'+randomUUID(),targetId='u-'+target;
  await f.pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[actor]);
  await f.pool.query('INSERT INTO projects(id,name) VALUES($1,$1)',[project]);
  await f.pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role,added_at) VALUES($1,$2,$3,$3,'Админ проекта',now()),($1,$4,$5,$5,'Наблюдатель',now())",[project,'u-'+actor,actor,targetId,target]);
  const members=new ProjectMemberRepository(f.pool),catalog={listProjectMembers:async(id:string)=>(await f.pool.query('SELECT * FROM project_members WHERE project_id=$1',[id])).rows.map(projectMemberFromRow),updateProjectMemberRole:members.update.bind(members)};
  const controller=new CatalogController(catalog as never,f.access),projectRequest={headers:{'x-bridge-principal':actor,'x-bridge-actor':encodeURIComponent(JSON.stringify({email:actor,activeRole:'Админ проекта'}))}};
  const blocker=await f.pool.connect();let pending:Promise<unknown>|undefined;
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(72465381)');await blocker.query('SELECT * FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE',[project,targetId]);
   pending=controller.updateProjectMember(project,targetId,{role:'Разработчик',expectedRole:'Наблюдатель'},projectRequest as never);pending.catch(()=>undefined);
   let waiting=false;for(let i=0;i<200;i++){const rows=(await f.observer.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND (query LIKE 'SELECT * FROM project_members WHERE project_id=%FOR UPDATE' OR query LIKE '%pg_advisory_xact_lock(72465381)%')",[f.database])).rows;if(rows.length){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(waiting).toBe(true);
   if(reason==='revoke-project')await blocker.query('DELETE FROM project_members WHERE project_id=$1 AND principal_name=$2',[project,actor]);else await blocker.query('UPDATE platform_users SET enabled=false WHERE email=$1',[actor]);
   await blocker.query('COMMIT');
   const result=await pending.then(value=>({status:'fulfilled',value}),error=>({status:'rejected',code:error.getStatus?.()})),saved=(await f.observer.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2',[project,targetId])).rows[0].role;
   expect(result).toMatchObject({status:'rejected',code:403});expect(saved).toBe('Наблюдатель');
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>undefined);}
 });
 async function projectFixture(keepMain=false){
  const f=await fixture(),project='prj-'+randomUUID(),targetId='u-'+target;
  if(!keepMain)await f.pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[actor]);
  await f.pool.query('INSERT INTO projects(id,name) VALUES($1,$1)',[project]);
  await f.pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role,added_at) VALUES($1,$2,$3,$3,'Админ проекта',now()),($1,$4,$5,$5,'Наблюдатель',now())",[project,'u-'+actor,actor,targetId,target]);
  const members=new ProjectMemberRepository(f.pool),catalog={listProjectMembers:async(id:string)=>(await f.pool.query('SELECT * FROM project_members WHERE project_id=$1',[id])).rows.map(projectMemberFromRow),updateProjectMemberRole:members.update.bind(members)};
  return{...f,project,targetId,members,controller:new CatalogController(catalog as never,f.access),projectRequest:{headers:{'x-bridge-principal':actor,'x-bridge-actor':encodeURIComponent(JSON.stringify(projectActor))}}};
 }
 it('does not inherit the platform privilege while the active role is project administrator',async()=>{
  const f=await projectFixture(true);
  await expect(f.members.update(f.project,f.targetId,'Админ проекта','Наблюдатель',projectActor)).rejects.toMatchObject({status:403});
  await expect(f.members.remove(f.project,'u-'+actor,'Админ проекта',projectActor)).rejects.toMatchObject({status:403});
  expect((await f.observer.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2',[f.project,f.targetId])).rows[0].role).toBe('Наблюдатель');
 });
 it('does not create a project assignment from an account created before the grant was revoked',async()=>{
  const f=await projectFixture(),email='new@example.test';
  await f.access.ensureProjectUser({email,displayName:'New'},projectActor,f.project);
  expect((await f.observer.query('SELECT email FROM platform_users WHERE email=$1',[email])).rows).toHaveLength(1);
  expect(await f.members.remove(f.project,'u-'+actor,'Админ проекта',keeping)).toBe(true);
  await expect(f.members.add(f.project,{userId:'u-'+email,principalName:email,displayName:'New',role:'Наблюдатель',addedAt:new Date().toISOString()},projectActor)).rejects.toMatchObject({status:403});
  expect((await f.observer.query('SELECT * FROM project_members WHERE project_id=$1 AND principal_name=$2',[f.project,email])).rows).toEqual([]);
 });
 it('preserves the last active main administrator under concurrent cross-demotion',async()=>{
  const f=await fixture(),changes=await Promise.allSettled([f.access.save({email:keeper,isMainAdmin:false},acting),f.access.save({email:actor,isMainAdmin:false},keeping)]);
  expect(changes.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(changes.filter(result=>result.status==='rejected')).toHaveLength(1);
  expect((await f.observer.query('SELECT email FROM platform_users WHERE is_main_admin AND enabled')).rows).toHaveLength(1);
 });
 it('rejects a stale platform-user draft without altering the user or audit',async()=>{
  const f=await fixture();await f.access.save({email:target,displayName:'Current'},acting);
  const before=(await f.observer.query('SELECT * FROM security_events')).rows;
  await expect(f.access.save({email:target,displayName:'Stale',expected:{displayName:target,isMainAdmin:false,enabled:true}},acting)).rejects.toMatchObject({status:409});
  expect((await f.observer.query('SELECT display_name FROM platform_users WHERE email=$1',[target])).rows[0].display_name).toBe('Current');
  expect((await f.observer.query('SELECT * FROM security_events')).rows).toEqual(before);
 });
 it('retains target-role CAS after a concurrent change while waiting for administration admission',async()=>{
  const f=await projectFixture(),blocker=await f.pool.connect();let pending:Promise<unknown>|undefined;
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(72465381)');
   pending=f.controller.updateProjectMember(f.project,f.targetId,{role:'Разработчик',expectedRole:'Наблюдатель'},f.projectRequest as never);pending.catch(()=>undefined);
   let waiting=false;for(let i=0;i<200;i++){if((await f.observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event='advisory'",[f.database])).rowCount){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(waiting).toBe(true);
   await blocker.query("UPDATE project_members SET role='Разработчик' WHERE project_id=$1 AND user_id=$2",[f.project,f.targetId]);await blocker.query('COMMIT');
   await expect(pending).rejects.toMatchObject({status:409});
   expect((await f.observer.query("SELECT * FROM security_events WHERE action='project.member.update'")).rows).toEqual([]);
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>undefined);}
 });
 it('commits an already admitted member change before a waiting revocation and rejects the following change',async()=>{
  const f=await projectFixture(),paused=deferred(),resume=deferred();let commitPaused=false;
  const pool={connect:async()=>{const client=await f.pool.connect(),query=client.query.bind(client);return{query:async(sql:string,...args:unknown[])=>{if(sql==='COMMIT'&&!commitPaused){commitPaused=true;paused.resolve();await resume.promise;}return (query as (...input:unknown[])=>Promise<unknown>)(sql,...args);},release:()=>client.release()};}};
  const members=new ProjectMemberRepository(pool as unknown as Pool),write=members.update(f.project,f.targetId,'Разработчик','Наблюдатель',projectActor);let revocation:Promise<unknown>|undefined;
  try{
   await paused.promise;revocation=f.access.save({email:actor,enabled:false},keeping);revocation.catch(()=>undefined);
   let waiting=false;for(let i=0;i<200;i++){if((await f.observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event='advisory'",[f.database])).rowCount){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(waiting).toBe(true);
   expect((await f.observer.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2',[f.project,f.targetId])).rows[0].role).toBe('Наблюдатель');
   resume.resolve();await expect(write).resolves.toMatchObject({role:'Разработчик'});await revocation;
   await expect(f.members.update(f.project,f.targetId,'Наблюдатель','Разработчик',projectActor)).rejects.toMatchObject({status:403});
   expect((await f.observer.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2',[f.project,f.targetId])).rows[0].role).toBe('Разработчик');
  }finally{resume.resolve();await write.catch(()=>undefined);await revocation?.catch(()=>undefined);}
 });
});
