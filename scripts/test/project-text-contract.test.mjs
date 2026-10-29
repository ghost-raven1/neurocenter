import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {TEXT_KNOWLEDGE_LIMITS,normalizeTextUpload,normalizeTextSearch,normalizeTextContext,textUploadCanonical,textBytes}=require('../../services/shared/project-text-knowledge.cjs');
const {defaultFeatureFlags,evaluateFeatureFlags}=require('../../services/shared/feature-flags.cjs');
const upload={requestKey:'11111111-1111-4111-8111-111111111111',expectedRevision:0,documents:[{path:'документы/Пример.ts',content:'const привет = "мир";\n'}]};

test('plain text canonical bytes preserve paths, whitespace, order and explicit revision',()=>{
    assert.deepEqual(normalizeTextUpload(upload),upload);
    assert.equal(textBytes(upload.documents[0].content),Buffer.byteLength(upload.documents[0].content));
    const changed=structuredClone(upload);changed.documents[0].content+=' ';
    assert.notEqual(textUploadCanonical(upload),textUploadCanonical(changed));
    assert.notEqual(textUploadCanonical(upload),textUploadCanonical({...upload,expectedRevision:1}));
});
test('unknown request fields, duplicate paths, unsafe names and invalid Unicode are rejected',()=>{
    for(const value of [{...upload,embedding:[]},{...upload,requestKey:'bad'},{...upload,expectedRevision:-1},
        {...upload,documents:[...upload.documents,...upload.documents]},
        ...['../secret','/secret','a/../b','a\\b','a\0b','a//b'].map(path=>({...upload,documents:[{path,content:'source'}]})),
        {...upload,documents:[{path:'source.txt',content:'PRIVATE\0SECRET'}]},
        {...upload,documents:[{path:'source.txt',content:'\ud800'}]}])assert.throws(()=>normalizeTextUpload(value));
});
test('UTF-8 file and batch limits reject the whole upload rather than truncating text',()=>{
    assert.equal(TEXT_KNOWLEDGE_LIMITS.documents,16);
    assert.throws(()=>normalizeTextUpload({...upload,documents:[{path:'a',content:'я'.repeat(65537)}]}));
    assert.throws(()=>normalizeTextUpload({...upload,documents:Array.from({length:5},(_,i)=>({path:String(i),content:'a'.repeat(128*1024)}))}));
});
test('text context pins mode, corpus revision and hash and never accepts an embedding/model selector',()=>{
    const context={mode:'text',revision:3,corpusHash:'a'.repeat(64),query:'порядок установки'};
    assert.deepEqual(normalizeTextContext(context),context);
    assert.throws(()=>normalizeTextContext({...context,modelId:'automatic'}));
    assert.throws(()=>normalizeTextContext({...context,mode:'semantic'}));
    assert.throws(()=>normalizeTextSearch({query:' ',revision:0}));
    assert.throws(()=>normalizeTextSearch({query:'я'.repeat(1025)}));
    assert.deepEqual(normalizeTextSearch({query:'код',revision:0}),{query:'код',revision:0});
});
test('basic text knowledge remains enabled with all model hosting disabled and has its own OFF switch',()=>{
    const flags=defaultFeatureFlags();flags.model_hosting=false;
    assert.equal(evaluateFeatureFlags(flags).flags.project_text_knowledge,true);
    assert.equal(evaluateFeatureFlags(flags).flags.project_search,false);
    flags.project_text_knowledge=false;assert.equal(evaluateFeatureFlags(flags).flags.project_text_knowledge,false);
});
