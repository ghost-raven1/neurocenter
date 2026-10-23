import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Request} from 'express';
import {DiscussionsService} from '../src/discussions/discussions.service';
import {DiscussionsRepository} from '../src/discussions/discussions.repository';
import type {DiscussionsPolicy,DiscussionActor} from '../src/discussions/discussions.policy';
import type {DiscussionsStorage} from '../src/discussions/discussions.storage';
import {DISCUSSIONS_SCHEMA_SQL} from '../src/discussions/discussions.schema';
import {deviceCompletionFixture,ownedDeviceTestAdminUrl} from './device-completion-postgres.fixture';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeatureEnabled:vi.fn(async()=>undefined)}));
vi.mock('../../../shared/feature-client.cjs',()=>({readFeatures:vi.fn(async()=>({flags:{discussions:true,discussion_attachments:false}}))}));
const adminUrl=process.env.DISCUSSIONS_TEST_ADMIN_PG_URL;
const actor:DiscussionActor={email:'writer@fixture.test',activeRole:'Разработчик',displayName:'Writer',claims:{email:'writer@fixture.test',projects:[],userRoles:['Разработчик'],pluginIds:[],skillPaths:[]}};

describe.skipIf(!adminUrl).sequential('Discussion counters on owned PostgreSQL with actual target/reply/tombstone rows',()=>{
 let fixture:Awaited<ReturnType<typeof deviceCompletionFixture>>,service:DiscussionsService;
 beforeAll(async()=>{
  ownedDeviceTestAdminUrl(adminUrl!);fixture=await deviceCompletionFixture(adminUrl!);await fixture.pool.query(DISCUSSIONS_SCHEMA_SQL);
  const repository=Object.assign(Object.create(DiscussionsRepository.prototype),{pool:fixture.pool}) as DiscussionsRepository;
  service=new DiscussionsService(repository,{input:()=>actor,actor:async()=>actor,target:async()=>undefined} as unknown as DiscussionsPolicy,{objects:null} as DiscussionsStorage);
 });
 afterAll(async()=>{if(fixture)expect(await fixture.dispose()).toMatchObject({dropped:true,originalDatabasesPreserved:true,newDatabasesRemaining:[]});});
 const add=async(type:'catalog'|'help',target:string,parent:string|null=null,deleted=false)=>{
  const id=randomUUID();await fixture.pool.query(`INSERT INTO discussion_comments(id,target_type,target_id,parent_id,body,author_email,author_name,request_key,request_hash,deleted_at)
   VALUES($1,$2,$3,$4,$5,$6,'Writer',$7,$8,$9)`,[id,type,target,parent,deleted?'':'body',actor.email,randomUUID(),'a'.repeat(64),deleted?new Date():null]);return id;
 };
 it('counts nondeleted replies beyond fifty visible rows, excludes other targets and keeps a child after parent deletion',async()=>{
  const parent=await add('catalog','mcp:sample');await add('catalog','mcp:sample',parent);
  for(let index=0;index<51;index++)await add('catalog','mcp:sample');
  await add('catalog','mcp:sample',null,true);await add('catalog','mcp:other');await add('help','mcp:sample');
  const page=await service.list({} as Request,{targetType:'catalog',targetId:'mcp:sample'});
  expect(page.items).toHaveLength(50);expect(page.nextCursor).toBeTypeOf('string');expect(page).toMatchObject({totalCount:53});
  const second=await service.list({} as Request,{targetType:'catalog',targetId:'mcp:sample',cursor:page.nextCursor!});
  expect(second).toMatchObject({totalCount:53});expect(second.items).toHaveLength(4);
  expect(second.items.some(item=>page.items.some(prior=>prior.id===item.id))).toBe(false);
  await expect(service.list({} as Request,{targetType:'catalog',targetId:'mcp:other',cursor:page.nextCursor!})).rejects.toMatchObject({status:400});
  expect(await service.reaction({} as Request,'mcp:sample')).toEqual({liked:false,count:0,commentCount:53});
  await service.remove({} as Request,parent,'1');
  expect(await service.reaction({} as Request,'mcp:sample',true)).toEqual({liked:true,count:1,commentCount:52});
  expect(await service.reaction({} as Request,'mcp:sample',false)).toEqual({liked:false,count:0,commentCount:52});
  expect((await fixture.pool.query('SELECT parent_id FROM discussion_comments WHERE parent_id=$1',[parent])).rowCount).toBe(1);
 });
 it('provides exact zero and help totals without mixing target types',async()=>{
  await add('help','models');await add('help','models',null,true);await add('help','getting-started');
  expect(await service.list({} as Request,{targetType:'help',targetId:'models'})).toMatchObject({totalCount:1});
  expect(await service.list({} as Request,{targetType:'help',targetId:'empty'})).toMatchObject({totalCount:0});
  expect(await service.reaction({} as Request,'model:empty')).toEqual({liked:false,count:0,commentCount:0});
 });
});
