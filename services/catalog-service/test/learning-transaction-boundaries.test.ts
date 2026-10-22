import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {statfs} from 'node:fs/promises';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {LearningRepository} from '../src/learning/learning.repository';
import {LearningAnalysisRepository} from '../src/learning/learning-analysis.repository';
import {projectEmbeddingPin} from '../src/models/project-embedding.validation';
import type {IModel} from '../src/models/model.types';
import type {AnalysisRow} from '../src/learning/learning-analysis.types';
import {ownedLearningTestAdminUrl} from './learning-postgres.fixture';

const connection=process.env.LEARNING_TEST_ADMIN_PG_URL;
const projectId='prj-learning-boundaries',otherProject='prj-learning-other';
const main={email:'main@learning.fixture',activeRole:'Главный админ'},developer={email:'dev@learning.fixture',activeRole:'Разработчик'};
const origin={origin:'human' as const,device:null};
const sample={title:'Наблюдение',summary:'Проверка дала воспроизводимый результат.',outcome:'failed' as const,evidence:[{kind:'test' as const,status:'failed' as const,summary:'Несовпадение результата.'}]};
const model:IModel={id:'model-learning-boundaries',name:'Owned fixture',description:'',runtime:'remote-openai',capability:'chat',model:'owned-fixture',modelVersion:'v1',manifestSha256:null,verificationSha256:'a'.repeat(64),dimension:null,source:'custom',revision:1,createdAt:'',updatedAt:''};

/** Each fault follows real SQL; a separate connection observes only committed effects. */
describe.skipIf(!connection).sequential('Learning transaction failure and authorization boundaries — owned PostgreSQL',()=>{
    const database='nc_learning_boundaries_'+randomUUID().replaceAll('-','');
    let admin:Pool,pool:Pool,observer:Pool,repository:LearningRepository,analyses:LearningAnalysisRepository,created=false;
    beforeAll(async()=>{
        const url=ownedLearningTestAdminUrl(connection);
        const disk=await statfs(process.cwd(),{bigint:true});if(disk.bavail*disk.bsize<4n*1024n**3n)throw Error('Learning fixture disk admission requires4GiB.');
        url.pathname='/postgres';admin=new Pool({connectionString:url.href,max:1});await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
        observer=new Pool({connectionString:url.href,max:2});pool=new Pool({connectionString:url.href,max:1,application_name:'owned-learning-boundaries'});
        await ensureCatalogSchema(observer);repository=new LearningRepository(pool);analyses=new LearningAnalysisRepository(pool);
    });
    beforeEach(async()=>{
        await observer.query('TRUNCATE projects,platform_users,model_catalog,security_events CASCADE');
        await observer.query('INSERT INTO projects(id,name) VALUES($1,$2),($3,$4)',[projectId,'Learning',otherProject,'Other']);
        await observer.query('INSERT INTO platform_users(email,is_main_admin) VALUES($1,true),($2,false)',[main.email,developer.email]);
        await observer.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,'Developer','Разработчик')",[projectId,developer.email]);
        const {id,name,revision:_revision,createdAt:_created,updatedAt:_updated,...descriptor}=model;
        await observer.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb)',[id,name,JSON.stringify(descriptor)]);
        await observer.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)',[projectId,id,main.email]);
    });
    afterEach(async()=>{vi.restoreAllMocks();await pool?.query('ROLLBACK');});
    afterAll(async()=>{await pool?.end();await observer?.end();if(created)await admin.query('DROP DATABASE '+database);await admin?.end();});
    const revision=async()=>Number((await observer.query('SELECT revision FROM project_learning_state WHERE project_id=$1',[projectId])).rows[0]?.revision??0);
    const count=async(table:string)=>Number((await observer.query('SELECT count(*) AS n FROM '+table)).rows[0].n);
    const input=async()=>({requestKey:randomUUID(),expectedRevision:await revision(),...sample});
    const experience=async()=>repository.addExperience(developer,projectId,await input(),origin);
    const subsequentRead=()=>repository.read(main,otherProject,db=>db.query('SELECT 1'));
    async function job(){
        const source=await experience(),body={requestKey:randomUUID(),expectedRevision:source.revision,experienceIds:[source.result.experience.id],modelId:model.id};
        const row=await analyses.enqueue({actor:developer,projectId,revision:source.revision,experiences:[source.result.experience]},body,projectEmbeddingPin(model));
        return{row,body,source};
    }
    async function running(){await job();return(await analyses.claim(randomUUID()))!;}
    async function committedHypotheses(row:AnalysisRow){
        const draft={subject:'project' as const,title:'Проверяемая гипотеза',statement:'Результат зависит от порядка.',rationale:'Есть повторяемый опыт.',verificationPlan:'Повторить с переставленными ключами.',experienceIds:row.input.experienceIds};
        return repository.addHypotheses(developer,projectId,{requestKey:row.mutation_key,expectedRevision:Number(row.source_revision),hypotheses:[draft],model:{modelId:row.model_id,modelPin:row.model_pin,analysisId:row.id,sourceRevision:Number(row.source_revision)}},{origin:'llm',device:null},db=>analyses.authorizeResult(db,row),true);
    }
    async function lifecycleUnlocked(){
        const client=await observer.connect();try{await client.query('BEGIN');return(await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('neurocenter:project-lifecycle:'||$1,0)) AS unlocked",[projectId])).rows[0].unlocked;}
        finally{await client.query('ROLLBACK');client.release();}
    }
    function fault(afterSql:string,options:{rollbackFails?:boolean;message?:string}={}){
        const connect=pool.connect.bind(pool);let pid=0,failed=false,destroyed:boolean|Error|undefined;
        const error=new Error(options.message??'Own SQL completed but response lost');
        vi.spyOn(pool,'connect').mockImplementationOnce(async()=>{
            const client=await connect(),query=client.query.bind(client),release=client.release.bind(client);pid=(await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            client.query=(async(text:string,...args:unknown[])=>{
                if(text==='ROLLBACK'&&options.rollbackFails)throw Error('Own ROLLBACK unavailable');
                const result=await(query as(...args:unknown[])=>Promise<unknown>)(text,...args);
                if(!failed&&text.includes(afterSql)){failed=true;throw error;}return result;
            })as PoolClient['query'];
            client.release=(destroy?:boolean|Error)=>{destroyed=destroy;client.query=query as PoolClient['query'];client.release=release;release(destroy);};return client;
        });
        return{error,pid:()=>pid,failed:()=>failed,destroyed:()=>destroyed};
    }
    async function expectDiscarded(f:ReturnType<typeof fault>){
        expect(f.failed()).toBe(true);expect(f.destroyed()).toBeTruthy();
        await vi.waitFor(async()=>expect((await observer.query('SELECT state FROM pg_stat_activity WHERE pid=$1',[f.pid()])).rows).toEqual([]));
        expect(await lifecycleUnlocked()).toBe(true);
    }
    it('does not let a later read COMMIT an experience whose INSERT and ROLLBACK were not acknowledged',async()=>{
        const f=fault('INSERT INTO project_learning_experiences',{rollbackFails:true}),body=await input();
        await expect(repository.addExperience(developer,projectId,body,origin)).rejects.toBe(f.error);
        await subsequentRead();expect(await count('project_learning_experiences')).toBe(0);expect(await revision()).toBe(0);expect(await count('project_learning_requests')).toBe(0);
        await expectDiscarded(f);const retry=await repository.addExperience(developer,projectId,body,origin);expect(retry.revision).toBe(1);expect(await count('project_learning_experiences')).toBe(1);expect(await count('project_learning_requests')).toBe(1);
    });
    it('does not retain authorization/lifecycle locks after a failed read rollback',async()=>{
        const f=fault('SELECT revision FROM project_learning_state',{rollbackFails:true});
        await expect(repository.read(developer,projectId,db=>repository.revision(projectId,db))).rejects.toBe(f.error);
        expect(await lifecycleUnlocked()).toBe(true);await expectDiscarded(f);await subsequentRead();
    });
    it('does not let a later read COMMIT a failed analysis enqueue',async()=>{
        const source=await experience(),body={requestKey:randomUUID(),expectedRevision:source.revision,experienceIds:[source.result.experience.id],modelId:model.id};
        const f=fault('INSERT INTO project_learning_analyses',{rollbackFails:true});
        await expect(analyses.enqueue({actor:developer,projectId,revision:source.revision,experiences:[source.result.experience]},body,projectEmbeddingPin(model))).rejects.toBe(f.error);
        await subsequentRead();expect(await count('project_learning_analyses')).toBe(0);await expectDiscarded(f);
        const retry=await analyses.enqueue({actor:developer,projectId,revision:source.revision,experiences:[source.result.experience]},body,projectEmbeddingPin(model));expect(retry.state).toBe('queued');expect(await count('project_learning_analyses')).toBe(1);
    });
    it('does not retain authorization/lifecycle locks after a failed current-worker rollback',async()=>{
        const row=await running(),f=fault('SELECT id FROM project_learning_analyses WHERE id=$1',{rollbackFails:true});
        await expect(analyses.current(row)).rejects.toBe(f.error);expect(await lifecycleUnlocked()).toBe(true);await expectDiscarded(f);
        await expect(analyses.current(row)).resolves.toBeUndefined();
    });
    it('does not let an unrelated read commit a failed expired-job transition',async()=>{
        const row=await running();await observer.query("UPDATE project_learning_analyses SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[row.id]);
        const f=fault("UPDATE project_learning_analyses SET state='unknown'",{rollbackFails:true});await expect(analyses.recoverExpired()).rejects.toBe(f.error);
        await subsequentRead();expect((await analyses.get(projectId,row.id)).state).toBe('running');await expectDiscarded(f);
        await analyses.recoverExpired();expect((await analyses.get(projectId,row.id)).state).toBe('unknown');
    });
    it('does not let an unrelated read commit a failed exact-receipt reconciliation',async()=>{
        const row=await running(),saved=await committedHypotheses(row),f=fault("UPDATE project_learning_analyses SET state='completed'",{rollbackFails:true});
        await expect(analyses.reconcile(row)).rejects.toBe(f.error);await subsequentRead();expect((await analyses.get(projectId,row.id)).state).toBe('running');await expectDiscarded(f);
        expect(await analyses.reconcile(row)).toBe(true);expect((await analyses.get(projectId,row.id)).hypothesis_ids).toEqual(saved.result.hypotheses.map(item=>item.id));expect(await count('project_learning_hypotheses')).toBe(1);
    });
    it('retains a healthy session after acknowledged rollback and preserves the original query error',async()=>{
        const f=fault('INSERT INTO project_learning_experiences');await expect(experience()).rejects.toBe(f.error);
        expect(f.destroyed()).toBeFalsy();expect(await lifecycleUnlocked()).toBe(true);expect(await count('project_learning_experiences')).toBe(0);
        expect((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(f.pid());expect((await experience()).revision).toBe(1);
    });
    it('replays one exact mutation after an actual COMMIT whose acknowledgement was lost',async()=>{
        const body=await input(),f=fault('COMMIT');await expect(repository.addExperience(developer,projectId,body,origin)).rejects.toBe(f.error);
        expect(await count('project_learning_experiences')).toBe(1);const saved=await repository.addExperience(developer,projectId,body,origin);expect(saved.revision).toBe(1);
        expect(await count('project_learning_experiences')).toBe(1);expect(await count('project_learning_requests')).toBe(1);expect(await count('project_learning_history')).toBe(1);
    });
    it.each(['account','membership']as const)('rechecks a revoked %s after waiting for the real lifecycle lock',async revoked=>{
        const holder=await observer.connect();let pending:Promise<unknown>|undefined;
        try{
            await holder.query('BEGIN');await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:project-lifecycle:'||$1,0))",[projectId]);
            pending=repository.addExperience(developer,projectId,await input(),origin);void pending.catch(()=>undefined);
            await vi.waitFor(async()=>expect((await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND application_name='owned-learning-boundaries' AND wait_event_type='Lock'",[database])).rows).toHaveLength(1));
            if(revoked==='account')await holder.query('UPDATE platform_users SET enabled=false WHERE email=$1',[developer.email]);
            else await holder.query('DELETE FROM project_members WHERE project_id=$1 AND principal_name=$2',[projectId,developer.email]);
            await holder.query('COMMIT');await expect(pending).rejects.toMatchObject({status:403});expect(await count('project_learning_experiences')).toBe(0);expect(await revision()).toBe(0);
        }finally{await holder.query('ROLLBACK');holder.release();await pending?.catch(()=>undefined);}
    });
});
