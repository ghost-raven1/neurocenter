import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,symlink,readFile,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {modelRuntimeEnvironment,startModelRuntime} from '../models/startup.mjs';
import {configuration} from '../models/runtime-config.mjs';
async function fixture(action){
    const root=await mkdtemp(path.join(tmpdir(),'nc model runtime ')),messages=[];
    const output=Object.fromEntries(['info','success','warning'].map(level=>[level,(...text)=>messages.push({level,text})]));
    try{await action({root,output,messages});}finally{await rm(root,{recursive:true,force:true});}
}
test('Dev runtime использует проектный контейнер, порт и единое хранилище',()=>{
    const root='/tmp/Проект модели',config=configuration({EMBEDDING_PORT:'11439'},root);
    assert.deepEqual(modelRuntimeEnvironment(root,{EMBEDDING_PORT:'11439'}),{MODEL_RUNTIME_URL:config.baseUrl,MODEL_STORAGE_PATH:config.data,MODEL_CHAT_CONTEXT_WINDOW_TOKENS:'4096'});
});
test('Managed chat context is explicit, while an unrelated external runtime remains unknown',()=>{
    const root='/tmp/project';
    assert.equal(modelRuntimeEnvironment(root,{MODEL_CHAT_CONTEXT_WINDOW_TOKENS:'8192'}).MODEL_CHAT_CONTEXT_WINDOW_TOKENS,'8192');
    assert.equal(modelRuntimeEnvironment(root,{MODEL_RUNTIME_URL:'https://ollama.example.test'}).MODEL_CHAT_CONTEXT_WINDOW_TOKENS,undefined);
    for(const value of ['NaN','127','2097153','4096.5'])assert.throws(()=>modelRuntimeEnvironment(root,{MODEL_CHAT_CONTEXT_WINDOW_TOKENS:value}),/MODEL_CHAT_CONTEXT_WINDOW_TOKENS/);
});
test('Startup запускает только Docker runtime, не скачивает и не активирует модели',async()=>fixture(async({root,output,messages})=>{
    const calls=[];
    assert.deepEqual(await startModelRuntime({root,output,environment:{}},async(command,args,options)=>{calls.push({command,args,options});options.onTick(12000);return {status:0};}),{ok:true});
    assert.equal(calls.length,1);assert.equal(calls[0].command,'docker');assert.ok(calls[0].args.includes(configuration({},root).project));
    assert.deepEqual(calls[0].args.slice(-6),['up','-d','--wait','--wait-timeout','90','embedding']);
    assert.equal(calls[0].args.some(arg=>['pull','down','stop'].includes(arg)),false);
    assert.ok(messages.some(item=>item.text[0]==='Docker: запуск хостинга'&&item.text[1].includes('12 с')));
}));
test('Ошибка Docker видна, детали пишутся в закрытый лог, соседние сервисы могут стартовать',async()=>fixture(async({root,output,messages})=>{
    assert.deepEqual(await startModelRuntime({root,output,environment:{}},async()=>({status:1,stderr:'PRIVATE UPSTREAM'})),{ok:false});
    assert.ok(messages.some(item=>item.level==='warning'));assert.equal(JSON.stringify(messages).includes('PRIVATE'),false);
    const file=messages.find(item=>item.text[0]==='Подробности Docker').text[1];assert.match(await readFile(file,'utf8'),/PRIVATE UPSTREAM/);
    if(process.platform!=='win32')assert.equal((await stat(file)).mode&0o777,0o600);
}));
test('Deadline не выдаёт неподтверждённый runtime за готовый',async()=>fixture(async({root,output,messages})=>{
    assert.deepEqual(await startModelRuntime({root,output,environment:{}},async()=>({status:null,error:Object.assign(new Error('PRIVATE timeout'),{code:'ETIMEDOUT'})})),{ok:false});
    assert.ok(messages.some(item=>item.text[0]==='Причина'&&item.text[1].includes('10 минут')));assert.equal(messages.some(item=>item.level==='success'),false);
}));
for(const signal of ['SIGINT','SIGTERM'])test('Отмена Docker сохраняет '+signal,async()=>fixture(async({root,output,messages})=>{
    await assert.rejects(startModelRuntime({root,output,environment:{}},async()=>({status:null,signal,error:Object.assign(new Error('cancelled'),{code:'ECANCELED'})})),error=>error.code==='ECANCELED'&&error.signal===signal);
    assert.equal(messages.some(item=>item.level==='warning'),false);
}));
test('Symlink диагностики не раскрывает приватный ответ',async()=>fixture(async({root,output,messages})=>{
    const outside=path.join(root,'outside');await mkdir(outside);await mkdir(path.join(root,'.run'));await symlink(outside,path.join(root,'.run/model-hosting'));
    assert.deepEqual(await startModelRuntime({root,output,environment:{}},async()=>({status:1,stderr:'PRIVATE'})),{ok:false});
    assert.deepEqual(await readdir(outside),[]);assert.equal(JSON.stringify(messages).includes('PRIVATE'),false);
}));
test('Отключённый хостинг не вызывает Docker',async()=>fixture(async({root,output})=>{
    assert.deepEqual(await startModelRuntime({root,output,environment:{MODEL_HOSTING_ENABLED:'false'}},()=>assert.fail('Docker forbidden')),{ok:true,disabled:true});
}));
test('Symlink хранилища не монтируется в Docker',async()=>fixture(async({root,output})=>{
    const outside=path.join(root,'outside');await mkdir(outside);await mkdir(path.join(root,'data'));await symlink(outside,path.join(root,'data/embedding'));
    await assert.rejects(startModelRuntime({root,output,environment:{}},()=>assert.fail('Docker forbidden')),/символьных ссылок/);
}));
