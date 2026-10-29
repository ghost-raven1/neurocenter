import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {DeviceJobs} from '../src/devices/device-jobs';
import {createMcpFixture,deviceId,gatewayUrl,listResult,owner,project,request,token,bindingId,instanceId,type McpFixture} from './system-role-mcp-postgres.fixture';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:async()=>{}}));
const connection=process.env.DEVICE_PRESENCE_TEST_ADMIN_URL;
const presence={platform:'linux',arch:'x64',runtimeVersion:'24.22.0',bridgeVersion:'0.9.27',buildId:'a'.repeat(64),protocolVersion:2};

/** Real JSONB, authority and claim owners in a disposable explicit test database; no MCP/model or shared database. */
describe.skipIf(!connection).sequential('Degraded presence preserves admitted work on owned PostgreSQL',()=>{
    let f:McpFixture,healthy:Record<string,unknown>;
    beforeAll(async()=>{f=await createMcpFixture(connection);},60_000);
    beforeEach(async()=>{
        vi.stubEnv('CATALOG_PG_URL','postgresql://forbidden@127.0.0.1:1/forbidden');
        vi.stubEnv('API_GATEWAY_URL',gatewayUrl);vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','native-fixture-internal');
        vi.stubGlobal('fetch',f.fetchBoundary);await f.reset();
        const device=await f.devices.identity(token);
        healthy={...device.report,capabilities:[...device.report.capabilities as string[],'install-set-v1'],root:'/owned-fixture',folders:['folder'],installations:[{id:'retained-fixture'}],
            bindings:(device.report.bindings as Array<Record<string,unknown>>).map(binding=>({...binding,folderName:'folder'}))};
        await f.devices.heartbeat(device,healthy);
    });
    afterEach(async()=>{if(f){await f.stop();expect(f.transportViolations).toEqual([]);}vi.unstubAllGlobals();vi.unstubAllEnvs();});
    afterAll(async()=>{await f?.close();});
    const discover=()=>f.service.discover(request(),{projectId:project,target:f.target('device'),requestId:randomUUID()});
    const claim=()=>f.service.channel.claim(token,{requestId:randomUUID(),recoveryOnly:false});
    const snapshot=async()=>(await f.devices.identity(token)).report;

    it('retains capabilities and bindings for live MCP authorization while fencing the next private claim until a full report recovers',async()=>{
        await discover();const active=(await claim())!;expect(active).toBeTruthy();
        const second=await discover(),pending=await f.service.repository.discovery(second.id,owner);
        await f.devices.presence(await f.devices.identity(token),presence);
        expect(await snapshot()).toMatchObject({reportUnavailable:true,capabilities:healthy.capabilities,bindings:healthy.bindings,installations:healthy.installations});
        expect(await f.service.channel.authorize(token,{jobId:active.id,lease:active.lease})).toEqual({ok:true,closed:false});
        const call=await f.service.channel.next(token,{jobId:active.id,lease:active.lease});expect(call).toBeTruthy();
        await f.service.channel.dispatch(token,{jobId:active.id,lease:active.lease,callId:(call as {id:string}).id});
        expect(await claim()).toBeNull();expect((await f.service.repository.session(pending!.session_id)).claimed_at).toBeNull();
        await f.service.channel.result(token,{jobId:active.id,lease:active.lease,callId:(call as {id:string}).id,result:listResult});
        await f.service.channel.complete(token,{jobId:active.id,lease:active.lease,result:{schemaVersion:1,sessionId:active.id,closed:true}});
        await f.devices.heartbeat(await f.devices.identity(token),healthy);
        expect(await snapshot()).not.toHaveProperty('reportUnavailable');expect((await claim())?.id).toBe(pending!.session_id);
    });

    it('keeps a running installation authorizable and its queued peer untouched until recovery',async()=>{
        const approved=await f.plans.approvedInstalled(project,f.remote);
        const payload={...approved,assetKind:'mcp',assetId:f.remote.plugin.id,version:1,bindingId,instanceId};
        const running=await f.job('install',payload,'running'),queued=await f.job('choose-root',{},'queued');
        const lease=(await f.pool.query('SELECT lease FROM bridge_jobs WHERE id=$1',[running])).rows[0].lease;
        const jobs=new DeviceJobs(f.devices,{}as never,f.installations,f.plans,{}as never);
        expect(await jobs.authorize(await f.devices.identity(token),running,lease)).toMatchObject({ok:true});
        await f.devices.presence(await f.devices.identity(token),presence);
        expect(await jobs.authorize(await f.devices.identity(token),running,lease)).toMatchObject({ok:true});
        expect(await jobs.claim(await f.devices.identity(token))).toBeNull();
        expect((await f.pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[queued])).rows[0].state).toBe('queued');
        await f.pool.query("UPDATE bridge_jobs SET state='succeeded' WHERE id=$1",[running]);
        expect(await jobs.claim(await f.devices.identity(token))).toBeNull();
        await f.devices.heartbeat(await f.devices.identity(token),healthy);
        expect(await jobs.claim(await f.devices.identity(token))).toMatchObject({id:queued,state:'running'});
    });
});
