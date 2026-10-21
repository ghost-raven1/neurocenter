import {describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createLearningContext,normalizeLearningContext,normalizeLearningExperienceInput,normalizeLearningObservedExperienceInput,normalizeLearningHypothesisInput,
    normalizeLearningCheckInput,normalizeLearningCandidateInput,normalizeLearningAnalysisRecord} from '../../shared/project-learning.cjs';
const request=()=>({requestKey:randomUUID(),expectedRevision:0});
const evidence={kind:'test',status:'failed',summary:'Проверка воспроизводит ошибку.'};
const experience=()=>({...request(),title:'Ошибка обнаружена',summary:'Факт наблюдения',outcome:'failed',evidence:[evidence]});
const hypothesis=()=>({...request(),subject:'project',title:'Предположение',statement:'Порядок ключей может влиять на результат.',rationale:'Есть воспроизводимый пример.',verificationPlan:'Сравнить одинаковые значения с разным порядком ключей.',experienceIds:[randomUUID()]});
describe('Project learning strict shared contract',()=>{
    it('preserves failed observations without claiming verification or a successful task',()=>{expect(normalizeLearningExperienceInput(experience())).toMatchObject({outcome:'failed',context:{},evidence:[evidence]});});
    it.each([
        {outcome:'approved'},{expectedRevision:-1},{expectedRevision:Number.MAX_SAFE_INTEGER+1},{requestKey:'not-a-uuid'},
        {origin:'human'},{createdBy:'forged@user.test'},{evidence:[]},{evidence:[{...evidence,stdout:'secret output'}]},
        {evidence:[{...evidence,sha256:'bad'}]},{context:{token:'private'}},{context:{gitCommit:'main'}},
        {title:'\ud800'},{summary:'\u0000'},{summary:'я'.repeat(4097)},
    ])('rejects malformed, oversized or forged observation fields #%#',changes=>{expect(()=>normalizeLearningExperienceInput({...experience(),...changes})).toThrow();});
    it('append-only device reports never accept a caller-selected revision',()=>{
        const {expectedRevision:_revision,...input}=experience();expect(normalizeLearningObservedExperienceInput(input)).not.toHaveProperty('expectedRevision');
        expect(()=>normalizeLearningObservedExperienceInput({...input,expectedRevision:0})).toThrow();
    });
    it('requires explicit testable hypotheses backed by distinct source IDs',()=>{
        expect(normalizeLearningHypothesisInput(hypothesis()).subject).toBe('project');
        expect(()=>normalizeLearningHypothesisInput({...hypothesis(),experienceIds:[]})).toThrow();
        const id=randomUUID();expect(()=>normalizeLearningHypothesisInput({...hypothesis(),experienceIds:[id,id]})).toThrow();
        expect(()=>normalizeLearningHypothesisInput({...hypothesis(),confidence:0.99})).toThrow();
    });
    it('marks LLM assessments explicitly and rejects unsupported result states',()=>{
        const input={...request(),method:'llm_assessment',result:'passed',summary:'Предварительная оценка.',experienceIds:[randomUUID()]};
        expect(normalizeLearningCheckInput(input).method).toBe('llm_assessment');expect(()=>normalizeLearningCheckInput({...input,result:'knowledge'})).toThrow();
    });
    it('candidate payload is immutable text with explicit provenance, never an executable patch',()=>{
        const input={...request(),hypothesisId:randomUUID(),checkId:randomUUID(),key:'stable-key',kind:'instruction',title:'Инструкция',content:'Сравнивай значения канонически.'};
        expect(normalizeLearningCandidateInput(input).key).toBe('stable-key');expect(()=>normalizeLearningCandidateInput({...input,key:'../escape'})).toThrow();
        expect(()=>normalizeLearningCandidateInput({...input,patch:{prompt:'overwrite global'}})).toThrow();
    });
    it('model provenance is pinned and generated suggestions cannot include confidence or approval',()=>{
        const {requestKey:_key,expectedRevision:_revision,...draft}=hypothesis(),input={...request(),hypotheses:[draft],model:{modelId:'model-qa',modelPin:'a'.repeat(64),analysisId:randomUUID(),sourceRevision:0}};
        expect(normalizeLearningAnalysisRecord(input).model.modelPin).toBe('a'.repeat(64));
        expect(()=>normalizeLearningAnalysisRecord({...input,model:{modelId:'model-qa'}})).toThrow();
        expect(()=>normalizeLearningAnalysisRecord({...input,hypotheses:[{...draft,status:'supported'}]})).toThrow();
        expect(()=>normalizeLearningAnalysisRecord({...input,hypotheses:Array(6).fill(draft)})).toThrow();
    });
    it('verifies complete context bytes and rejects tampering, duplicate keys and incomplete snapshots',()=>{
        const entry={id:randomUUID(),key:'canonical-values',version:1,kind:'lesson' as const,title:'Вывод',content:'Порядок ключей не меняет значения.',targetAgentId:null,hypothesisId:randomUUID(),checkId:randomUUID(),approvedAt:new Date().toISOString()};
        const context=createLearningContext({projectId:'prj-learning',revision:4,entries:[entry]});expect(normalizeLearningContext(context)).toEqual(context);
        expect(()=>normalizeLearningContext({...context,entries:[{...entry,content:'Подмена'}]})).toThrow();
        expect(()=>createLearningContext({projectId:'prj-learning',revision:4,entries:[entry,entry]})).toThrow();
        expect(()=>createLearningContext({projectId:'prj-learning',revision:4,entries:Array.from({length:33},(_,n)=>({...entry,id:randomUUID(),key:'entry-'+n}))})).toThrow();
        expect(()=>createLearningContext({projectId:'prj-learning',revision:4,entries:Array.from({length:8},(_,n)=>({...entry,id:randomUUID(),key:'entry-'+n,content:'x'.repeat(16384)}))})).toThrow();
    });
});
