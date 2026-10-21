import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {agentAuditSnapshot} from '../src/agents/agent-audit';
import {listAuditHistory} from '../src/catalog/audit-history';
import {ensureCatalogSchema} from '../src/database/catalog-schema';

it('projects agent revision metadata without private prompt or settings',()=>{
    expect(agentAuditSnapshot({name:'Ревьюер',revision:3,version:2,enabled:false,overridden:true,promptSha256:'a'.repeat(64),
        prompt:'private prompt',permission:{bash:'allow'},credential:'private credential',projects:[{name:'Other project'}]}))
        .toEqual({name:'Ревьюер',revision:3,version:2,enabled:false,overridden:true,promptSha256:'a'.repeat(64),projectsCount:1});
});

it('does not invent revision values from malformed audit metadata',()=>{
    expect(agentAuditSnapshot(['private prompt'])).toBeNull();
    expect(agentAuditSnapshot({name:{value:'bad'},version:'2',revision:-1,enabled:'true',prompt:'private'})).toEqual({});
});

const connection=process.env.CATALOG_TEST_PG_URL;
const databases:Array<{admin:Pool;pool:Pool;name:string}>=[];
async function fixture(){
    const url=new URL(connection!);
    if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Only disposable localhost databases');
    url.pathname='/postgres';const admin=new Pool({connectionString:url.href,max:1});
    const name='nc_agent_audit_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
    url.pathname='/'+name;const pool=new Pool({connectionString:url.href,max:3});databases.push({admin,pool,name});
    await ensureCatalogSchema(pool);return pool;
}
describe.skipIf(!connection)('Agent audit through the actual SQL projection',()=>{
    let pool:Pool;
    beforeAll(async()=>{pool=await fixture();},30000);
    beforeEach(async()=>{await pool.query('DELETE FROM security_events');});
    afterAll(async()=>{for(const {pool,admin,name} of databases.splice(0)){await pool.end();await admin.query('DROP DATABASE '+name);await admin.end();}},30000);
    it.each(['agent.create','agent.update','agent.import','agent.snapshot','project.agent.assign','project.agent.update','project.agent.remove','project.agents.connect'])('retains readable details for %s without prompt bytes',async action=>{
        await pool.query(`INSERT INTO security_events(event_id,actor,action,resource_id,before_state,after_state)
            VALUES($1,'agent-audit@example.test',$2,'agent-fixture',$3,$4)`,[randomUUID(),action,
            {name:'До',version:1,prompt:'private prompt',permission:{bash:'allow'}},
            {name:'После',version:2,revision:4,projectId:'project-fixture',enabled:false,promptSha256:'b'.repeat(64),credential:'private credential'}]);
        const result=await listAuditHistory(pool,1,20);
        expect(result.total).toBe(1);expect(result.items[0].details).toEqual({
            before:{name:'До',version:1},after:{name:'После',version:2,revision:4,projectId:'project-fixture',enabled:false,promptSha256:'b'.repeat(64)},
        });
        expect(JSON.stringify(result)).not.toMatch(/private prompt|private credential|permission/);
    });
    it('restricts generic archive details to agents and preserves the project impact count',async()=>{
        for(const kind of ['agent','model'])await pool.query(`INSERT INTO security_events(event_id,actor,action,resource_id,before_state,after_state)
            VALUES($1,'agent-audit@example.test','asset.archive',$2,$3,$4)`,[randomUUID(),kind,{kind,name:'Архив',version:2,projects:[{id:'private-other-project'}]},
            {kind,mode:'catalog-and-projects',archived:true,prompt:'private prompt'}]);
        const result=await listAuditHistory(pool,1,20);
        expect(result.items.find(event=>event.resourceId==='agent')?.details).toEqual({before:{kind:'agent',name:'Архив',version:2,projectsCount:1},after:{kind:'agent',mode:'catalog-and-projects',archived:true}});
        expect(result.items.find(event=>event.resourceId==='model')?.details).toBeNull();
        expect(JSON.stringify(result)).not.toMatch(/private-other-project|private prompt/);
    });
});
