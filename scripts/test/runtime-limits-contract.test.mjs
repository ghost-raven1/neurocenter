import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DEFAULT_RUNTIME_LIMIT_POLICY,RUNTIME_LIMIT_CEILINGS,runtimeLimitPolicy,runtimeLimitInput} from '../../services/shared/runtime-limits.cjs';
import {TEXT_KNOWLEDGE_LIMITS,TEXT_KNOWLEDGE_CEILINGS,normalizeTextUpload,normalizeTextSearch,normalizeTextContext,textUploadCanonical,textKnowledgeLimits} from '../../services/shared/project-text-knowledge.cjs';
const key='11111111-1111-4111-8111-111111111111',policy=()=>structuredClone(DEFAULT_RUNTIME_LIMIT_POLICY);

test('runtime policy is a complete bounded number contract with stable defaults',()=>{
    assert.deepEqual(runtimeLimitPolicy(policy()),DEFAULT_RUNTIME_LIMIT_POLICY);
    for(const value of [null,{}, {...policy(),token:'secret'}, {...policy(),ggufImport:{maximumBytes:1}}])assert.throws(()=>runtimeLimitPolicy(value));
    for(const number of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>runtimeLimitPolicy({...policy(),textKnowledge:{...TEXT_KNOWLEDGE_LIMITS,documents:number}}));
    const larger=policy();larger.textKnowledge={...TEXT_KNOWLEDGE_CEILINGS};assert.deepEqual(runtimeLimitPolicy(larger).textKnowledge,TEXT_KNOWLEDGE_CEILINGS);
});
test('cross-field and technical limits are enforced for text and every GGUF field',()=>{
    assert.throws(()=>textKnowledgeLimits({...TEXT_KNOWLEDGE_LIMITS,batchBytes:1}));
    assert.throws(()=>runtimeLimitPolicy({...policy(),ggufImport:{...policy().ggufImport,storageQuotaBytes:1}}));
    assert.throws(()=>runtimeLimitPolicy({...policy(),ggufImport:{...policy().ggufImport,checkIntervalMs:policy().ggufImport.uploadTimeoutMs+1}}));
    for(const [field,max]of Object.entries(RUNTIME_LIMIT_CEILINGS.ggufImport)){
        const value=policy();value.ggufImport[field]=max+1;assert.throws(()=>runtimeLimitPolicy(value),field);
    }
});
test('CAS and request key retain exact policy identity and refuse undeclared settings',()=>{
    const input={requestKey:key,expectedRevision:0,policy:policy()};assert.deepEqual(runtimeLimitInput(input),input);
    for(const value of [{...input,expectedRevision:-1},{...input,requestKey:'not-a-uuid'},{...input,reset:true}])assert.throws(()=>runtimeLimitInput(value));
});
test('lowered product limits never change canonical accepted upload bytes or forbid structural recovery',()=>{
    const input={requestKey:key,expectedRevision:0,documents:[{path:'one.md',content:'accepted bytes'}]};
    const canonical=textUploadCanonical(input),lower={...TEXT_KNOWLEDGE_LIMITS,fileBytes:2};
    assert.throws(()=>normalizeTextUpload(input,lower));
    assert.deepEqual(normalizeTextUpload(input,TEXT_KNOWLEDGE_CEILINGS),input);
    assert.equal(textUploadCanonical(input),canonical);
    assert.equal(createHash('sha256').update(canonical).digest('hex'),createHash('sha256').update(JSON.stringify(input)).digest('hex'));
});
test('maximum valid upload JSON including internal envelope fits the actual 20MiB RAG parser',()=>{
    const limits=TEXT_KNOWLEDGE_CEILINGS,paths=Array.from({length:256},(_,i)=>String(i).padStart(3,'0')+'"'.repeat(2045));
    const pathBytes=paths.reduce((sum,path)=>sum+Buffer.byteLength(path),0),perFile=Math.floor((limits.batchBytes-pathBytes)/paths.length);
    const documents=paths.map(path=>({path,content:'\t'.repeat(perFile)}));
    const input=normalizeTextUpload({requestKey:key,expectedRevision:0,documents},limits);
    const payload=JSON.stringify({projectId:'prj-wire-boundary',actor:{email:'owner@example.test',activeRole:'Главный админ'},requestHash:'a'.repeat(64),input});
    assert.ok(Buffer.byteLength(payload)>15*1024**2);assert.ok(Buffer.byteLength(payload)<20*1024**2);
    for(const control of ['\u0000','\u0001','\u000b','\u000c','\u001f','\u007f'])assert.throws(()=>normalizeTextUpload({requestKey:key,expectedRevision:0,documents:[{path:'one',content:control}]},limits));
});
test('maximum query JSON expansion fits the upgraded accepted-selector constraint',()=>{
    const query='\u0001'.repeat(TEXT_KNOWLEDGE_CEILINGS.queryBytes-1)+'x';
    const selection=normalizeTextContext({mode:'text',revision:1,corpusHash:'a'.repeat(64),query},TEXT_KNOWLEDGE_CEILINGS);
    assert.ok(Buffer.byteLength(JSON.stringify(selection))<131072);
    assert.throws(()=>normalizeTextSearch({query:query+'x'},TEXT_KNOWLEDGE_CEILINGS));
});
test('maximum escaped citations and admission metadata fit history and the 8MiB RPC response budget',()=>{
    const limits=TEXT_KNOWLEDGE_CEILINGS;
    const sources=Array.from({length:limits.sources},(_,i)=>({id:String(i).padStart(64,'0'),path:'"'.repeat(limits.pathBytes),startLine:1,endLine:1,excerpt:'\t'.repeat(limits.excerptBytes),score:1}));
    const result={mode:'text',projectId:'prj-wire-boundary',revision:1,corpusHash:'a'.repeat(64),sources,admission:{revision:1,limits}};
    assert.ok(Buffer.byteLength(JSON.stringify(result))<2*1024**2);
    assert.ok(Buffer.byteLength(JSON.stringify({...result,status:'ready',project:{id:result.projectId,name:'Text project',state:'ACTIVE',headRevision:1}}))<2*1024**2);
});
