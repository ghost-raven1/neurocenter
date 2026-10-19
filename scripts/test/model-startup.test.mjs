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

const prepared={status:0,stdout:JSON.stringify({ok:true,downloadOnly:false,verifyOnly:false,models:2,files:9,bytes:4427274223})};

test('Startup готовит комплект до runtime и не останавливает соседей',async()=>fixture(async({root,output,messages})=>{
    const calls=[];
    const result=await startModelRuntime({root,output,environment:{}},(command,args,options)=>{calls.push({command,args,options});return command==='docker'?{status:0}:prepared;});
    assert.deepEqual(result,{ok:true});assert.equal(calls.length,2);
    assert.ok(calls[0].args[0].endsWith('/bundle-cli.mjs'));
    assert.equal(calls[1].command,'docker');
    assert.ok(calls[1].args.includes(configuration({},root).project));
    assert.deepEqual(calls[1].args.slice(-6),['up','-d','--wait','--wait-timeout','90','embedding']);
    assert.ok(!calls[1].args.some(arg=>['pull','down','stop'].includes(arg)));
    assert.equal(messages.at(-1).level,'success');
}));

test('Необязательный runtime не останавливает dev при сбое Docker',async()=>fixture(async({root,output,messages})=>{
    const result=await startModelRuntime({root,output,environment:{}},command=>command==='docker'?{status:1,stderr:'PRIVATE UPSTREAM'}:prepared);
    assert.deepEqual(result,{ok:false});assert.ok(messages.some(item=>item.level==='warning'));
    assert.ok(!JSON.stringify(messages).includes('PRIVATE'));assert.ok(!messages.some(item=>item.level==='success'&&item.text[0].includes('Хостинг')));
}));

test('Отключённый хостинг не вызывает Docker',async()=>fixture(async({root,output})=>{
    const result=await startModelRuntime({root,output,environment:{MODEL_HOSTING_ENABLED:'false'}},()=>{throw new Error('Не должен вызываться');});
    assert.deepEqual(result,{ok:true,disabled:true});
}));

test('Startup не принимает symlink хранилища на внешний пользовательский каталог',async()=>fixture(async({root,output})=>{
    const outside=path.join(root,'outside');await mkdir(outside);await mkdir(path.join(root,'data'));await symlink(outside,path.join(root,'data/embedding'));
    let called=false;
    await assert.rejects(startModelRuntime({root,output,environment:{}},()=>{called=true;return {status:0};}),/символьных ссылок/);
    assert.equal(called,false);
}));

test('Отказ или неполный ответ поставки не запускает пустой runtime',async()=>fixture(async({root,output})=>{
    for(const result of [{status:1},{status:0,stdout:'{}'},{status:0,stdout:JSON.stringify({ok:true,models:0,files:0,bytes:0})}]) {
        const calls=[];
        await assert.rejects(startModelRuntime({root,output,environment:{}},command=>{calls.push(command);return result;}),/модели не подготовлены/);
        assert.equal(calls.includes('docker'),false);
    }
}));
