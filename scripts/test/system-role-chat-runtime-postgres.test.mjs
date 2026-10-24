import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {after,before,describe,it} from 'node:test';
import {startSystemRoleChatRuntime} from './system-role-chat-runtime.fixture.mjs';

const connection=process.env.SYSTEM_ROLE_CHAT_TEST_ADMIN_URL;
const root='/api/system-role-chats';

/** Source Nest DI, real SQL and HTTP; no model/tool/bridge is started by this acceptance slice. */
describe('Canonical Catalog service-chat runtime on explicitly owned PostgreSQL',{skip:!connection,concurrency:false,timeout:110000},()=>{
    let f;
    const create=(actor='owner',extra={})=>f.request(actor,root,{method:'POST',status:201,body:{id:randomUUID(),title:'Сервисный диалог',projectId:f.project},...extra});
    const prepare=id=>f.request('owner',root+'/'+id+'/prepare',{method:'POST',status:201,body:{agentId:'agent-ai-admin',includeContext:false,
        selection:{projectId:f.project,instruction:'Проверь доступность выбранного контекста',diagnostics:[],targets:[]}}});
    before(async()=>{f=await startSystemRoleChatRuntime(connection);});
    after(async()=>{await f?.close();});

    it('boots the canonical module, applies migrations0–36 and exposes readiness with both new controllers',async()=>{
        assert.ok(f.productPoolCount()>0,'The actual product PostgreSQL constructor guard was not exercised');
        const state=await f.schema();assert.equal(state.ready,true);assert.deepEqual(state.pending,[]);
        const versions=(await f.pool.query('SELECT version FROM catalog_schema_migrations ORDER BY version')).rows.map(row=>Number(row.version));
        assert.deepEqual(versions,Array.from({length:37},(_,index)=>index));
        assert.equal((await f.request(null,'/ready')).ok,true);
        assert.deepEqual(await f.request('owner',root+'?projectId='+f.project),[]);
        const mcp=await f.request('owner','/api/system-role-mcp?projectId='+f.project);
        assert.deepEqual(mcp.assignments,[]);assert.equal(mcp.enabled,true);
    });

    it('creates and reopens an own private dialog through actual controller/service/repository wiring',async()=>{
        const body={id:randomUUID(),title:'Сохранённый диалог',projectId:f.project};
        const created=await f.request('owner',root,{method:'POST',status:201,body});
        const replay=await f.request('owner',root,{method:'POST',status:201,body});
        assert.equal(created.id,body.id);assert.deepEqual(replay,created);
        assert.ok((await f.request('owner',root+'?projectId='+f.project)).some(dialog=>dialog.id===created.id));
        const detail=await f.request('owner',root+'/'+created.id);
        assert.equal(detail.dialog.id,created.id);assert.deepEqual(detail.turns,[]);
        assert.equal(Number((await f.pool.query('SELECT count(*)::int AS n FROM system_role_dialogs WHERE id=$1',[body.id])).rows[0].n),1);
    });

    it('returns an unknown receipt without admitting a role run or model/tool dispatch',async()=>{
        const dialog=await create(),before=await f.ledgerCounts(),route=root+'/'+dialog.id+'/requests/'+randomUUID();
        await f.request('owner',route,{status:404});await f.request('owner',route,{status:404});
        assert.deepEqual(await f.ledgerCounts(),before);
    });

    it('prepares real bounded role context without invoking the inference owner',async()=>{
        const dialog=await create(),before=await f.ledgerCounts(),preview=await prepare(dialog.id);
        assert.equal(preview.selection.projectId,f.project);
        assert.match(preview.prepared.definitionPin,/^[a-f0-9]{64}$/);
        assert.match(preview.prepared.consentDigest,/^[a-f0-9]{64}$/);
        assert.equal(typeof preview.prepared.preview,'string');
        assert.deepEqual(await f.ledgerCounts(),before);
    });

    it('rejects an untrusted or forged actor and hides another SQL-backed owner',async()=>{
        const dialog=await create(),path=root+'/'+dialog.id;
        await f.request('owner',path,{trusted:false,status:403});
        await f.request('owner',path,{role:'Главный админ',status:403});
        await f.request('other',path,{status:404});
        await f.request('other',path+'/requests/'+randomUUID(),{status:404});
        assert.deepEqual(await f.request('other',root+'?projectId='+f.project),[]);
    });

    it('honors fresh SQL demotion while retaining history for the remaining observer role',async()=>{
        const dialog=await create();
        await f.pool.query("UPDATE project_members SET role='Наблюдатель' WHERE project_id=$1 AND principal_name=$2",[f.project,f.actors.owner]);
        try{
            await f.request('owner',root+'/'+dialog.id,{status:403});
            assert.equal((await f.request('owner',root+'/'+dialog.id,{role:'Наблюдатель'})).dialog.id,dialog.id);
            await create('owner',{role:'Наблюдатель',status:403});
        }finally{await f.pool.query("UPDATE project_members SET role='Админ проекта' WHERE project_id=$1 AND principal_name=$2",[f.project,f.actors.owner]);}
    });

    it('preserves history and missing-receipt reads with its flag OFF but blocks new create and preview',async()=>{
        const dialog=await create(),before=await f.ledgerCounts();f.state.flags.system_role_chat=false;
        try{
            assert.equal((await f.request('owner',root+'/'+dialog.id)).dialog.id,dialog.id);
            assert.ok((await f.request('owner',root+'?projectId='+f.project)).some(row=>row.id===dialog.id));
            await f.request('owner',root+'/'+dialog.id+'/requests/'+randomUUID(),{status:404});
            await create('owner',{status:403});
            await f.request('owner',root+'/'+dialog.id+'/prepare',{method:'POST',status:403,body:{agentId:'agent-ai-admin',selection:{projectId:f.project,instruction:'Проверка',diagnostics:[],targets:[]}}});
            assert.deepEqual(await f.ledgerCounts(),before);
        }finally{f.state.flags.system_role_chat=true;}
    });

    it('refuses previously readable history immediately after the actual account is disabled',async()=>{
        const dialog=await create();await f.pool.query('UPDATE platform_users SET enabled=false WHERE email=$1',[f.actors.owner]);
        try{await f.request('owner',root+'/'+dialog.id,{status:403});}
        finally{await f.pool.query('UPDATE platform_users SET enabled=true WHERE email=$1',[f.actors.owner]);}
    });

    it('leaves dispatch ledgers empty and closes the actual application with no remaining PostgreSQL clients',async()=>{
        const counts=await f.ledgerCounts();assert.ok(Object.values(counts).every(value=>value===0));
        assert.equal(f.state.unknownDependencies,0);assert.equal(f.state.blockedFetches,0);assert.equal(f.state.blockedPools,0);
        const cleanup=await f.close();
        assert.equal(cleanup.applicationClosed,true);assert.equal(cleanup.clientsAfterApplicationClose,0);
        assert.equal(cleanup.databaseDropped,true);assert.deepEqual(cleanup.failures,[]);
    });

    it('restores process ownership and reports a controlled failure after the real application has closed',async t=>{
        const requireCatalog=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
        const pg=requireCatalog('pg'),previousPool=pg.Pool,previousFetch=globalThis.fetch,previousCwd=process.cwd(),previousEnvironment={...process.env};
        let realClosed=false;
        const fixture=await startSystemRoleChatRuntime(connection,{afterApplicationClose:()=>{
            realClosed=true;throw new Error('Controlled post-close acknowledgement failure');
        }});
        try{
            await assert.rejects(fixture.close(),error=>{
                assert.ok(error instanceof AggregateError);
                assert.ok(error.errors.some(cause=>cause?.message==='Controlled post-close acknowledgement failure'));
                return true;
            });
            assert.equal(realClosed,true);assert.equal(fixture.state.cleanup.clientsAfterApplicationClose,0);
            assert.equal(fixture.state.cleanup.databaseDropped,true);
            assert.deepEqual(fixture.state.cleanup.failures,['catalog application']);
            assert.equal(globalThis.fetch,previousFetch);assert.equal(pg.Pool,previousPool);assert.equal(process.cwd(),previousCwd);
            // Compare the entire environment without printing connection values on an assertion failure.
            const entries=value=>JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));
            assert.equal(entries(process.env)===entries(previousEnvironment),true,'The process environment was not restored');
            const diagnostic=JSON.parse(await fs.readFile(fixture.state.cleanup.diagnosticPath,'utf8'));
            assert.deepEqual(diagnostic.failures,['catalog application']);assert.equal(diagnostic.databaseDropped,true);
            assert.equal((await fs.stat(fixture.state.cleanup.diagnosticPath)).mode&0o777,0o600);
        }finally{
            if(fixture.state.cleanup?.diagnosticPath)t.diagnostic('Controlled cleanup diagnostic retained at '+fixture.state.cleanup.diagnosticPath);
        }
    });
});
