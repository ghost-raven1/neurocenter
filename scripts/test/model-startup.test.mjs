import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {modelRuntimeEnvironment,startModelRuntime} from '../models/startup.mjs';
import {configuration} from '../embedding/config.mjs';

async function fixture(action) {
    const root=await mkdtemp(path.join(tmpdir(),'nc-model-startup-'));const messages=[];
    const output=Object.fromEntries(['info','success','warning'].map(level=>[level,(...text)=>messages.push({level,text})]));
    try {await action({root,output,messages});} finally {await rm(root,{recursive:true,force:true});}
}

test('Dev runtime использует существующий проектный контейнер, порт и каталог весов',()=>{
    const root='/tmp/Проект модели';const config=configuration({EMBEDDING_PORT:'11439'},root);
    assert.deepEqual(modelRuntimeEnvironment(root,{EMBEDDING_PORT:'11439'}),{MODEL_RUNTIME_URL:config.baseUrl,MODEL_STORAGE_PATH:config.data});
});

test('Startup запускает только runtime, не скачивает модель и не останавливает соседей',async()=>fixture(async({root,output,messages})=>{
    const calls=[];
    const result=await startModelRuntime({root,output,environment:{}},(command,args,options)=>{calls.push({command,args,options});return {status:0};});
    assert.deepEqual(result,{ok:true});assert.equal(calls.length,1);
    assert.equal(calls[0].command,'docker');
    assert.ok(calls[0].args.includes(configuration({},root).project));
    assert.deepEqual(calls[0].args.slice(-6),['up','-d','--wait','--wait-timeout','90','embedding']);
    assert.ok(!calls[0].args.some(arg=>['pull','down','stop'].includes(arg)));
    assert.equal(messages.at(-1).level,'success');
}));

test('Необязательный runtime не останавливает dev при сбое Docker',async()=>fixture(async({root,output,messages})=>{
    const result=await startModelRuntime({root,output,environment:{}},()=>({status:1,stderr:'PRIVATE UPSTREAM'}));
    assert.deepEqual(result,{ok:false});assert.ok(messages.some(item=>item.level==='warning'));
    assert.ok(!JSON.stringify(messages).includes('PRIVATE'));assert.ok(!messages.some(item=>item.level==='success'));
}));

test('Отключённый хостинг не вызывает Docker',async()=>fixture(async({root,output})=>{
    const result=await startModelRuntime({root,output,environment:{MODEL_HOSTING_ENABLED:'false'}},()=>{throw new Error('Не должен вызываться');});
    assert.deepEqual(result,{ok:true,disabled:true});
}));

test('Startup не принимает symlink хранилища на внешний пользовательский каталог',async()=>fixture(async({root,output})=>{
    const outside=path.join(root,'outside');await mkdir(outside);await mkdir(path.join(root,'data'));await symlink(outside,path.join(root,'data/embedding'));
    let called=false;
    const result=await startModelRuntime({root,output,environment:{}},()=>{called=true;return {status:0};});
    assert.deepEqual(result,{ok:false});assert.equal(called,false);
}));
