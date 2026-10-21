import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {IAccessActor} from '../src/access/access.model';
import {CatalogRequestsService} from '../src/catalog-requests/catalog-requests.service';
import {connection,requestsFixture,type RequestsFixture,fields,action,edit,main,admin,developer,observer,stranger} from './catalog-requests-postgres.fixture';

describe.skipIf(!connection)('Catalog intake — actual PostgreSQL transactions and fresh service actor',()=>{
    let f:RequestsFixture;
    const create=(actor:IAccessActor=developer,extra:Record<string,unknown>={})=>f.service.create(f.request(actor),fields(extra));
    beforeAll(async()=>{f=await requestsFixture();});beforeEach(async()=>f.reset());afterAll(async()=>f?.close());
    it('service readiness awaits the access catalog and shutdown closes its own idle pool',async()=>{
        let release!:()=>void;const ready=vi.spyOn(f.models,'ready').mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
        let settled=false;const starting=f.service.onModuleInit().then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);release();await starting;ready.mockRestore();
        const independent=new CatalogRequestsService(f.models);await independent.onApplicationShutdown();expect(independent.pool.ended).toBe(true);
    });
    it('concurrent creation has one row, history, audit and receipt; source URLs remain inert',async()=>{
        const input=fields({projectId:'prj-agents',sourceUrl:f.origin+'/must-never-fetch?private=value'}),rows=await Promise.all(Array.from({length:3},()=>f.service.create(f.request(developer),input)));
        expect(new Set(rows.map(row=>row.id)).size).toBe(1);expect(rows[0]).toMatchObject({revision:1,status:'submitted',projectName:'requestqa',createdBy:developer.email});
        expect(rows[0].history).toHaveLength(1);expect(new Date(rows[0].history[0].at).toISOString()).toBe(rows[0].history[0].at);
        const audit=(await f.pool.query('SELECT * FROM security_events WHERE resource_id=$1',[rows[0].id])).rows;expect(audit).toHaveLength(1);expect(JSON.stringify(audit)).not.toMatch(/PRIVATE_REQUEST_DETAILS|must-never-fetch|private=value/);
        expect((await f.pool.query('SELECT * FROM catalog_request_mutations')).rows).toHaveLength(1);expect(f.calls).toEqual([]);
        await expect(f.service.create(f.request(developer),{...input,title:'Changed body'})).rejects.toMatchObject({status:409});
    });
    it('a retry returns the current record without reverting later edits, and request keys remain actor scoped',async()=>{
        const input=fields(),row=await f.service.create(f.request(developer),input),updated=await f.service.edit(f.request(developer),row.id,edit(row,{title:'Later edit'}));
        expect(await f.service.create(f.request(developer),input)).toEqual(updated);
        const other=await f.service.create(f.request(observer),input);expect(other.id).not.toBe(row.id);expect(other.createdBy).toBe(observer.email);
        expect((await f.pool.query('SELECT * FROM catalog_requests')).rowCount).toBe(2);
    });
    it('queue, filters and detail isolate other authors and projects without leaking common requests',async()=>{
        const project=await create(developer,{projectId:'prj-agents'}),common=await create(),foreign=await create(stranger,{projectId:'prj-other'});
        expect((await f.service.list(f.request(admin),{scope:'all'})).items.map(row=>row.id)).toEqual([project.id]);
        expect((await f.service.list(f.request(developer),{scope:'all'})).items.map(row=>row.id).sort()).toEqual([project.id,common.id].sort());
        expect((await f.service.list(f.request(main),{scope:'all'})).total).toBe(3);
        await expect(f.service.get(f.request(admin),common.id)).rejects.toMatchObject({status:404});await expect(f.service.get(f.request(developer),foreign.id)).rejects.toMatchObject({status:404});
        const filtered=await f.service.list(f.request(main),{scope:'all',kind:'add',status:'submitted',assetType:'mcp',projectId:'prj-agents',page:'1',size:'1'});expect(filtered).toMatchObject({total:1,page:1,size:1,items:[{id:project.id}]});
        expect((await f.service.list(f.request(main),{scope:'all',size:'1',page:'2'})).items).toHaveLength(1);
        expect((await f.service.list(f.request(main),{scope:'mine'})).items).toEqual([]);
    });
    it('observers may submit their own intent but cannot review another author or a common request',async()=>{
        const own=await create(observer,{projectId:'prj-agents'}),other=await create(developer,{projectId:'prj-agents'});
        expect(own.permissions.canEdit).toBe(true);await expect(f.service.action(f.request(observer),own.id,action(own,'start'))).rejects.toMatchObject({status:403});
        await expect(f.service.get(f.request(observer),other.id)).rejects.toMatchObject({status:404});
        const common=await create();await expect(f.service.action(f.request(admin),common.id,action(common,'start'))).rejects.toMatchObject({status:404});
        expect((await f.service.action(f.request(main),common.id,action(common,'start'))).status).toBe('in_progress');
    });
    it('clarification requires author edit and explicit resubmission before review restarts',async()=>{
        let row=await create(developer,{projectId:'prj-agents'});row=await f.service.action(f.request(admin),row.id,action(row,'needs_info',{comment:'Need reproduction'}));
        expect(row.status).toBe('needs_info');await expect(f.service.action(f.request(admin),row.id,action(row,'start'))).rejects.toMatchObject({status:409});
        row=await f.service.edit(f.request(developer),row.id,edit(row,{description:'Updated reproduction'}));row=await f.service.action(f.request(developer),row.id,action(row,'resubmit'));
        row=await f.service.action(f.request(admin),row.id,action(row,'start'));expect(row.status).toBe('in_progress');expect(row.history.map(item=>item.action)).toEqual(['create','needs_info','edit','resubmit','start']);
        await expect(f.service.edit(f.request(developer),row.id,edit(row))).rejects.toMatchObject({status:403});
        await expect(f.service.action(f.request(developer),row.id,action(row,'resubmit'))).rejects.toMatchObject({status:403});
    });
    it.each(['reject','cancel'])('terminal %s stops further edits and transitions while preserving original history',async terminal=>{
        let row=await create(developer,{projectId:'prj-agents'});row=await f.service.action(f.request(terminal==='reject'?admin:developer),row.id,action(row,terminal,{comment:'Explicit decision'}));
        expect(row.status).toBe(terminal==='reject'?'rejected':'cancelled');expect(row.history).toHaveLength(2);
        for(const name of ['start','reject','resubmit','cancel'])await expect(f.service.action(f.request(main),row.id,action(row,name,{comment:'Attempt'}))).rejects.toMatchObject({status:403});
        await expect(f.service.edit(f.request(developer),row.id,edit(row))).rejects.toMatchObject({status:403});
    });
    it('only the owner can cancel active work and a reviewer cannot edit another author',async()=>{
        let row=await create(developer,{projectId:'prj-agents'});row=await f.service.action(f.request(admin),row.id,action(row,'start'));
        await expect(f.service.action(f.request(admin),row.id,action(row,'cancel'))).rejects.toMatchObject({status:403});
        await expect(f.service.edit(f.request(admin),row.id,edit(row))).rejects.toMatchObject({status:403});
        expect((await f.service.action(f.request(developer),row.id,action(row,'cancel'))).status).toBe('cancelled');
    });
    it('CAS serializes competing reviewers without losing a transition',async()=>{
        const row=await create(developer,{projectId:'prj-agents'}),start=action(row,'start'),results=await Promise.allSettled([f.service.action(f.request(admin),row.id,start),f.service.action(f.request(main),row.id,action(row,'reject',{comment:'Reject concurrently'}))]);
        expect(results.filter(item=>item.status==='fulfilled')).toHaveLength(1);const failed=results.find(item=>item.status==='rejected') as PromiseRejectedResult;expect(failed.reason).toMatchObject({status:409});
        const current=await f.service.get(f.request(main),row.id);expect(current.revision).toBe(2);expect(current.history).toHaveLength(2);
        expect(['in_progress','rejected']).toContain(current.status);
    });
    it('an old successful action replay returns the later current state without repeating work',async()=>{
        const row=await create(developer,{projectId:'prj-agents'}),input=action(row,'start'),started=await f.service.action(f.request(admin),row.id,input);
        const later=await f.service.action(f.request(admin),row.id,action(started,'needs_info',{comment:'Need more information'}));
        expect(await f.service.action(f.request(admin),row.id,input)).toEqual(later);
        await expect(f.service.action(f.request(admin),row.id,{...input,action:'reject',comment:'Same key, different decision'})).rejects.toMatchObject({status:409});
        expect((await f.pool.query("SELECT * FROM security_events WHERE resource_id=$1 AND action='catalog_request.start'",[row.id])).rowCount).toBe(1);
        expect((await f.service.get(f.request(admin),row.id)).history.map(item=>item.action)).toEqual(['create','start','needs_info']);
    });
    it.each(['create','edit','start'])('audit failure rolls back %s, its history and its receipt, then exact retry succeeds',async operation=>{
        const row=operation==='create'?null:await create(developer,{projectId:'prj-agents'}),key=randomUUID(),input=operation==='create'?fields({requestKey:key}):operation==='edit'?edit(row!,{requestKey:key,title:'New title'}):action(row!,'start',{requestKey:key});
        const actor=operation==='start'?admin:developer,run=()=>operation==='create'?f.service.create(f.request(actor),input):operation==='edit'?f.service.edit(f.request(actor),row!.id,input):f.service.action(f.request(actor),row!.id,input);
        const before=(await f.pool.query('SELECT * FROM catalog_requests ORDER BY id')).rows,events=(await f.pool.query('SELECT * FROM catalog_request_events ORDER BY id')).rows;
        await f.pool.query(`CREATE FUNCTION reject_request_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'request audit offline'; END $$;CREATE TRIGGER reject_request_test_audit BEFORE INSERT ON security_events FOR EACH ROW WHEN(NEW.action LIKE 'catalog_request.%') EXECUTE FUNCTION reject_request_test_audit()`);
        try{await expect(run()).rejects.toThrow('request audit offline');expect((await f.pool.query('SELECT * FROM catalog_requests ORDER BY id')).rows).toEqual(before);expect((await f.pool.query('SELECT * FROM catalog_request_events ORDER BY id')).rows).toEqual(events);expect((await f.pool.query('SELECT * FROM catalog_request_mutations WHERE request_key=$1',[key])).rowCount).toBe(0);}
        finally{await f.pool.query('DROP TRIGGER reject_request_test_audit ON security_events;DROP FUNCTION reject_request_test_audit()');}
        expect((await run()).revision).toBe(operation==='create'?1:2);
    });
    it.each(['disabled','main-revoked','project-revoked'])('fresh %s prevents old receipt replay and new mutations',async reason=>{
        const actor=reason==='main-revoked'?main:developer,input=fields({projectId:'prj-agents'}),row=await f.service.create(f.request(actor),input);
        if(reason==='disabled')await f.pool.query('UPDATE platform_users SET enabled=false WHERE email=$1',[actor.email]);
        if(reason==='main-revoked')await f.pool.query('UPDATE platform_users SET is_main_admin=false WHERE email=$1',[main.email]);
        if(reason==='project-revoked')await f.pool.query('DELETE FROM project_members WHERE principal_name=$1',[developer.email]);
        await expect(f.service.create(f.request(actor),input)).rejects.toMatchObject({status:403});await expect(f.service.get(f.request(actor),row.id)).rejects.toMatchObject({status:403});
        expect((await f.pool.query('SELECT revision FROM catalog_requests WHERE id=$1',[row.id])).rows[0].revision).toBe(1);
    });
    it('project-role spoofing never promotes an account to platform main admin',async()=>{
        await f.pool.query("UPDATE project_members SET role='Главный админ' WHERE principal_name=$1",[developer.email]);
        await expect(f.service.list(f.request({...developer,activeRole:'Главный админ'}),{scope:'all'})).rejects.toMatchObject({status:403});
        const forged=f.request(main);forged.headers['x-neurocenter-internal']='wrong';await expect(f.service.create(forged,fields())).rejects.toMatchObject({status:403});
        expect((await f.pool.query('SELECT * FROM catalog_requests')).rows).toEqual([]);
    });
    it.each(['disabled','role-revoked'])('repository-side %s protects callers even after an earlier actor check succeeded',async reason=>{
        const input=fields(),row=await f.service.repository.create(developer,input);
        if(reason==='disabled')await f.pool.query('UPDATE platform_users SET enabled=false WHERE email=$1',[developer.email]);
        else await f.pool.query('DELETE FROM project_members WHERE principal_name=$1',[developer.email]);
        await expect(f.service.repository.create(developer,input)).rejects.toMatchObject({status:403});
        expect((await f.pool.query('SELECT revision FROM catalog_requests WHERE id=$1',[row.id])).rows[0].revision).toBe(1);
    });
    it('a closed project is not a new-intake destination even while its historical grants still exist',async()=>{
        await f.pool.query("UPDATE projects SET state='ARCHIVED' WHERE id='prj-agents'");
        await expect(create(developer,{projectId:'prj-agents'})).rejects.toMatchObject({status:409});expect((await f.pool.query('SELECT * FROM catalog_requests')).rows).toEqual([]);
    });
    it.each(['add','issue'])('edit preserves %s target requirements without writing a partial revision',async kind=>{
        const row=await create(developer,{kind,...(kind==='issue'?{target:{type:'mcp',id:'mcp-request'}}:{})});
        const input=edit(row,{target:kind==='add'?{type:'mcp',id:'mcp-request'}:null});
        await expect(f.service.edit(f.request(developer),row.id,input)).rejects.toMatchObject({status:400});expect((await f.service.get(f.request(developer),row.id)).revision).toBe(1);
    });
    it('removing a project keeps historical scope for main, without making it a common request',async()=>{
        const row=await create(developer,{projectId:'prj-agents'});await f.pool.query("DELETE FROM project_assets WHERE project_id='prj-agents';DELETE FROM project_models WHERE project_id='prj-agents';DELETE FROM project_members WHERE project_id='prj-agents';DELETE FROM projects WHERE id='prj-agents'");
        expect(await f.service.get(f.request(main),row.id)).toMatchObject({projectId:'prj-agents',projectName:'requestqa'});
        await expect(f.service.get(f.request(admin),row.id)).rejects.toMatchObject({status:403});expect((await f.service.list(f.request(stranger),{scope:'all'})).items).toEqual([]);
    });
    it('invalid intent, scope changes and action metadata never write partial rows',async()=>{
        for(const extra of [{kind:'delete'},{projectId:'prj-other'},{createdBy:main.email},{sourceUrl:'https://user:PRIVATE@example.test/'},{kind:'issue'},{kind:'add',target:{type:'mcp',id:'mcp-request'}}])await expect(create(developer,extra)).rejects.toHaveProperty('status');
        expect((await f.pool.query('SELECT * FROM catalog_requests')).rowCount).toBe(0);
        const row=await create();await expect(f.service.edit(f.request(developer),row.id,{...edit(row),projectId:'prj-agents'})).rejects.toMatchObject({status:400});
        await expect(f.service.action(f.request(main),row.id,action(row,'start',{target:{type:'mcp',id:'mcp-request'}}))).rejects.toMatchObject({status:400});expect((await f.service.get(f.request(developer),row.id)).revision).toBe(1);
    });
});
