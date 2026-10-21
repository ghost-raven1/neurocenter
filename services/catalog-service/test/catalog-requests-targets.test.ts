import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {currentActor} from '../src/catalog-requests/request.access';
import {checkedTarget} from '../src/catalog-requests/request.targets';
import {connection,requestsFixture,type RequestsFixture,fields,action,edit,main,admin,developer,stranger} from './catalog-requests-postgres.fixture';

describe.skipIf(!connection)('Catalog request targets — real project assignments and loopback skills',()=>{
    let f:RequestsFixture;
    const create=(extra:Record<string,unknown>={})=>f.service.create(f.request(developer),fields({projectId:'prj-agents',...extra}));
    const targets=(type:string,actor=main,extra:Record<string,unknown>={})=>f.service.targets(f.request(actor),{assetType:type,...extra});
    beforeAll(async()=>{f=await requestsFixture();});beforeEach(async()=>f.reset());afterAll(async()=>f?.close());
    it.each([['mcp','mcp-request',1],['plugin','plugin-request',1],['model','model-request',1],['skill','common/request_skill',3]])('completes %s with a current exact result version in the same project',async(type,id,version)=>{
        let row=await create({assetType:type});row=await f.service.action(f.request(admin),row.id,action(row,'start'));
        row=await f.service.action(f.request(admin),row.id,action(row,'complete',{comment:'Verified explicit result',target:{type,id}}));
        expect(row).toMatchObject({status:'completed',revision:3,target:{type,id,version,available:true}});expect(row.history.map(item=>item.action)).toEqual(['create','start','complete']);
        await expect(f.service.action(f.request(developer),row.id,action(row,'cancel'))).rejects.toMatchObject({status:403});
    });
    it.each(['update','issue'])('%s keeps the original target snapshot until explicit result completion',async kind=>{
        let row=await create({kind,target:{type:'mcp',id:'mcp-request'}});expect(row.target).toMatchObject({name:'Request MCP',version:1});
        await f.pool.query("UPDATE ai_plugins SET name='New head',version=2 WHERE id='mcp-request'");
        expect((await f.service.get(f.request(developer),row.id)).target).toMatchObject({name:'Request MCP',version:1});
        row=await f.service.edit(f.request(developer),row.id,edit(row,{description:'Updated intent'}));expect(row.target).toMatchObject({name:'New head',version:2});
        row=await f.service.action(f.request(admin),row.id,action(row,'start'));row=await f.service.action(f.request(admin),row.id,action(row,'complete',{comment:'Verified the changed head'}));
        expect(row).toMatchObject({status:'completed',target:{id:'mcp-request',version:2}});
    });
    it('validates target type, existence and project membership again before completion without partial history',async()=>{
        let row=await create();await expect(f.service.action(f.request(admin),row.id,action(row,'complete',{comment:'Premature',target:{type:'mcp',id:'mcp-request'}}))).rejects.toMatchObject({status:409});
        row=await f.service.action(f.request(admin),row.id,action(row,'start'));const before=await f.service.get(f.request(main),row.id);
        for(const target of [undefined,{type:'plugin',id:'plugin-request'},{type:'mcp',id:'missing'}])await expect(f.service.action(f.request(admin),row.id,action(row,'complete',{comment:'Invalid result',...(target?{target}:{})}))).rejects.toHaveProperty('status');
        expect(await f.service.get(f.request(main),row.id)).toEqual(before);
        await f.pool.query("DELETE FROM project_assets WHERE project_id='prj-agents' AND asset_id='mcp-request'");
        await expect(f.service.action(f.request(admin),row.id,action(row,'complete',{comment:'No longer assigned',target:{type:'mcp',id:'mcp-request'}}))).rejects.toMatchObject({status:409});expect((await f.service.get(f.request(main),row.id)).revision).toBe(2);
    });
    it.each(['mcp','model','skill'])('an archived %s target is unavailable for new intake and preserved as historical metadata',async type=>{
        const id=type==='mcp'?'mcp-request':type==='model'?'model-request':'common/request_skill',row=await create({kind:'issue',assetType:type,target:{type,id}}),before=row.target;
        if(type==='mcp')await f.pool.query('UPDATE ai_plugins SET archived_at=now() WHERE id=$1',[id]);
        if(type==='model')await f.pool.query('UPDATE model_catalog SET archived_at=now() WHERE id=$1',[id]);
        if(type==='skill')f.skills(200,[{path:id,meta:{name:'Changed head',version:10,archivedAt:'2026-01-01T00:00:00Z'}}]);
        expect((await f.service.get(f.request(developer),row.id)).target).toEqual({...before,available:false});
        await expect(create({kind:'issue',assetType:type,target:{type,id}})).rejects.toMatchObject({status:409});
    });
    it.each(['mcp','model','skill'])('removing a project %s assignment cannot keep historical availability true',async type=>{
        const id=type==='mcp'?'mcp-request':type==='model'?'model-request':'common/request_skill',row=await create({kind:'issue',assetType:type,target:{type,id}});
        await f.pool.query(type==='model'?"DELETE FROM project_models WHERE project_id='prj-agents' AND model_id=$1":"DELETE FROM project_assets WHERE project_id='prj-agents' AND asset_id=$1",[id]);
        expect((await f.service.get(f.request(developer),row.id)).target).toMatchObject({id,available:false});await expect(create({kind:'issue',assetType:type,target:{type,id}})).rejects.toMatchObject({status:409});
    });
    it('global discovery excludes private native skills; explicit project discovery includes its own ID/name paths only',async()=>{
        expect((await targets('skill')).items.map(item=>item.id)).toEqual(['common/request_skill','common/unassigned_skill']);
        const scoped=(await targets('skill',developer,{projectId:'prj-agents'})).items.map(item=>item.id);expect(scoped).toEqual(['common/request_skill','project-prj-agents/native_skill','project-requestqa/by_name_skill']);
        const available=(await targets('skill',developer)).items.map(item=>item.id);expect(available).toEqual(['common/request_skill']);
        await expect(f.service.create(f.request(main),fields({kind:'issue',assetType:'skill',target:{type:'skill',id:'project-prj-agents/native_skill'}}))).rejects.toMatchObject({status:409});
        expect((await create({kind:'issue',assetType:'skill',target:{type:'skill',id:'project-prj-agents/native_skill'}})).target?.available).toBe(true);
    });
    it('a native project skill stays available without a common assignment while another project never exposes it',async()=>{
        const row=await create({kind:'issue',assetType:'skill',target:{type:'skill',id:'project-requestqa/by_name_skill'}});expect(row.target).toMatchObject({version:4,available:true});
        await expect(targets('skill',stranger,{projectId:'prj-agents'})).rejects.toMatchObject({status:403});
        expect((await targets('skill',stranger,{projectId:'prj-other'})).items.map(item=>item.id)).toEqual(['project-prj-other/foreign_skill']);
    });
    it('search treats SQL wildcard characters as text, bounds results and filters card kinds',async()=>{
        await f.pool.query("INSERT INTO ai_plugins(id,name,kind) VALUES('mcp-literal','MCP_100%','mcp'),('mcp-pattern','MCPx100x','mcp')");
        expect((await targets('mcp',main,{q:'_'})).items.map(item=>item.id)).toEqual(['mcp-literal']);expect((await targets('mcp',main,{q:'%'})).items.map(item=>item.id)).toEqual(['mcp-literal']);
        expect((await targets('plugin')).items.map(item=>item.id)).toEqual(['plugin-request']);expect((await targets('model',main,{q:'Request',limit:'1'})).items).toHaveLength(1);
        expect((await targets('skill',main,{q:'REQUEST',limit:'1'})).items.map(item=>item.id)).toEqual(['common/request_skill']);
    });
    it('skill names fall back to paths, while searching a path also works when a different display name exists',async()=>{
        f.skills(200,[{path:'common/no_name',meta:{version:1}},{path:'common/by_path',meta:{name:'Human title',version:2}}]);
        expect((await targets('skill',main,{q:'no_name'})).items).toEqual([{id:'common/no_name',name:'common/no_name',version:1,type:'skill',available:true}]);
        expect((await targets('skill',main,{q:'by_path'})).items).toMatchObject([{id:'common/by_path',name:'Human title'}]);
    });
    it('global target references use a permitted common card without inventing a project assignment',async()=>{
        const row=await f.service.create(f.request(main),fields({kind:'issue',target:{type:'mcp',id:'mcp-request'}}));expect(row).toMatchObject({projectId:null,target:{id:'mcp-request',available:true}});
    });
    it('an unconfigured skills connection fails closed at the repository boundary',async()=>{
        delete process.env.NEUROCENTER_INTERNAL_TOKEN;
        try{await expect(f.service.repository.targets(main,{assetType:'skill'})).rejects.toMatchObject({status:503});expect(f.calls).toEqual([]);}
        finally{process.env.NEUROCENTER_INTERNAL_TOKEN=f.token;}
    });
    it('a closed project cannot be used for fresh target discovery',async()=>{
        await f.pool.query("UPDATE projects SET state='LOCKED' WHERE id='prj-agents'");await expect(targets('mcp',main,{projectId:'prj-agents'})).rejects.toMatchObject({status:409});
    });
    it('a skills outage is unknown for old history, blocks completion and leaves exact retry usable',async()=>{
        const old=await create({kind:'issue',assetType:'skill',target:{type:'skill',id:'common/request_skill'}});let row=await create({assetType:'skill'});row=await f.service.action(f.request(admin),row.id,action(row,'start'));
        const input=action(row,'complete',{comment:'Ready now',target:{type:'skill',id:'common/request_skill'}});f.skills(503);
        expect((await f.service.get(f.request(main),old.id)).target?.available).toBeNull();await expect(f.service.action(f.request(admin),row.id,input)).rejects.toMatchObject({status:503});
        expect((await f.service.get(f.request(main),row.id)).revision).toBe(2);expect((await f.pool.query('SELECT * FROM catalog_request_mutations WHERE request_key=$1',[input.requestKey])).rows).toEqual([]);
        f.skills(200);expect((await f.service.action(f.request(admin),row.id,input)).status).toBe('completed');expect(f.calls.every(call=>call.url==='/api/skills'&&call.token===f.token)).toBe(true);
    });
    it.each([{},[null],[{path:'common/x',meta:{version:0}}],[{path:'common/x',meta:{version:1,name:4}}],[{path:42,meta:{version:1}}]])('malformed skills response fails closed without converting an outage into a missing card %#',async response=>{
        f.skills(200,response);await expect(targets('skill')).rejects.toMatchObject({status:503});expect((await f.pool.query('SELECT * FROM catalog_requests')).rows).toEqual([]);
    });
    it('completion holds both target and assignment locks until its transaction commits',async()=>{
        const checking=await f.pool.connect(),competing=await f.pool.connect();
        try{
            await checking.query('BEGIN');await checkedTarget(checking,await currentActor(checking,admin),{type:'plugin',id:'plugin-request'},'plugin','prj-agents');
            for(const sql of ["UPDATE ai_plugins SET archived_at=now() WHERE id='plugin-request'","DELETE FROM project_assets WHERE project_id='prj-agents' AND asset_id='plugin-request'"]){await competing.query('BEGIN');await competing.query("SET LOCAL lock_timeout='75ms'");await expect(competing.query(sql)).rejects.toMatchObject({code:'55P03'});await competing.query('ROLLBACK');}
        }finally{await Promise.all([checking.query('ROLLBACK'),competing.query('ROLLBACK')]);checking.release();competing.release();}
    });
    it('removing an assignment after card discovery is caught before accepting the result',async()=>{
        const checking=await f.pool.connect(),competing=await f.pool.connect();let removed=false;
        try{
            await checking.query('BEGIN');await competing.query("SET lock_timeout='500ms'");const actor=await currentActor(checking,admin);
            const db={query:async(sql:string,values?:unknown[])=>{const result=await checking.query(sql,values);if(sql.includes('SELECT p.id,p.name,p.version')&&!removed){removed=true;await competing.query("DELETE FROM project_assets WHERE project_id='prj-agents' AND asset_id='plugin-request'");}return result;}} as unknown as Pick<PoolClient,'query'>;
            await expect(checkedTarget(db,actor,{type:'plugin',id:'plugin-request'},'plugin','prj-agents')).rejects.toMatchObject({status:409});expect(removed).toBe(true);
        }finally{await checking.query('ROLLBACK');await competing.query('RESET lock_timeout');checking.release();competing.release();}
    });
    it('a stale submitted revision and a forged target type never change the request identity',async()=>{
        const row=await create({kind:'issue',target:{type:'mcp',id:'mcp-request'}}),update=edit(row,{title:'Revised'});await f.service.edit(f.request(developer),row.id,update);
        await expect(f.service.edit(f.request(developer),row.id,{...update,requestKey:randomUUID()})).rejects.toMatchObject({status:409});
        await expect(f.service.edit(f.request(developer),row.id,edit({...row,revision:2},{target:{type:'model',id:'model-request'}}))).rejects.toMatchObject({status:400});
        expect((await f.service.get(f.request(developer),row.id)).target).toMatchObject({type:'mcp',id:'mcp-request'});
    });
});
