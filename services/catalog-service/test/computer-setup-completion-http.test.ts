import 'reflect-metadata';
import {Controller,Module,UnauthorizedException,ForbiddenException,type INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {DeviceController} from '../src/devices/device.controller';
import {digest,type DeviceStore} from '../src/devices/device-store';

const token='a'.repeat(64),otherToken='b'.repeat(64),deviceId='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222',lease='33333333-3333-4333-8333-333333333333';
const device={id:deviceId,email:'cli@fixture.test',role:'Наблюдатель',report:{capabilities:['opencode-cli-v1']}};
const result={schemaVersion:1,scope:'global',deviceId,jobId,checkedAt:'2026-10-27T00:00:00.000Z',status:'installed',version:'1.14.48'};

/** Actual controller channel identity and completion routing, with no access to a running service or user database. */
describe.sequential('CLI terminal ACK identity through the actual Nest controller',()=>{
    let job:Record<string,unknown>,credential:string,revoked:boolean,enabled:boolean,roleAssigned:boolean,expired:boolean;
    const query=vi.fn(),transaction=vi.fn(),identity=vi.fn(),release=vi.fn();
    const httpFetch=globalThis.fetch;
    let app:INestApplication,base:string;
    const complete=(selectedToken=token,selectedId=jobId,selectedLease=lease,selectedResult:Record<string,unknown>=result)=>httpFetch(base+'/internal/device-channel/jobs/'+selectedId+'/complete',{
        method:'POST',headers:{'content-type':'application/json','x-neurocenter-internal':'cli-completion-fixture',authorization:'Bearer '+selectedToken},
        body:JSON.stringify({lease:selectedLease,state:'succeeded',message:'private',result:selectedResult})});
    beforeAll(async()=>{
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','cli-completion-fixture');
        const store={pool:{query,connect:async()=>({query:transaction,release})},identity} as unknown as DeviceStore;
        class HttpController extends DeviceController {constructor(){super(store,{} as never,{} as never,{} as never,{} as never);}}
        Controller()(HttpController);Reflect.defineMetadata('design:paramtypes',[],HttpController);
        class HttpFixture {}Module({controllers:[HttpController]})(HttpFixture);
        app=await NestFactory.create(HttpFixture,{logger:false});await app.listen(0,'127.0.0.1');base=await app.getUrl();
    });
    beforeEach(()=>{
        vi.clearAllMocks();credential=digest(token);revoked=false;enabled=true;roleAssigned=true;expired=false;
        job={id:jobId,device_id:deviceId,email:device.email,role:device.role,kind:'inspect-opencode-cli',project_id:null,state:'succeeded',
            payload:{schemaVersion:1,scope:'global',deviceId},lease,result,started_at:new Date()};
        query.mockImplementation(async(_sql:string,args:unknown[])=>({rows:credential===args[0]&&job.id===args[1]&&job.lease===args[2]
            &&Array.isArray(args[3])&&args[3].includes(job.kind)&&job.email===device.email&&job.device_id===deviceId&&job.started_at&&['succeeded','failed','cancelled'].includes(String(job.state))?[device]:[]}));
        identity.mockImplementation(async selectedToken=>{
            if(digest(selectedToken)!==credential||revoked||expired)throw new UnauthorizedException('Connection expired or revoked');
            if(!enabled||!roleAssigned)throw new ForbiddenException('Account or role revoked');return device;
        });
        transaction.mockImplementation(async(sql:string,args:unknown[])=>({rows:sql.startsWith('SELECT * FROM bridge_jobs')&&job.id===args[0]&&job.device_id===args[1]&&job.lease===args[2]?[job]:[]}));
        vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('Terminal ACK must not notify or contact providers');}));
    });
    afterEach(()=>vi.unstubAllGlobals());
    afterAll(async()=>{await app?.close();vi.unstubAllEnvs();});
    it.each(['revoked','expired','account','role'])('a terminal exact ACK survives %s without a new execution or result read',async cause=>{
        revoked=cause==='revoked';expired=cause==='expired';enabled=cause!=='account';roleAssigned=cause!=='role';
        const response=await complete();expect(response.status).toBe(201);expect(await response.json()).toEqual({ok:true,repeated:true});
        expect(identity).not.toHaveBeenCalled();expect(transaction.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE')||String(sql).includes('INSERT INTO operations'))).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('a cancelled late ACK returns only cancellation and ignores its result',async()=>{
        job.state='cancelled';job.result=null;revoked=true;
        const response=await complete();expect(response.status).toBe(201);expect(await response.json()).toEqual({ok:true,repeated:true,cancelled:true});
        expect(transaction.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE'))).toBe(false);
    });
    it('a terminal installation ACK uses the same exact identity after revocation without publishing again',async()=>{
        const source={buildId:'c'.repeat(64),target:'linux-x64',version:'1.14.48',sha256:'d'.repeat(64)};
        const installed={schemaVersion:1,scope:'global',deviceId,source,jobId,checkedAt:result.checkedAt,status:'installed',installedVersion:'1.14.48',commandVersion:null,commandReady:false,nextAction:'inspect-path'};
        job.kind='install-opencode-cli';job.payload={schemaVersion:1,scope:'global',deviceId,source};job.result=installed;revoked=true;
        const response=await complete(token,jobId,lease,installed);expect(response.status).toBe(201);expect(await response.json()).toEqual({ok:true,repeated:true});
        expect(identity).not.toHaveBeenCalled();expect(transaction.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE')||String(sql).includes('INSERT INTO operations'))).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each(['running','reconciling'])('the fallback never authorizes the first %s completion after revocation',async state=>{
        job.state=state;job.result=null;revoked=true;
        expect((await complete()).status).toBe(401);expect(identity).toHaveBeenCalledWith(token);expect(transaction).not.toHaveBeenCalled();
    });
    it.each(['rotation','foreign-device','foreign-owner','foreign-lease','unknown-job','deleted-job','reset-retired-job'] as const)('receipt identity fails closed for %s',async cause=>{
        revoked=true;
        if(cause==='rotation')credential=digest(otherToken);
        else if(cause==='foreign-device')job.device_id='44444444-4444-4444-8444-444444444444';
        else if(cause==='foreign-owner')job.email='other@fixture.test';
        else if(cause==='deleted-job'||cause==='reset-retired-job')job={};
        const response=await complete(token,cause==='unknown-job'?'55555555-5555-4555-8555-555555555555':jobId,cause==='foreign-lease'?'66666666-6666-4666-8666-666666666666':lease);
        expect(response.status).toBe(401);expect(transaction).not.toHaveBeenCalled();
    });
    it('another token and another terminal observation cannot replace the accepted receipt',async()=>{
        revoked=true;expect((await complete(otherToken)).status).toBe(401);expect(transaction).not.toHaveBeenCalled();
        job.result={...result,version:'1.14.49'};
        const response=await complete();expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:'computer-setup-receipt-conflict'});
        expect(transaction.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE'))).toBe(false);
    });
});
