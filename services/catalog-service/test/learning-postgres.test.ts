import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {LearningRepository} from '../src/learning/learning.repository';
import {requireLearningHuman} from '../src/learning/learning-access';
import {assertLearningSchema} from '../src/learning/learning-schema-verification';
import type {LearningCandidateInput,LearningExperienceInput,LearningHypothesisDraft} from '../../shared/project-learning.cjs';
import {connection,database,reset,admin,developer,main} from './agent-postgres.fixture';
const projectId='prj-agents',origin={origin:'human' as const,device:null};
const evidence={kind:'test' as const,status:'failed' as const,summary:'Одинаковые значения дают различный результат.'};
describe.skipIf(!connection)('Project learning — actual canonical PostgreSQL',()=>{
    let fixture:Awaited<ReturnType<typeof database>>,pool:Pool,repository:LearningRepository;
    beforeAll(async()=>{fixture=await database();pool=fixture.pool;repository=new LearningRepository(pool);});
    afterAll(async()=>{await fixture?.close();});beforeEach(async()=>{await pool.query('TRUNCATE project_retirements CASCADE');await reset(pool);});
    const request=async()=>({requestKey:randomUUID(),expectedRevision:await repository.revision(projectId)});
    const experience=async(changes:Partial<LearningExperienceInput>={})=>repository.addExperience(developer,projectId,{...await request(),title:'Наблюдение',summary:'Проверка обнаружила различие.',outcome:'failed',evidence:[evidence],...changes},origin);
    const hypothesis=async()=>{
        const exp=await experience(),draft:LearningHypothesisDraft={subject:'project',title:'Порядок ключей',statement:'Сравнение зависит от порядка ключей.',rationale:'Есть наблюдаемое различие.',verificationPlan:'Сравнить одинаковые значения с разным порядком ключей.',experienceIds:[exp.result.experience.id]};
        const proposed=await repository.addHypotheses(developer,projectId,{...await request(),hypotheses:[draft]},origin);return {experience:exp.result.experience,hypothesis:proposed.result.hypotheses[0],draft};
    };
    const verified=async()=>{
        const source=await hypothesis(),checked=await repository.addCheck(developer,projectId,source.hypothesis.id,{...await request(),method:'human_review',result:'passed',summary:'Повторено на двух вариантах, причина подтверждена.',experienceIds:[source.experience.id]});
        return {...source,check:checked.result.check};
    };
    const candidate=async(source:Awaited<ReturnType<typeof verified>>,changes:Partial<LearningCandidateInput>={})=>repository.addCandidate(developer,projectId,{...await request(),hypothesisId:source.hypothesis.id,checkId:source.check.id,key:'canonical-json',kind:'lesson',title:'Сравнивать значения',content:'При сравнении объектов нормализовать порядок ключей.',...changes});
    const context=()=>repository.read(admin,projectId,db=>repository.context(db,projectId));
    it('records append-only evidence and exact receipts, including after subsequent revisions',async()=>{
        const input={...await request(),title:'Наблюдение',summary:'Исходный факт',outcome:'unknown' as const,evidence:[evidence]},first=await repository.addExperience(developer,projectId,input,origin);
        await experience();expect(await repository.addExperience(developer,projectId,input,origin)).toEqual(first);
        await expect(repository.addExperience(developer,projectId,{...input,summary:'Другой факт'},origin)).rejects.toMatchObject({status:409});
        expect((await context()).entries).toEqual([]);expect((await repository.receipt(pool,developer,projectId,input.requestKey))?.revision).toBe(1);
        expect(await repository.receipt(pool,admin,projectId,input.requestKey)).toBeNull();
    });
    it('rolls back source, revision, history and receipt on audit failure',async()=>{
        await pool.query("CREATE FUNCTION reject_learning_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;CREATE TRIGGER reject_learning_audit BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION reject_learning_audit()");
        try{await expect(experience()).rejects.toThrow('audit unavailable');expect(await repository.revision(projectId)).toBe(0);expect(await repository.experiences(pool,projectId)).toHaveLength(0);expect((await pool.query('SELECT * FROM project_learning_requests')).rowCount).toBe(0);}
        finally{await pool.query('DROP TRIGGER reject_learning_audit ON security_events;DROP FUNCTION reject_learning_audit()');}
        expect((await experience()).revision).toBe(1);
    });
    it('never promotes a hypothesis or LLM assessment into verified knowledge',async()=>{
        const source=await hypothesis(),assessment=await repository.addCheck(developer,projectId,source.hypothesis.id,{...await request(),method:'llm_assessment',result:'passed',summary:'Модель считает предположение вероятным.',experienceIds:[source.experience.id]});
        expect(assessment.result.hypothesis.status).toBe('open');
        await expect(repository.addCandidate(developer,projectId,{...await request(),hypothesisId:source.hypothesis.id,checkId:assessment.result.check.id,key:'unsafe',kind:'lesson',title:'Предложение',content:'Непроверенный вывод'})).rejects.toMatchObject({status:409});
        expect((await context()).entries).toEqual([]);
    });
    it('isolates evidence, hypotheses and candidate provenance across projects',async()=>{
        const source=await verified();await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES('prj-other',$1,$1,'Dev','Разработчик')",[developer.email]);
        await expect(repository.addHypotheses(developer,'prj-other',{requestKey:randomUUID(),expectedRevision:0,hypotheses:[source.draft]},origin)).rejects.toMatchObject({status:400});
        expect(await repository.revision('prj-other')).toBe(0);expect(await repository.hypotheses(pool,'prj-other')).toEqual([]);
        await expect(repository.addCandidate(developer,'prj-other',{requestKey:randomUUID(),expectedRevision:0,hypothesisId:source.hypothesis.id,checkId:source.check.id,key:'wrong-project',kind:'lesson',title:'Чужое',content:'Чужое доказательство'})).rejects.toMatchObject({status:404});
    });
    it('requires current human approval, keeps older approved versions and explicitly rolls back',async()=>{
        const source=await verified(),first=(await candidate(source)).result.candidate;
        await expect(repository.candidateAction(developer,projectId,first.id,await request(),'approve')).rejects.toMatchObject({status:403});
        await repository.candidateAction(admin,projectId,first.id,await request(),'approve');expect((await context()).entries[0].version).toBe(1);
        const second=(await candidate(source,{content:'Новая уточнённая инструкция.',kind:'instruction'})).result.candidate;
        await repository.candidateAction(admin,projectId,second.id,await request(),'approve');expect((await context()).entries[0]).toMatchObject({id:second.id,version:2,kind:'instruction'});
        await repository.candidateAction(admin,projectId,first.id,await request(),'activate');expect((await context()).entries[0].id).toBe(first.id);
        await repository.candidateAction(admin,projectId,first.id,{...await request(),reason:'Проверка выявила ограничение.'},'revoke');expect((await context()).entries).toEqual([]);
        await expect(repository.candidateAction(admin,projectId,first.id,await request(),'activate')).rejects.toMatchObject({status:409});
        const history=await repository.history(pool,projectId);expect(history.map(row=>row.action)).toContain('candidate.activate');expect(JSON.stringify((await pool.query('SELECT * FROM security_events')).rows)).not.toContain(first.content);
    });
    it('withdraws contradicted active context and requires another explicit activation after new evidence',async()=>{
        const source=await verified(),saved=(await candidate(source)).result.candidate;await repository.candidateAction(admin,projectId,saved.id,await request(),'approve');
        await repository.addCheck(developer,projectId,source.hypothesis.id,{...await request(),method:'human_review',result:'failed',summary:'Контрпример опровергает обобщение.',experienceIds:[source.experience.id]});
        expect((await context()).entries).toEqual([]);await expect(repository.candidateAction(admin,projectId,saved.id,await request(),'activate')).rejects.toMatchObject({status:409});
        await repository.addCheck(developer,projectId,source.hypothesis.id,{...await request(),method:'human_review',result:'passed',summary:'После уточнения область применимости подтверждена.',experienceIds:[source.experience.id]});
        expect((await context()).entries).toEqual([]);await repository.candidateAction(admin,projectId,saved.id,await request(),'activate');expect((await context()).entries[0].id).toBe(saved.id);
    });
    it('serializes competing CAS editors and concurrent retries of the same request',async()=>{
        const first={...await request(),title:'Наблюдение',summary:'Факт',outcome:'unknown' as const,evidence:[evidence]},results=await Promise.allSettled([repository.addExperience(developer,projectId,first,origin),repository.addExperience(developer,projectId,{...first,requestKey:randomUUID()},origin)]);
        expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(await repository.revision(projectId)).toBe(1);
        const repeat={...first,...await request()},copies=await Promise.all([repository.addExperience(developer,projectId,repeat,origin),repository.addExperience(developer,projectId,repeat,origin)]);expect(copies[0]).toEqual(copies[1]);expect(await repository.revision(projectId)).toBe(2);
    });
    it('append observations do not use a client revision and recheck device authorization on replay',async()=>{
        const {expectedRevision:_revision,...input}={...await request(),title:'Метаданные',summary:'Счётчики изменения файлов.',outcome:'unknown' as const,evidence:[{...evidence,status:'unknown' as const}]},device={deviceId:randomUUID(),bindingId:'a'.repeat(64),instanceId:randomUUID()};let allowed=true;
        const authorize=async()=>{if(!allowed)throw new Error('device revoked');};
        const first=await repository.addExperience(developer,projectId,input,{origin:'device',device},authorize,true);await experience();
        expect(await repository.addExperience(developer,projectId,input,{origin:'device',device},authorize,true)).toEqual(first);allowed=false;
        await expect(repository.addExperience(developer,projectId,input,{origin:'device',device},authorize,true)).rejects.toThrow('device revoked');expect(await repository.revision(projectId)).toBe(2);
    });
    it('late analysis safely appends only open hypotheses with its original evidence snapshot',async()=>{
        const source=await hypothesis(),input={requestKey:randomUUID(),expectedRevision:1,hypotheses:[source.draft],model:{modelId:'model-test',modelPin:'b'.repeat(64),analysisId:randomUUID(),sourceRevision:1}};
        await experience();const generated=await repository.addHypotheses(developer,projectId,input,{origin:'llm',device:null},async()=>undefined,true);
        expect(generated.result.hypotheses[0]).toMatchObject({status:'open',origin:'llm',model:{sourceRevision:1}});expect((await context()).entries).toEqual([]);
        expect(await repository.addHypotheses(developer,projectId,input,{origin:'llm',device:null},async()=>undefined,true)).toEqual(generated);
        const revision=await repository.revision(projectId);await expect(repository.addHypotheses(developer,projectId,{...input,requestKey:randomUUID()},{origin:'llm',device:null},async()=>{throw new Error('worker lease lost');},true)).rejects.toThrow('worker lease lost');expect(await repository.revision(projectId)).toBe(revision);
    });
    it('fresh role revocation blocks replay, retired project writes and browser-only decisions reject device tokens',async()=>{
        const saved=await experience();await pool.query('DELETE FROM project_members WHERE principal_name=$1',[developer.email]);
        await expect(repository.read(developer,projectId,db=>repository.receipt(db,developer,projectId,saved.requestKey))).rejects.toMatchObject({status:403});
        expect(()=>requireLearningHuman({headers:{authorization:'Bearer device'}} as never)).toThrow();expect(()=>requireLearningHuman({headers:{'x-neurocenter-device-id':randomUUID()}} as never)).toThrow();expect(()=>requireLearningHuman({headers:{cookie:'session'}} as never)).not.toThrow();
        await pool.query("INSERT INTO project_retirements(project_id,project_name,actor,origin) VALUES($1,'Retired',$2,'web')",[projectId,main.email]);
        await expect(repository.addExperience(main,projectId,{...await request(),title:'Позднее',summary:'Не должно сохраниться',outcome:'unknown',evidence:[evidence]},origin)).rejects.toMatchObject({status:403});
    });
    it('database guards protect immutable source bytes, checks, candidate content, history and receipts',async()=>{
        const source=await verified(),saved=(await candidate(source)).result.candidate;
        for(const table of ['project_learning_experiences','project_learning_hypotheses','project_learning_checks','project_learning_candidates'])await expect(pool.query(`UPDATE ${table} SET data='{}'::jsonb WHERE project_id=$1`,[projectId])).rejects.toThrow('immutable');
        await expect(pool.query("UPDATE project_learning_history SET action='forged' WHERE project_id=$1",[projectId])).rejects.toThrow('immutable');
        await expect(pool.query("UPDATE project_learning_requests SET result='{}'::jsonb WHERE project_id=$1",[projectId])).rejects.toThrow('immutable');
        await expect(pool.query('DELETE FROM project_learning_candidates WHERE id=$1',[saved.id])).rejects.toThrow('immutable');
        await pool.query('DELETE FROM projects WHERE id=$1',[projectId]);expect((await pool.query('SELECT * FROM project_learning_state WHERE project_id=$1',[projectId])).rowCount).toBe(0);
    });
    it('checks the complete structural schema and fails closed after a disabled integrity trigger',async()=>{
        await expect(assertLearningSchema(pool)).resolves.toBeUndefined();await pool.query('ALTER TABLE project_learning_experiences DISABLE TRIGGER neurocenter_learning_immutable');
        try{await expect(assertLearningSchema(pool)).rejects.toThrow('Схема проектного обучения');}finally{await pool.query('ALTER TABLE project_learning_experiences ENABLE TRIGGER neurocenter_learning_immutable');}
    });
    it('checks the complete context budget before approving and preserves the old head on failure',async()=>{
        const source=await verified();let blockedId='';
        for(let n=0;n<8;n++){
            const proposed=(await candidate(source,{key:'entry-'+n,content:'x'.repeat(16384)})).result.candidate;
            if(n<7)await repository.candidateAction(admin,projectId,proposed.id,await request(),'approve');
            else{blockedId=proposed.id;await expect(repository.candidateAction(admin,projectId,proposed.id,await request(),'approve')).rejects.toMatchObject({status:400});}
        }
        expect((await context()).entries).toHaveLength(7);expect((await repository.candidates(pool,projectId,blockedId))[0]).toMatchObject({status:'proposed',approvedAt:null,active:false});
    });
    it('pages observations without hiding older source details or accepting another project cursor',async()=>{
        const source=await experience();
        for(let n=0;n<104;n++)await experience({title:'Наблюдение '+n});
        const first=await repository.page(pool,projectId,'experiences');expect(first.items).toHaveLength(100);expect(first.total).toBe(105);expect(first.nextCursor).toBeTruthy();
        const second=await repository.page(pool,projectId,'experiences',first.nextCursor!);expect(second.items).toHaveLength(5);expect(second.nextCursor).toBeNull();
        expect(new Set([...first.items,...second.items].map(item=>item.id)).size).toBe(105);expect(first.items.some(item=>item.id===source.result.experience.id)).toBe(false);
        expect((await repository.detail(pool,projectId,'experiences',source.result.experience.id)).id).toBe(source.result.experience.id);
        await expect(repository.detail(pool,'prj-other','experiences',source.result.experience.id)).rejects.toMatchObject({status:404});
        await expect(repository.page(pool,'prj-other','experiences',first.nextCursor!)).rejects.toMatchObject({status:404});
    });
    it('preserves an older active candidate outside the first page and resolves its older human check',async()=>{
        const source=await verified(),first=(await candidate(source)).result.candidate;await repository.candidateAction(admin,projectId,first.id,await request(),'approve');
        for(let n=0;n<100;n++)await candidate(source,{content:'Следующая предлагаемая версия '+n});
        const page=await repository.page(pool,projectId,'candidates');expect(page.items).toHaveLength(100);expect(page.total).toBe(101);expect(page.items.some(item=>item.id===first.id)).toBe(false);
        expect((await repository.activeCandidates(pool,projectId)).map(item=>item.id)).toEqual([first.id]);expect((await context()).entries[0].id).toBe(first.id);
        for(let n=0;n<22;n++)await repository.addCheck(developer,projectId,source.hypothesis.id,{...await request(),method:'llm_assessment',result:'passed',summary:'Дополнительная непроверенная оценка '+n,experienceIds:[source.experience.id]});
        const detail=(await repository.hypotheses(pool,projectId,source.hypothesis.id))[0];expect(detail.checks).toHaveLength(20);expect(detail.checkCount).toBe(23);expect(detail.checksNextCursor).toBeTruthy();
        expect(detail.checks.some(check=>check.id===source.check.id)).toBe(false);expect((await repository.checkDetail(pool,projectId,source.hypothesis.id,source.check.id)).method).toBe('human_review');
        await repository.candidateAction(admin,projectId,first.id,await request(),'activate');expect((await context()).entries[0].id).toBe(first.id);
        const remaining=await repository.checkPage(pool,projectId,source.hypothesis.id,detail.checksNextCursor!);expect(remaining.items.some(check=>check.id===source.check.id)).toBe(true);
    });
});
