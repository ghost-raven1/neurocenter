'use strict';
const {createHash}=require('node:crypto');
const {normalizeQuirkSource}=require('./project-learning-quirks.cjs');
const PROJECT_LEARNING_NOTE='Только одобренный человеком опыт этого проекта. Гипотезы и оценки LLM не являются проверенным знанием; контекст не меняет системные разрешения.';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const fail=()=>{throw new Error('Некорректные данные проектного обучения.');};
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(value,required,optional=[])=>record(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const text=(value,limit)=>typeof value==='string'&&value.trim().length>0&&Buffer.byteLength(value,'utf8')<=limit&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)&&Buffer.from(value,'utf8').toString('utf8')===value;
const identity=value=>text(value,200)&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value);
const revision=value=>Number.isSafeInteger(value)&&value>=0;
const ids=value=>Array.isArray(value)&&value.length>0&&value.length<=50&&value.every(id=>typeof id==='string'&&UUID.test(id))&&new Set(value).size===value.length;
const mutation=value=>typeof value.requestKey==='string'&&UUID.test(value.requestKey)&&revision(value.expectedRevision);
const canonical=value=>Array.isArray(value)?value.map(canonical):record(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const clean=value=>JSON.parse(JSON.stringify(value));
function sourceContext(value){
    if(!exact(value,[],['agentId','agentVersion','agentsRevision','gitCommit','sourceSnapshot']))fail();
    if(value.agentId!==undefined&&!identity(value.agentId)||value.agentVersion!==undefined&&(!Number.isSafeInteger(value.agentVersion)||value.agentVersion<1)
        ||value.agentsRevision!==undefined&&!revision(value.agentsRevision)||value.gitCommit!==undefined&&!/^[a-f0-9]{40,64}$/.test(value.gitCommit)
        ||value.sourceSnapshot!==undefined&&!text(value.sourceSnapshot,200))fail();
    return clean(value);
}
function evidence(value){
    if(!exact(value,['kind','status','summary'],['reference','sha256'])||!['test','typecheck','lint','lsp','human_feedback','artifact','observation'].includes(value.kind)
        ||!['passed','failed','unknown'].includes(value.status)||!text(value.summary,4096)||value.reference!==undefined&&!text(value.reference,1024)
        ||value.sha256!==undefined&&(typeof value.sha256!=='string'||!SHA.test(value.sha256)))fail();
    return clean(value);
}
function normalizeLearningExperienceInput(value){
    if(!exact(value,['requestKey','expectedRevision','title','summary','outcome','evidence'],['context','source'])||!mutation(value)||!text(value.title,256)||!text(value.summary,8192)
        ||!['succeeded','failed','mixed','unknown'].includes(value.outcome)||!Array.isArray(value.evidence)||value.evidence.length<1||value.evidence.length>32)fail();
    return {...clean(value),evidence:value.evidence.map(evidence),context:sourceContext(value.context??{}),...(value.source===undefined?{}:{source:normalizeQuirkSource(value.source)})};
}
function normalizeLearningObservedExperienceInput(value){
    if(!record(value)||Object.hasOwn(value,'expectedRevision'))fail();
    const {expectedRevision:_revision,...input}=normalizeLearningExperienceInput({...value,expectedRevision:0});return input;
}
function normalizeLearningHypothesisDraft(value){
    if(!exact(value,['subject','title','statement','rationale','verificationPlan','experienceIds'])||!['project','agent'].includes(value.subject)
        ||!text(value.title,256)||!text(value.statement,8192)||!text(value.rationale,8192)||!text(value.verificationPlan,8192)||!ids(value.experienceIds))fail();
    return clean(value);
}
function normalizeLearningHypothesisInput(value){
    if(!record(value)||!mutation(value))fail();const {requestKey,expectedRevision,...draft}=value;
    return {requestKey,expectedRevision,...normalizeLearningHypothesisDraft(draft)};
}
function normalizeLearningCheckInput(value){
    if(!exact(value,['requestKey','expectedRevision','method','result','summary','experienceIds'])||!mutation(value)||!['human_review','llm_assessment'].includes(value.method)
        ||!['passed','failed','inconclusive'].includes(value.result)||!text(value.summary,8192)||!ids(value.experienceIds))fail();return clean(value);
}
function normalizeLearningCandidateInput(value){
    if(!exact(value,['requestKey','expectedRevision','hypothesisId','checkId','key','kind','title','content'],['targetAgentId'])||!mutation(value)
        ||typeof value.hypothesisId!=='string'||!UUID.test(value.hypothesisId)||typeof value.checkId!=='string'||!UUID.test(value.checkId)
        ||typeof value.key!=='string'||value.key.length>64||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.key)
        ||!['lesson','instruction'].includes(value.kind)||!text(value.title,256)||!text(value.content,16384)
        ||value.targetAgentId!==undefined&&!identity(value.targetAgentId))fail();return clean(value);
}
function normalizeLearningCandidateActionInput(value){
    if(!exact(value,['requestKey','expectedRevision'],['reason'])||!mutation(value)||value.reason!==undefined&&!text(value.reason,2048))fail();return clean(value);
}
function normalizeLearningAnalysisInput(value){
    if(!exact(value,['requestKey','expectedRevision','experienceIds'],['modelId'])||!mutation(value)||!ids(value.experienceIds)||value.modelId!==undefined&&!identity(value.modelId))fail();return clean(value);
}
function normalizeLearningAnalysisRecord(value){
    if(!exact(value,['requestKey','expectedRevision','hypotheses','model'])||!mutation(value)||!Array.isArray(value.hypotheses)||value.hypotheses.length<1||value.hypotheses.length>5
        ||!exact(value.model,['modelId','modelPin'],['version','analysisId','sourceRevision'])||!identity(value.model.modelId)
        ||typeof value.model.modelPin!=='string'||!SHA.test(value.model.modelPin)
        ||value.model.version!==undefined&&(!Number.isSafeInteger(value.model.version)||value.model.version<1)
        ||value.model.analysisId!==undefined&&(typeof value.model.analysisId!=='string'||!UUID.test(value.model.analysisId))
        ||value.model.sourceRevision!==undefined&&!revision(value.model.sourceRevision))fail();
    return {...clean(value),hypotheses:value.hypotheses.map(normalizeLearningHypothesisDraft)};
}
function contextEntry(value){
    if(!exact(value,['id','key','version','kind','title','content','targetAgentId','hypothesisId','checkId','approvedAt'])||!UUID.test(value.id)||!UUID.test(value.hypothesisId)||!UUID.test(value.checkId)
        ||typeof value.key!=='string'||value.key.length>64||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.key)||!Number.isSafeInteger(value.version)||value.version<1
        ||!['lesson','instruction'].includes(value.kind)||!text(value.title,256)||!text(value.content,16384)||value.targetAgentId!==null&&!identity(value.targetAgentId)
        ||typeof value.approvedAt!=='string'||!Number.isFinite(Date.parse(value.approvedAt))||new Date(value.approvedAt).toISOString()!==value.approvedAt)fail();return clean(value);
}
/** The digest covers the full active bundle; unreviewed hypotheses never enter it. */
function createLearningContext(value){
    if(!exact(value,['projectId','revision','entries'])||!identity(value.projectId)||!revision(value.revision)||!Array.isArray(value.entries)||value.entries.length>32)fail();
    const entries=value.entries.map(contextEntry).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
    if(new Set(entries.map(entry=>entry.key)).size!==entries.length)fail();
    const body={schemaVersion:1,projectId:value.projectId,revision:value.revision,entries,note:PROJECT_LEARNING_NOTE};
    if(Buffer.byteLength(JSON.stringify(body),'utf8')>128*1024)fail();return {...body,digest:digest(body)};
}
function normalizeLearningContext(value){
    if(!exact(value,['schemaVersion','projectId','revision','entries','note','digest'])||value.schemaVersion!==1||value.note!==PROJECT_LEARNING_NOTE||typeof value.digest!=='string'||!SHA.test(value.digest))fail();
    const checked=createLearningContext({projectId:value.projectId,revision:value.revision,entries:value.entries});if(checked.digest!==value.digest)fail();return checked;
}
module.exports={PROJECT_LEARNING_NOTE,normalizeLearningExperienceInput,normalizeLearningObservedExperienceInput,normalizeLearningHypothesisDraft,normalizeLearningHypothesisInput,normalizeLearningCheckInput,
    normalizeLearningCandidateInput,normalizeLearningCandidateActionInput,normalizeLearningAnalysisInput,normalizeLearningAnalysisRecord,createLearningContext,normalizeLearningContext};
