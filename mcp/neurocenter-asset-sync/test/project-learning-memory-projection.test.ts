import {describe,expect,it,vi} from 'vitest';
import {assertProjectionJournal,projectMemory,type ProjectionJournal} from '../src/features/project-learning-memory-sync/projection.js';
import {memoryDigest,memoryNamespace,type MemoryEntity} from '../src/features/project-learning-memory-sync/contract.js';
import type {MemoryPort} from '../src/features/project-learning-memory-sync/memory-client.js';

const namespace=memoryNamespace('https://fixture.invalid','project-fixture'),digest=memoryDigest('approved-fixture');
const entity=(key:string,observation='approved fixture'):MemoryEntity=>({name:namespace+key,entityType:'neurocenter.approved-project-knowledge.v1',observations:[observation]});
function fixture(){
 const graph=new Map<string,MemoryEntity>(),mutations:string[]=[],snapshots:ProjectionJournal[]=[];
 const journal:ProjectionJournal={schemaVersion:1,namespace,owned:{}};
 const port:MemoryPort={nodes:async names=>names.flatMap(name=>graph.has(name)?[structuredClone(graph.get(name)!)]:[]),
  create:async item=>{mutations.push('create');graph.set(item.name,structuredClone(item));},
  add:async(name,values)=>{mutations.push('add');graph.get(name)!.observations.push(...values);},
  remove:async(name,values)=>{mutations.push('remove');const node=graph.get(name);if(node)node.observations=node.observations.filter(text=>!values.includes(text));},close:async()=>{}};
 const save=async(value:ProjectionJournal)=>{snapshots.push(structuredClone(value));};
 const run=(desired:MemoryEntity[],plan=digest,cleanup=false,authorize=async()=>{})=>projectMemory(port,journal,desired,plan,cleanup,save,authorize,async()=>{});
 return {graph,mutations,snapshots,journal,port,save,run};
}

describe('Approved learning projection and durable Memory boundaries',()=>{
 it('persists intent before mutation, creates only approved managed names and verifies the answer',async()=>{
  const f=fixture(),approved=entity('approved'),create=f.port.create;
  f.port.create=async item=>{expect(f.snapshots.at(-1)?.plan?.steps[0].state).toBe('intent');await create(item);};
  expect(await f.run([approved])).toEqual({applied:1,removed:0,remaining:0});expect(f.graph.get(approved.name)).toEqual(approved);
  expect(f.mutations).toEqual(['create']);expect(f.journal.owned[approved.name]).toEqual(approved);
 });
 it('checkpoints the complete pending step count before the first mutation',async()=>{
  const f=fixture(),checkpoint=vi.fn(async()=>{}),create=f.port.create;
  f.port.create=async item=>{expect(checkpoint).toHaveBeenCalledWith(0,0,2);await create(item);};
  await projectMemory(f.port,f.journal,[entity('first'),entity('second')],digest,false,f.save,async()=>{},checkpoint);
 });
 it('lost tool ACK recovers an applied mutation by read, with no duplicate mutation',async()=>{
  const f=fixture(),approved=entity('approved'),create=f.port.create;
  f.port.create=async item=>{await create(item);throw new Error('ACK lost');};
  await expect(f.run([approved])).rejects.toThrow('ACK lost');expect(f.journal.plan!.steps[0].state).toBe('intent');
  f.port.create=create;expect(await f.run([approved])).toEqual({applied:1,removed:0,remaining:0});expect(f.mutations).toEqual(['create']);
 });
 it('resumes a durable intent after process loss without automatically reapplying it',async()=>{
  const f=fixture(),approved=entity('approved');await f.run([approved]);
  const saved=f.snapshots.find(snapshot=>snapshot.plan?.steps[0].state==='intent')!;
  expect(await projectMemory(f.port,saved,[approved],digest,false,f.save,async()=>{},async()=>{})).toEqual({applied:1,removed:0,remaining:0});
  expect(f.mutations).toEqual(['create']);
 });
 it('replaces owned text while preserving manual observations',async()=>{
  const f=fixture(),approved=entity('approved','old');await f.run([approved]);f.graph.get(approved.name)!.observations.push('manual note');
  await f.run([entity('approved','new')],memoryDigest('new'));
  expect(f.graph.get(approved.name)!.observations).toEqual(['manual note','new']);
  expect(f.mutations).toEqual(['create','add','remove']);
 });
 it('cleanup removes only revoked owned observations and never applies updated or new knowledge',async()=>{
  const f=fixture(),a=entity('revoked'),b=entity('retained','old');await f.run([a,b]);f.graph.get(a.name)!.observations.push('manual');
  f.graph.get(b.name)!.observations.push('manual version note');
  await f.run([entity('retained','new'),entity('new')],memoryDigest('cleanup'),true);
  expect(f.graph.get(a.name)!.observations).toEqual(['manual']);expect(f.graph.get(b.name)!.observations).toEqual(['manual version note']);expect(f.graph.has(namespace+'new')).toBe(false);
  expect(f.mutations).toEqual(['create','create','remove','remove']);
 });
 it.each(['delete','type','observation'])('unchanged source detects external %s after an earlier completed receipt',async change=>{
  const f=fixture(),approved=entity('approved');await f.run([approved]);
  if(change==='delete')f.graph.delete(approved.name);else if(change==='type')f.graph.get(approved.name)!.entityType='manual';else f.graph.get(approved.name)!.observations=[];
  await expect(f.run([approved])).rejects.toMatchObject({code:'conflict'});expect(f.mutations).toEqual(['create']);
 });
 it('rejects a preexisting unmanaged node before any planned mutation',async()=>{
  const f=fixture(),first=entity('first'),collision=entity('collision');f.graph.set(collision.name,{...collision,entityType:'manual'});
  await expect(f.run([first,collision])).rejects.toMatchObject({code:'conflict'});expect(f.mutations).toEqual([]);
 });
 it.each(['entries','observation','read'])('preflights the whole %s quota before any mutation',async kind=>{
  const f=fixture(),approved=entity('approved');let desired=[approved];
  if(kind==='entries')desired=Array.from({length:33},(_,index)=>entity(String(index)));
  if(kind==='observation')desired=[entity('approved','x'.repeat(21*1024))];
  if(kind==='read')f.port.nodes=async()=>[{...approved,observations:['x'.repeat(2*1024*1024)]}];
  await expect(f.run(desired)).rejects.toMatchObject({code:'quota'});expect(f.mutations).toEqual([]);
 });
 it('rechecks authorization after saving intent and before the MCP write',async()=>{
  const f=fixture(),authorize=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('permission revoked'));
  await expect(f.run([entity('approved')],digest,false,authorize)).rejects.toThrow('permission revoked');expect(f.mutations).toEqual([]);expect(f.journal.plan!.steps[0].state).toBe('intent');
 });
 it('new approved source reconciles an old uncertain write and then revokes its own observation',async()=>{
  const f=fixture(),approved=entity('approved'),create=f.port.create;f.port.create=async item=>{await create(item);throw new Error('ACK lost');};
  await expect(f.run([approved])).rejects.toThrow();f.port.create=create;
  await f.run([],memoryDigest('revoked'));expect(f.graph.get(approved.name)!.observations).toEqual([]);expect(f.mutations).toEqual(['create','remove']);
 });
 it.each(['namespace','delta','ownership','steps'])('refuses corrupt persisted %s before tool calls',async kind=>{
  const f=fixture(),approved=entity('approved');await f.run([approved]);
  const step={kind:'remove',name:approved.name,before:approved,after:{...approved,observations:[]},values:approved.observations,state:'pending'};
  const broken=structuredClone({...f.journal,plan:{digest,steps:[step]}}) as ProjectionJournal;
  if(kind==='namespace')broken.plan!.steps[0].name='other-site:manual';
  if(kind==='delta')broken.plan!.steps[0].after.observations=['unrecorded replacement'];
  if(kind==='ownership')broken.plan!.steps[0].before!.observations=['manual'];
  if(kind==='steps')broken.plan!.steps=Array(257).fill(step);
  const reads=vi.spyOn(f.port,'nodes');expect(()=>assertProjectionJournal(broken,namespace)).toThrow();
  await expect(projectMemory(f.port,broken,[],digest,true,f.save,async()=>{},async()=>{})).rejects.toThrow();expect(reads).not.toHaveBeenCalled();expect(f.mutations).toEqual(['create']);
 });
});
