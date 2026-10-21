import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {ProjectAgent} from '../../shared/project-agents.cjs';
import {agentModelRequirements} from '../src/agents/agent-model-requirements';
import {connection,database,reset,definition} from './agent-postgres.fixture';

describe.skipIf(!connection)('Agent model requirements — exact project pins without provider credentials',()=>{
    let fixture:Awaited<ReturnType<typeof database>>,pool:Pool;
    const semantic='d'.repeat(64),baseUrl='https://private-provider.example.test/v1';
    const agent=(patch:Partial<ProjectAgent>={}):ProjectAgent=>({id:'agent-'+randomUUID(),slug:'nc-review',version:1,enabled:true,...definition,...patch});
    const create=async(patch:Record<string,unknown>={},assigned=true)=>{
        const id='model-'+randomUUID();await pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3)',[id,'Model fixture '+id,{description:'QA',runtime:'remote-openai',model:'upstream-chat',modelVersion:'v1',capability:'chat',dimension:null,source:'custom',manifestSha256:null,verificationSha256:semantic,...patch}]);
        if(assigned)await pool.query("INSERT INTO project_models(project_id,model_id,added_by) VALUES('prj-agents',$1,'fixture')",[id]);
        return id;
    };
    const connect=(id:string,revision=1,options:Record<string,number>={contextWindow:128000,temperature:0},sha=semantic)=>pool.query(`INSERT INTO model_remote_connections(model_id,revision,base_url,request_dimensions,credential_kind,credential,options,semantic_sha,verified_at)
        VALUES($1,$2,$3,false,'stored',$4,$5,$6,now())`,[id,revision,baseUrl,{PRIVATE_KEY:'encrypted-value-is-never-decrypted-here'},options,sha]);
    const requirements=(agents:ProjectAgent[])=>agentModelRequirements(pool,'prj-agents',agents);
    beforeAll(async()=>{if(new URL(connection!).port==='5432')throw Error('Use an owned disposable PostgreSQL port.');fixture=await database();pool=fixture.pool;});
    beforeEach(async()=>{await reset(pool);await pool.query('TRUNCATE model_catalog CASCADE');});
    afterAll(async()=>fixture?.close());

    it('default and disabled agents do not require model setup or inspect the provider table',async()=>{
        const query=vi.spyOn(pool,'query');try{expect(await requirements([agent({model:undefined}),agent({enabled:false,model:'neurocenter/missing'})])).toEqual([]);expect(query).not.toHaveBeenCalled();}finally{query.mockRestore();}
    });
    it('native selectors are retained as native requirements without catalogue lookups',async()=>{
        const item=agent({model:'team/upstream-chat'}),query=vi.spyOn(pool,'query');
        try{expect(await requirements([item])).toEqual([{kind:'native',agentId:item.id,selector:'team/upstream-chat'}]);expect(query).not.toHaveBeenCalled();}finally{query.mockRestore();}
    });
    it.each(['missing','foreign-project','archived','embedding','unverified','missing-connection','revoked-connection'])('fails closed for %s with bounded public recovery guidance',async reason=>{
        const id=reason==='missing'?'model-missing':await create(reason==='embedding'?{capability:'embedding',dimension:3}:reason==='unverified'?{verificationSha256:null}:{},reason!=='foreign-project');
        if(!['missing','missing-connection','unverified'].includes(reason))await connect(id);
        if(reason==='archived')await pool.query('UPDATE model_catalog SET archived_at=now() WHERE id=$1',[id]);
        if(reason==='revoked-connection')await pool.query('UPDATE model_remote_connections SET revoked_at=now() WHERE model_id=$1',[id]);
        const item=agent({model:'neurocenter/'+id}),before=(await pool.query('SELECT descriptor FROM model_catalog WHERE id=$1',[id])).rows;
        const error=await requirements([item]).catch(value=>value);
        expect(error).toMatchObject({status:409,response:{statusCode:409,code:'OPENCODE_AGENT_MODEL_SETUP_REQUIRED',agentId:item.id,modelId:id,action:'sync-opencode-models'}});
        expect(JSON.stringify(error.response)).not.toMatch(/PRIVATE_KEY|private-provider|encrypted-value/);
        expect((await pool.query('SELECT descriptor FROM model_catalog WHERE id=$1',[id])).rows).toEqual(before);
    });
    it('pins the verified connection semantics and options rather than a newer unverified configuration',async()=>{
        const id=await create();await connect(id);await connect(id,2,{contextWindow:4096},'e'.repeat(64));
        const item=agent({model:'neurocenter/'+id}),[saved]=await requirements([item]);
        expect(saved).toMatchObject({kind:'catalog',agentId:item.id,catalogModelId:id,runtime:'remote-openai',runtimeModel:'upstream-chat',baseUrl,options:{contextWindow:128000,temperature:0},capability:'chat',modelPin:expect.stringMatching(/^[a-f0-9]{64}$/)});
        expect(JSON.stringify(saved)).not.toMatch(/PRIVATE_KEY|encrypted-value|credential/);
    });
    it.each(['chat','vision'])('allows a verified %s model, keeping different model windows distinct',async capability=>{
        const first=await create({capability}),second=await create({capability});await connect(first,1,{contextWindow:4096});await connect(second,1,{contextWindow:128000});
        const saved=await requirements([agent({model:'neurocenter/'+first}),agent({model:'neurocenter/'+second})]);
        expect(saved.map(row=>row.kind==='catalog'&&row.options.contextWindow)).toEqual([4096,128000]);expect(saved.map(row=>row.kind==='catalog'&&row.capability)).toEqual([capability,capability]);
    });
    it('local catalog models require a manifest but no remote connection or provider URL',async()=>{
        const id=await create({runtime:'ollama',verificationSha256:null,manifestSha256:'f'.repeat(64)}),item=agent({model:'neurocenter/'+id});
        expect(await requirements([item])).toMatchObject([{kind:'catalog',catalogModelId:id,runtime:'ollama',baseUrl:null,options:{}}]);
        await pool.query("UPDATE model_catalog SET descriptor=jsonb_set(descriptor,'{manifestSha256}','null'::jsonb) WHERE id=$1",[id]);
        await expect(requirements([item])).rejects.toMatchObject({status:409,response:{code:'OPENCODE_AGENT_MODEL_SETUP_REQUIRED'}});
    });
    it('runtime connection metadata is validated before creating a deliverable model requirement',async()=>{
        const id=await create();await connect(id);await pool.query('UPDATE model_remote_connections SET options=$2 WHERE model_id=$1',[id,{temperature:3}]);
        await expect(requirements([agent({model:'neurocenter/'+id})])).rejects.toMatchObject({status:400});
        expect((await pool.query('SELECT * FROM bridge_jobs')).rows).toEqual([]);
    });
});
