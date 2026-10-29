import 'reflect-metadata';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {ownedTestPostgresAdmin} from '../../../scripts/test/owned-postgres.fixture.mjs';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {CATALOG_SCHEMA_FACTS_SQL} from '../src/database/schema-catalog';
import {RemoteProviderRepository,providerConnection} from '../src/remote-providers/remote-provider.repository';
import {remoteProviderLease} from '../src/remote-providers/remote-provider.lease';
import {credentialFence,providerFence,remoteProviderId} from '../src/remote-providers/remote-provider.identity';
import {assertRemoteProviderSchema} from '../src/remote-providers/remote-provider.schema-verification';
import {sealModelCredential} from '../src/models/remote-model-secret';
import {RemoteConnectionService} from '../src/models/remote-connection.service';
import {RemoteModelClient} from '../src/models/remote-model-client';
import {ModelApiAdmission} from '../src/model-api-admission/model-api-admission';
import {createModelDispatchMetrics,withModelDispatchMetrics} from '../src/model-usage/model-dispatch-metrics';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {RemoteProviderAccessService} from '../src/remote-providers/remote-provider.service';
import {withModelUsage} from '../src/model-usage/model-usage.context';
import type {IModel} from '../src/models/model.types';
import type {RemoteProviderMutation} from '../src/remote-providers/remote-provider.types';
import {requireFeatureEnabled} from '../src/features/require-feature-enabled';
import {ForbiddenException} from '@nestjs/common';
vi.mock('../src/features/require-feature-enabled',()=>({requireFeatureEnabled:vi.fn(),requireFeaturesEnabled:vi.fn()}));
const adminFile=process.env.REMOTE_PROVIDER_TEST_ADMIN_URL_FILE;
const alice={email:'alice@provider.test',activeRole:'Разработчик',projectId:'prj-provider'},bob={...alice,email:'bob@provider.test'};
const environment={NEUROCENTER_MODEL_CREDENTIAL_KEY:Buffer.alloc(32,21).toString('base64')};
const model:IModel={id:'model-personal',name:'Personal fixture',description:'',runtime:'remote-openai',model:'fixture',modelVersion:'1',capability:'chat',source:'custom',dimension:null,revision:1,manifestSha256:null,verificationSha256:'a'.repeat(64),createdAt:'2026-10-29',updatedAt:'2026-10-29'};
const barrier=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};};

describe.skipIf(!adminFile).sequential('Personal provider access on an explicit owned PostgreSQL database',()=>{
    let admin:Pool,pool:Pool,leases:Pool,database:string,repository:RemoteProviderRepository,providerId:string,legacy:unknown;
    beforeAll(async()=>{
        const url=ownedTestPostgresAdmin((await fs.readFile(adminFile!,'utf8')).trim());
        admin=new Pool({connectionString:url.href,max:1});database='nc_remote51_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+database);
        url.pathname='/'+database;pool=new Pool({connectionString:url.href,max:6,options:'-c statement_timeout=5000'});leases=new Pool({...pool.options,max:2,connectionTimeoutMillis:800,query_timeout:1200});
        await ensureCatalogSchema(pool);await assertRemoteProviderSchema(pool);
        const facts=(await pool.query(CATALOG_SCHEMA_FACTS_SQL)).rows.filter(f=>f.id.startsWith('remote_provider_user_')||f.id==='model_remote_connections.auth_mode'||f.id==='model_remote_connections.model_remote_connections_auth_mode_check').sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id));
        const output=path.resolve('../../.run/remote-provider-51-20261029');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'schema-facts.measured.json'),JSON.stringify(facts,null,2)+'\n');
        await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)',[alice.projectId,'Provider fixture']);
        for(const actor of[alice,bob]){await pool.query('INSERT INTO platform_users(email) VALUES($1)',[actor.email]);await pool.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)',[actor.projectId,actor.email,actor.activeRole]);}
        const {id:_id,name:_name,revision:_revision,createdAt:_created,updatedAt:_updated,...descriptor}=model;
        await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3)',[model.id,model.name,descriptor]);await pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)',[alice.projectId,model.id,alice.email]);
        legacy=sealModelCredential('legacy-shared-fixture-only',model.id,1,environment);
        await pool.query(`INSERT INTO model_remote_connections(model_id,revision,base_url,request_dimensions,credential_kind,credential,semantic_sha,verified_at,auth_mode) VALUES($1,1,'https://provider.test/v1',false,'stored',$2,$3,now(),'required')`,[model.id,legacy,model.verificationSha256]);
        providerId=remoteProviderId(model,await providerConnection(pool,model.id));repository=new RemoteProviderRepository(pool,environment);
    },20000);
    beforeEach(async()=>{
        vi.mocked(requireFeatureEnabled).mockReset().mockResolvedValue();vi.stubEnv('NEUROCENTER_MODEL_CREDENTIAL_KEY',environment.NEUROCENTER_MODEL_CREDENTIAL_KEY);
        await pool.query('DELETE FROM remote_provider_user_requests');await pool.query('DELETE FROM remote_provider_user_credentials');await pool.query('UPDATE platform_users SET enabled=true');
        await pool.query("UPDATE model_remote_connections SET auth_mode='required',revoked_at=NULL,failure_message='Прежняя общая ошибка ключа' WHERE model_id=$1",[model.id]);
    });
    afterAll(async()=>{
        vi.unstubAllEnvs();vi.unstubAllGlobals();await leases?.end();await pool?.end();
        if(admin){expect((await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[database])).rows).toEqual([]);await admin.query('DROP DATABASE '+database);expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[database])).rows).toEqual([]);
            await fs.writeFile(path.resolve('../../.run/remote-provider-51-20261029/pg-cleanup-receipt.json'),JSON.stringify({database,remainingSessions:0,databaseAbsent:true,checkedAt:new Date().toISOString()},null,2)+'\n');await admin.end();}
    });
    const input=(secret='alice-key',revision=0):RemoteProviderMutation=>({providerId,expectedConnectionRevision:1,expectedCredentialRevision:revision,requestKey:randomUUID(),apiKey:secret});
    const receiptCount=async()=>Number((await pool.query('SELECT count(*) n FROM remote_provider_user_requests')).rows[0].n);

    it('measures physical migration51 facts and preserves existing shared ciphertext byte-for-byte',async()=>{
        await assertRemoteProviderSchema(pool);await repository.mutate(model,alice,input(),'save');expect((await pool.query('SELECT credential FROM model_remote_connections WHERE model_id=$1 AND revision=1',[model.id])).rows[0].credential).toEqual(legacy);
        expect((await repository.view(model,alice)).legacySharedKeyRetained).toBe(true);
    });
    it('rejects drift after each required CHECK and FK is removed on the owned database',async()=>{
        const constraints=(await pool.query<{table_name:string;name:string}>(`SELECT c.relname table_name,p.conname name FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid
            WHERE (c.relname IN('remote_provider_user_credentials','remote_provider_user_requests') AND p.contype IN('c','f')) OR(c.relname='model_remote_connections' AND p.conname='model_remote_connections_auth_mode_check')`)).rows;
        expect(constraints.length).toBe(10);const db=await pool.connect();
        try{for(const item of constraints){await db.query('BEGIN');try{await db.query('ALTER TABLE '+item.table_name+' DROP CONSTRAINT '+item.name);await expect(assertRemoteProviderSchema(db)).rejects.toThrow('Схема');}finally{await db.query('ROLLBACK');}}}finally{db.release();}
    });
    it('isolates A/B, keeps secrets encrypted, rotates without changing model pin and deletes ciphertext',async()=>{
        const before=(await pool.query('SELECT revision,descriptor FROM model_catalog WHERE id=$1',[model.id])).rows[0];await repository.mutate(model,alice,input(),'save');
        expect((await repository.view(model,alice)).hasKey).toBe(true);expect((await repository.view(model,bob)).hasKey).toBe(false);
        const encrypted=(await pool.query('SELECT credential FROM remote_provider_user_credentials')).rows[0].credential;expect(JSON.stringify(encrypted)).not.toContain('alice-key');
        const current=await repository.mutate(model,alice,input('rotated-key',1),'save');expect(current.credentialRevision).toBe(2);
        const {apiKey:_key,...remove}=input('',2);const deleted=await repository.mutate(model,alice,remove,'delete');expect(deleted.hasKey).toBe(false);
        expect((await pool.query('SELECT credential FROM remote_provider_user_credentials')).rows[0].credential).toBeNull();
        expect((await pool.query('SELECT revision,descriptor FROM model_catalog WHERE id=$1',[model.id])).rows[0]).toEqual(before);
        expect(JSON.stringify((await pool.query('SELECT result FROM remote_provider_user_requests')).rows)).not.toContain('rotated-key');
    });
    it('serializes competing CAS writes and retains exactly one own receipt',async()=>{
        const results=await Promise.allSettled([repository.mutate(model,alice,input('one'),'save'),repository.mutate(model,alice,input('two'),'save')]);
        expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{status:409}});expect(await receiptCount()).toBe(1);
    });
    it('recovers accepted UUID while OFF without leaking another owner receipt or accepting changed key bytes',async()=>{
        const savedInput=input(),saved=await repository.mutate(model,alice,savedInput,'save');vi.mocked(requireFeatureEnabled).mockRejectedValue(Error('OFF'));
        expect(await repository.mutate(model,alice,savedInput,'save')).toEqual(saved);expect(await repository.receipt(model.id,bob,savedInput.requestKey)).toBeNull();
        await expect(repository.mutate(model,alice,{...savedInput,apiKey:'different'},'save')).rejects.toHaveProperty('status',409);expect(await receiptCount()).toBe(1);
    });
    it('a lost COMMIT ACK recovers exactly one ciphertext revision/audit/receipt through the original key',async()=>{
        let lose=true;
        const fault=new Proxy(pool,{get(target,key){if(key==='connect')return async()=>{const db=await target.connect();return{query:async(sql:string,values?:unknown[])=>{const value=await db.query(sql,values);if(sql==='COMMIT'&&lose){lose=false;throw Error('COMMIT ACK lost');}return value;},release:db.release.bind(db)};};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
        const intent=input();await expect(new RemoteProviderRepository(fault,environment).mutate(model,alice,intent,'save')).rejects.toThrow('ACK lost');
        const receipt=await repository.receipt(model.id,alice,intent.requestKey);expect(receipt?.credentialRevision).toBe(1);
        vi.mocked(requireFeatureEnabled).mockRejectedValue(Error('OFF'));expect(await repository.mutate(model,alice,intent,'save')).toEqual(receipt);expect(await receiptCount()).toBe(1);
    });
    it('fresh ACL denial after COMMIT keeps a recoverable masked receipt without changing the accepted key',async()=>{
        let revoke=true;
        const afterCommit=new Proxy(pool,{get(target,key){if(key==='connect')return async()=>{const db=await target.connect();return{query:async(sql:string,values?:unknown[])=>{const value=await db.query(sql,values);if(sql==='COMMIT'&&revoke){revoke=false;await target.query('UPDATE platform_users SET enabled=false WHERE email=$1',[alice.email]);}return value;},release:db.release.bind(db)};};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
        const models={pool:afterCommit,actor:async()=>alice,getAccessible:async()=>{const account=(await pool.query('SELECT enabled FROM platform_users WHERE email=$1',[alice.email])).rows[0];if(!account.enabled)throw new ForbiddenException('revoked after commit');return model;}}as never;
        const personal=new RemoteProviderAccessService(models),intent=input();
        try{await expect(personal.mutate({}as never,model.id,intent,'save')).rejects.toHaveProperty('status',403);expect(await receiptCount()).toBe(1);
            await pool.query('UPDATE platform_users SET enabled=true WHERE email=$1',[alice.email]);vi.mocked(requireFeatureEnabled).mockRejectedValue(Error('OFF'));
            expect(await personal.receipt({}as never,model.id,intent.requestKey)).toMatchObject({requestKey:intent.requestKey,credentialRevision:1,hasKey:true});
        }finally{await personal.onApplicationShutdown();}
    });
    it('none and optional with no personal key never use retained shared/environment keys; required stops before wire',async()=>{
        await repository.mutate(model,alice,input(),'save');
        for(const mode of['none','optional']){await pool.query('UPDATE model_remote_connections SET auth_mode=$2 WHERE model_id=$1',[model.id,mode]);const expected=await providerConnection(pool,model.id);
            const lease=await remoteProviderLease(leases,model,expected,bob,undefined,environment);expect(lease.apiKey).toBeUndefined();await lease.release();
            if(mode==='none'){const savedButUnused=await remoteProviderLease(leases,model,expected,alice,undefined,environment);expect(savedButUnused.apiKey).toBeUndefined();await savedButUnused.release();}}
        await pool.query("UPDATE model_remote_connections SET auth_mode='required' WHERE model_id=$1",[model.id]);await expect(remoteProviderLease(leases,model,await providerConnection(pool,model.id),bob,undefined,environment)).rejects.toHaveProperty('status',403);
    });
    it('missing actor role and a freshly disabled account cannot acquire a wire lease',async()=>{
        await repository.mutate(model,alice,input(),'save');const expected=await providerConnection(pool,model.id);
        await expect(remoteProviderLease(leases,model,expected,{...alice,activeRole:''},undefined,environment)).rejects.toHaveProperty('status',403);
        await pool.query('UPDATE platform_users SET enabled=false WHERE email=$1',[alice.email]);await expect(remoteProviderLease(leases,model,expected,alice,undefined,environment)).rejects.toHaveProperty('status',403);
    });
    it('a committed credential revocation while acquisition waits prevents a later fetch',async()=>{
        await repository.mutate(model,alice,input(),'save');const expected=await providerConnection(pool,model.id),blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[credentialFence(alice.email,providerId)]);
        const started=remoteProviderLease(leases,model,expected,alice,undefined,environment).catch(error=>error);
        try{await expect.poll(async()=>Number((await pool.query("SELECT count(*) n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND NOT l.granted")).rows[0].n),{interval:5,timeout:500}).toBeGreaterThan(0);
            await blocker.query('UPDATE remote_provider_user_credentials SET credential=NULL,revision=revision+1 WHERE owner_email=$1',[alice.email]);await blocker.query('COMMIT');expect(await started).toHaveProperty('status',403);
        }finally{await blocker.query('ROLLBACK');blocker.release();await started;}
    });
    it('the stable provider fence serializes new connection revisions and cancellation releases its short pool',async()=>{
        await repository.mutate(model,alice,input(),'save');const expected=await providerConnection(pool,model.id),lease=await remoteProviderLease(leases,model,expected,alice,undefined,environment),writer=await pool.connect();
        await writer.query('BEGIN');let entered=false;const waiting=writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[providerFence(model.id)]).then(()=>{entered=true;});
        try{await expect.poll(async()=>Number((await pool.query('SELECT count(*) n FROM pg_locks WHERE pid=$1 AND NOT granted',[(writer as unknown as {processID:number}).processID])).rows[0].n),{interval:5,timeout:500}).toBe(1);expect(entered).toBe(false);
            await lease.release();await waiting;expect(entered).toBe(true);
        }finally{await writer.query('ROLLBACK');writer.release();}
        const abort=new AbortController(),held=await remoteProviderLease(leases,model,expected,alice,abort.signal,environment);abort.abort();expect(()=>held.assertCurrent?.()).toThrow();await held.release();expect(leases.idleCount+leases.waitingCount).toBeLessThanOrEqual(2);
    });
    it('literal HTTP start uses A/B personal keys and releases locks while the provider answer is held',async()=>{
        await repository.mutate(model,alice,input('key-A'),'save');await repository.mutate(model,bob,input('key-B'),'save');
        const models={pool,get:async()=>model}as never,personal=new RemoteProviderAccessService(models),remote=new RemoteConnectionService(models,undefined,undefined,personal);
        const hold=barrier(),headers:string[]=[],fetch=vi.fn(async(_url:unknown,request?:RequestInit)=>{headers.push((request?.headers as Record<string,string>).authorization);await hold.promise;return new Response(JSON.stringify({model:'fixture',choices:[{index:0,finish_reason:'stop',message:{content:'OK'}}]}),{headers:{'content-type':'application/json'}});});vi.stubGlobal('fetch',fetch);
        const pending=withModelUsage({purpose:'chat',actorEmail:alice.email,actorRole:alice.activeRole,projectId:alice.projectId},()=>remote.infer(model,'chat',{messages:[{role:'user',content:'A'}]}));
        try{await expect.poll(()=>headers.length,{interval:5,timeout:1000}).toBe(1);const {apiKey:_key,...remove}=input('',1);await repository.mutate(model,alice,remove,'delete');expect(headers[0]).toBe('Bearer key-A');
            hold.release();await pending;await withModelUsage({purpose:'chat',actorEmail:bob.email,actorRole:bob.activeRole,projectId:bob.projectId},()=>remote.infer(model,'chat',{messages:[{role:'user',content:'B'}]}));expect(headers).toEqual(['Bearer key-A','Bearer key-B']);
            expect((await remote.status(model)).state).toBe('ready');
        }finally{hold.release();await pending.catch(()=>{});await personal.onApplicationShutdown();vi.unstubAllGlobals();}
    });
    it('a disconnected SQL lease during claim cannot send the decrypted old key after revocation',async()=>{
        await repository.mutate(model,alice,input('old-key'),'save');const expected=await providerConnection(pool,model.id);
        const atClaim=barrier(),finishClaim=barrier(),disconnected=barrier();let leasePid=0;
        const ownedPool=new Proxy(leases,{get(target,key){if(key==='connect')return async()=>{const db=await target.connect();leasePid=(db as unknown as {processID:number}).processID;
            db.on('error',()=>disconnected.release());db.on('end',()=>disconnected.release());return db;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
        const flags=Object.fromEntries(Object.keys(defaultFeatureFlags()).map(key=>[key,true]));vi.stubGlobal('fetch',vi.fn(async()=>Response.json(evaluateFeatureFlags(flags))));
        const usage={reserveQuota:vi.fn(async()=>true),claimQuota:vi.fn(async()=>{atClaim.release();await finishClaim.promise;}),releaseQuota:vi.fn(async()=>{})};
        const admission=new ModelApiAdmission({acquire:vi.fn(async(_model,_signal,beforeAttempt)=>{await beforeAttempt();})}as never,usage as never);
        const provider=vi.fn(async()=>Response.json({model:'fixture',choices:[{index:0,finish_reason:'stop',message:{content:'must not send'}}]}));
        const client=new RemoteModelClient({admission,fetch:provider as typeof fetch}),metrics=createModelDispatchMetrics();metrics.usageId=randomUUID();metrics.workerId='owned-lease-loss';
        const pending=withModelDispatchMetrics(metrics,()=>withModelUsage({purpose:'chat',actorEmail:alice.email,actorRole:alice.activeRole,projectId:alice.projectId,
            providerWire:{acquire:signal=>remoteProviderLease(ownedPool,model,expected,alice,signal,environment)}},()=>client.infer(model,{modelId:model.id,revision:1,baseUrl:expected.base_url,requestDimensions:false},'chat',{messages:[{role:'user',content:'hello'}]}))).catch(error=>error);
        try{await atClaim.promise;expect(leasePid).toBeGreaterThan(0);
            expect((await pool.query('SELECT pg_terminate_backend($1) terminated',[leasePid])).rows[0].terminated).toBe(true);await disconnected.promise;
            const {apiKey:_key,...remove}=input('',1);await repository.mutate(model,alice,remove,'delete');finishClaim.release();
            expect(await pending).toHaveProperty('status',503);expect(provider).not.toHaveBeenCalled();expect(usage.releaseQuota).toHaveBeenCalledOnce();expect(metrics.dispatchCount).toBe(0);
        }finally{finishClaim.release();await pending;vi.unstubAllGlobals();}
    });
    it('a personal authorization failure cannot mark the shared provider unavailable for another user',async()=>{
        await repository.mutate(model,alice,input('key-A'),'save');await repository.mutate(model,bob,input('key-B'),'save');
        const models={pool,get:async()=>model}as never,personal=new RemoteProviderAccessService(models),remote=new RemoteConnectionService(models,undefined,undefined,personal);
        const before=(await pool.query('SELECT failure_message,semantic_sha,verified_at FROM model_remote_connections WHERE model_id=$1 AND revision=1',[model.id])).rows[0];
        const headers:string[]=[];vi.stubGlobal('fetch',vi.fn(async(_url:unknown,request?:RequestInit)=>{const key=(request?.headers as Record<string,string>).authorization;headers.push(key);
            return key==='Bearer key-A'?new Response('{"error":"unauthorized"}',{status:401}):Response.json({model:'fixture',choices:[{index:0,finish_reason:'stop',message:{content:'OK'}}]});}));
        const run=(actor:typeof alice)=>withModelUsage({purpose:'chat',actorEmail:actor.email,actorRole:actor.activeRole,projectId:actor.projectId},()=>remote.infer(model,'chat',{messages:[{role:'user',content:'hello'}]}));
        try{await expect(run(alice)).rejects.toHaveProperty('status',503);expect((await run(bob)).message).toEqual({role:'assistant',content:'OK'});
            expect(headers).toEqual(['Bearer key-A','Bearer key-B']);expect((await remote.status(model)).state).toBe('ready');
            expect((await pool.query('SELECT failure_message,semantic_sha,verified_at FROM model_remote_connections WHERE model_id=$1 AND revision=1',[model.id])).rows[0]).toEqual(before);
        }finally{await personal.onApplicationShutdown();vi.unstubAllGlobals();}
    });
});
