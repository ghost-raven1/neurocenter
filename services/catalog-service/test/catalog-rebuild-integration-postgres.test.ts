import {afterEach,describe,expect,it,vi} from 'vitest';
import {actor,connection,integrationFixture,keeper} from './catalog-rebuild-integration-postgres.fixture';

describe.skipIf(!connection).sequential('Actual rebuild intent → service wiring → durable publication boundaries',()=>{
 let fixture:Awaited<ReturnType<typeof integrationFixture>>|undefined;
 afterEach(async()=>{await fixture?.close();fixture=undefined;});

 it('Reuses exact committed build/inline requests after lost ACK and service restart; revoked or changed actors cannot create another owner queue',async()=>{
  fixture=await integrationFixture({lostAck:true});const f=fixture,accepted=await f.jobs();
  const expected=f.bundle.plans.filter(plan=>['mcp','plugin'].includes(plan.kind)&&['prepared','local-project'].includes(plan.delivery.type));
  expect(accepted.builds).toHaveLength(expected.length);expect(accepted.inline).toHaveLength(1);
  expect(accepted.builds.every(row=>row.config.source.type==='bundled'&&row.config.source.revision===f.bundle.revision)).toBe(true);
  expect(accepted.builds.some(row=>row.config.kind==='skill'||/model-/.test('id' in row.config.source?row.config.source.id:''))).toBe(false);
  expect((await f.state())?.items.some(item=>item.state==='attention')).toBe(true);
  const ids={builds:accepted.builds.map(row=>row.id),inline:accepted.inline.map(row=>row.id)};
  await f.restart();const replayed=await f.jobs();
  expect(replayed.builds.map(row=>row.id)).toEqual(ids.builds);expect(replayed.inline.map(row=>row.id)).toEqual(ids.inline);
  expect((await f.state())?.items.filter(item=>item.operationId).map(item=>item.operationId)).toEqual(expect.arrayContaining([...ids.builds,...ids.inline]));
  await f.pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[actor.email]);
  await expect(f.build.request(actor,f.key(expected[0].id))).rejects.toMatchObject({status:403});
  await f.tick();expect((await f.state())?.state).toBe('attention');
  expect((await f.jobs()).builds.map(row=>row.id)).toEqual(ids.builds);
  await f.pool.query('UPDATE platform_users SET is_main_admin=true WHERE email=$1',[actor.email]);
  vi.stubEnv('DEV_USER_EMAIL',keeper.email);
  await expect(f.ports.rebuildRequest(keeper,f.key(expected[0].id),'build')).rejects.toMatchObject({status:409});
  await expect(f.ports.rebuildRequest(keeper,f.key('inline:0'),'inline')).rejects.toMatchObject({status:409});
  await f.tick();const after=await f.jobs();
  expect(after.builds.map(row=>row.id)).toEqual(ids.builds);expect(after.inline.map(row=>row.id)).toEqual(ids.inline);
  expect(after.builds.every(row=>row.actor===actor.email)).toBe(true);expect(after.inline.every(row=>row.actor===actor.email)).toBe(true);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM ai_plugins')).rows[0].n).toBe(0);
  expect(f.receipt.externalCalls).toEqual([]);
  f.receipt.checks.push('Actual onModuleInit FS wiring, lost commit ACK/restart no duplicate, revoked403 and changed-owner409 without new queues');
  f.receipt.snapshots.push({acceptedBuildJobs:ids.builds,acceptedInlineJobs:ids.inline,sourceRevision:f.bundle.revision,executed:0});
 },60000);

 it('Rejects a stale real FS source revision before creating any build or inline request',async()=>{
  fixture=await integrationFixture({revision:'f'.repeat(64)});const f=fixture;
  expect(await f.jobs()).toEqual({builds:[],inline:[]});expect((await f.state())?.state).toBe('attention');
  expect(f.buildWake).toHaveBeenCalledOnce();expect(f.inlineKick).not.toHaveBeenCalled();
  expect(f.receipt.externalCalls).toEqual([]);
  f.receipt.checks.push('Stale FS intent source revision fails closed before either durable queue');
 },60000);

 it.skipIf(process.env.CATALOG_REBUILD_ACTUAL_PRODUCER!=='1')('Actually builds one offline current JS recipe, verifies its OS runtime and publishes; a later manual head remains current and blocks automatic overwrite',async()=>{
  fixture=await integrationFixture();const f=fixture,jobs=await f.jobs();
  const row=jobs.builds.find(item=>item.config.source.type==='bundled'&&item.config.source.id==='plugin-git-context');
  expect(row).toBeTruthy();const before=(await f.sources.view()).sourcePlans.find(item=>item.id==='plugin-git-context');expect(before?.catalogReady).toBe(false);
  const completed=await f.executeOnly(row!.id);
  expect(completed.state,completed.error??completed.message).toBe('SUCCEEDED');
  const result=completed.result!;
  const runtime=await f.ports.repository.evidence(row!.id);
  expect(runtime.runtimeVerification).toMatchObject({ok:true,status:'passed',checks:{integrity:true,pluginFactory:true,hooks:true},isolation:{osEnforced:true,network:'denied',disposableProfile:true}});
  expect(runtime.runtimeVerification?.isolation.kind).toBe('darwin-seatbelt');
  const current=await f.plugins().get(result.catalogId);expect(current?.version).toBe(result.version);
  const receipt=(await f.pool.query('SELECT * FROM asset_source_receipts WHERE native_id=$1 AND active',[result.catalogId])).rows;
  expect(receipt).toHaveLength(1);expect(receipt[0]).toMatchObject({external_id:'plugin-git-context',native_version:result.version,repository:'local-archive'});
  expect(receipt[0].descriptor.source.type).toBe('archive');
  const currentPlan=(await f.sources.view()).sourcePlans.find(item=>item.id==='plugin-git-context');expect(currentPlan?.catalogReady).toBe(true);
  await f.tick();expect((await f.state())?.items.find(item=>item.id==='plugin-git-context')?.state).toBe('ready');
  const edited=await f.plugins().update(result.catalogId,{expectedVersion:result.version,description:'Own manual edit after verified automatic publication'},actor.email);
  expect(edited?.version).toBe(result.version+1);
  expect((await f.sources.view()).sourcePlans.find(item=>item.id==='plugin-git-context')?.catalogReady).toBe(false);
  await f.newIntent();await f.tick();
  expect((await f.state())?.items.find(item=>item.id==='plugin-git-context')?.state).toBe('attention');
  const after=(await f.jobs()).builds.filter(item=>item.config.source.type==='bundled'&&item.config.source.id==='plugin-git-context');
  expect(after.map(item=>item.id)).toEqual([row!.id]);expect(await f.plugins().get(result.catalogId)).toEqual(edited);
  expect((await f.pool.query('SELECT * FROM asset_source_receipts WHERE native_id=$1 AND active',[result.catalogId])).rows).toEqual(receipt);
  expect(f.receipt.externalCalls).toEqual([]);
  f.receipt.checks.push('Actual current bundled JS producer → enforced OS verification → source receipt/native version/build result atomic publication → accurate ready state → manual CAS preservation');
  f.receipt.snapshots.push({buildId:row!.id,result,runtime:runtime.runtimeVerification,publishedVersion:result.version,currentManualVersion:edited!.version,managedReceipt:receipt[0]});
 },120000);
});
