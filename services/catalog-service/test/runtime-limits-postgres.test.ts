import 'reflect-metadata';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {ForbiddenException} from '@nestjs/common';
import type {Request} from 'express';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ownedTestPostgresAdmin} from '../../../scripts/test/owned-postgres.fixture.mjs';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {assertRuntimeLimitsSchema} from '../src/runtime-limits/runtime-limits.schema-verification';
import {RuntimeLimitsService} from '../src/runtime-limits/runtime-limits.service';
import {DEFAULT_RUNTIME_LIMIT_POLICY,type RuntimeLimitInput} from '../../shared/runtime-limits.cjs';
import {requireFeatureEnabled} from '../src/features/require-feature-enabled';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeatureEnabled:vi.fn()}));
const connection=process.env.RUNTIME_LIMITS_TEST_ADMIN_URL,owner='owner@runtime-limits.test',other='other@runtime-limits.test';
const request=(email=owner)=>({headers:{'x-test-email':email}}as unknown as Request);
const input=(revision=0):RuntimeLimitInput=>({expectedRevision:revision,requestKey:randomUUID(),policy:structuredClone(DEFAULT_RUNTIME_LIMIT_POLICY)});

describe.skipIf(!connection).sequential('Runtime policy on real owned PostgreSQL',()=>{
    let admin:Pool,pool:Pool,name:string,models:any,service:RuntimeLimitsService;
    beforeEach(async()=>{
        vi.mocked(requireFeatureEnabled).mockReset().mockResolvedValue();
        const url=ownedTestPostgresAdmin(connection);admin=new Pool({connectionString:url.href,max:1});name='nc_runtime_limits_'+randomUUID().replaceAll('-','');
        await admin.query('CREATE DATABASE '+name);url.pathname='/'+name;pool=new Pool({connectionString:url.href,max:6,options:'-c statement_timeout=10000'});
        await ensureCatalogSchema(pool);
        for(const email of [owner,other])await pool.query('INSERT INTO platform_users(email,is_main_admin) VALUES($1,true)',[email]);
        models={pool,actor:async(req:Request)=>{
            const email=String(req.headers['x-test-email']);const row=(await pool.query('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1',[email])).rows[0];
            if(!row?.enabled)throw new ForbiddenException('Disabled');return {email,activeRole:row.is_main_admin?'Главный админ':'Наблюдатель'};
        }};
        models.requireMain=async(req:Request)=>{const actor=await models.actor(req);if(actor.activeRole!=='Главный админ')throw new ForbiddenException('MainAdmin revoked');return actor.email;};
        service=new RuntimeLimitsService(models);
    });
    afterEach(async()=>{
        await pool?.end();if(admin){await admin.query('DROP DATABASE IF EXISTS '+name);
            expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[name])).rows).toEqual([]);
            expect((await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name])).rows).toEqual([]);await admin.end();}
        vi.restoreAllMocks();
    });
    const counts=async()=>({settings:Number((await pool.query('SELECT count(*) FROM runtime_limit_settings')).rows[0].count),
        receipts:Number((await pool.query('SELECT count(*) FROM runtime_limit_requests')).rows[0].count),
        audits:Number((await pool.query("SELECT count(*) FROM security_events WHERE action='runtime.limits.update'")).rows[0].count)});

    it('verifies additive49 physical facts and applies the saved policy to the live GGUF provider',async()=>{
        await assertRuntimeLimitsSchema(pool);const before=await service.ggufPolicy(),value=input();value.policy.ggufImport.activeUploads=2;value.policy.textKnowledge.sources=2;
        const saved=await service.save(request(),value);expect(saved).toMatchObject({revision:1,policy:value.policy});
        expect((await service.effective()).policy.textKnowledge.sources).toBe(2);expect((await service.ggufPolicy()).activeUploads).toBe(2);expect(before.activeUploads).toBe(3);
        expect(await counts()).toEqual({settings:1,receipts:1,audits:1});
    });
    it('serializes competing CAS writers so only one policy, audit and receipt commits',async()=>{
        const a=input(),b=input();b.policy.textKnowledge.sources=1;
        const results=await Promise.allSettled([service.save(request(),a),service.save(request(other),b)]);
        expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
        expect(results.find(result=>result.status==='rejected')).toMatchObject({reason:{status:409}});expect(await counts()).toEqual({settings:1,receipts:1,audits:1});
    });
    it('recovers an ACK-lost old receipt after a later lower policy and flag OFF without repeating mutation',async()=>{
        let lose=true;
        const fault=new Proxy(pool,{get(target,key){if(key==='connect')return async()=>{
            const client=await target.connect();return {query:async(sql:string,values?:unknown[])=>{const result=await client.query(sql,values);if(sql==='COMMIT'&&lose){lose=false;throw Error('COMMIT ACK lost');}return result;},release:client.release.bind(client)};
        };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
        const accepted=input();await expect(new RuntimeLimitsService({...models,pool:fault}).save(request(),accepted)).rejects.toHaveProperty('status',503);
        const old=await service.receipt(request(),accepted.requestKey),lower=input(1);lower.policy.textKnowledge.fileBytes=2;
        await service.save(request(other),lower);vi.mocked(requireFeatureEnabled).mockRejectedValue(new ForbiddenException('OFF'));
        expect(await service.save(request(),accepted)).toEqual(old);expect((await service.effective()).revision).toBe(2);expect(await counts()).toEqual({settings:1,receipts:2,audits:2});
    });
    it('changed bytes under an accepted key conflict before OFF admission and cannot overwrite receipt',async()=>{
        const value=input(),saved=await service.save(request(),value);vi.mocked(requireFeatureEnabled).mockClear();
        await expect(service.save(request(),{...value,policy:{...value.policy,textKnowledge:{...value.policy.textKnowledge,sources:1}}})).rejects.toHaveProperty('status',409);
        expect(requireFeatureEnabled).not.toHaveBeenCalled();expect(await service.receipt(request(),value.requestKey)).toEqual(saved);expect(await counts()).toEqual({settings:1,receipts:1,audits:1});
    });
    it('fresh SQL authority rejects an admin revoked while admission waits on the real lock',async()=>{
        const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:runtime-limits',0))");
        let pid=0;
        const observed=new Proxy(pool,{get(target,key){if(key==='connect')return async()=>{const client=await target.connect();pid=(client as unknown as {processID:number}).processID;return client;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
        const running=new RuntimeLimitsService({...models,pool:observed}).save(request(),input()).catch(error=>error);
        try{
            let waiting=false;for(let attempt=0;attempt<200;attempt++){
                waiting=pid>0&&!!(await pool.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted',[pid])).rowCount;
                if(waiting)break;await new Promise(resolve=>setTimeout(resolve,5));
            }
            expect(waiting).toBe(true);await pool.query('UPDATE platform_users SET enabled=false WHERE email=$1',[owner]);
            await blocker.query('COMMIT');expect(await running).toHaveProperty('status',403);expect(await counts()).toEqual({settings:0,receipts:0,audits:0});
        }finally{await blocker.query('ROLLBACK');blocker.release();await running;}
    });
    it('receipt reads are writer-scoped and freshly reject revoked MainAdmin access',async()=>{
        const value=input();await service.save(request(),value);await expect(service.receipt(request(other),value.requestKey)).rejects.toHaveProperty('status',404);
        await pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[owner]);await expect(service.receipt(request(),value.requestKey)).rejects.toHaveProperty('status',403);
    });
    it('rejects corrupt persisted policy without silently substituting a different effective policy',async()=>{
        await service.save(request(),input());await pool.query("UPDATE runtime_limit_settings SET policy='{}'");
        await expect(service.effective()).rejects.toHaveProperty('status',503);expect((await service.receipt(request(),(await pool.query('SELECT request_key FROM runtime_limit_requests')).rows[0].request_key)).revision).toBe(1);
    });
    it('an audit failure atomically rolls back policy and receipt and allows the same key after recovery',async()=>{
        await pool.query("CREATE FUNCTION reject_runtime_limit_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='runtime.limits.update' THEN RAISE EXCEPTION 'controlled audit failure'; END IF; RETURN NEW;END$$");
        await pool.query('CREATE TRIGGER reject_runtime_limit_audit BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION reject_runtime_limit_audit()');
        const value=input();await expect(service.save(request(),value)).rejects.toHaveProperty('status',503);expect(await counts()).toEqual({settings:0,receipts:0,audits:0});
        await pool.query('DROP TRIGGER reject_runtime_limit_audit ON security_events');expect((await service.save(request(),value)).revision).toBe(1);
    });
});
