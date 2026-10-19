import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,symlink,readFile,stat,readdir} from 'node:fs/promises';
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
    const diagnostic=messages.find(item=>item.text[0]==='Подробности Docker')?.text[1];
    assert.equal(path.dirname(diagnostic),path.join(root,'.run/model-hosting'));
    assert.match(await readFile(diagnostic,'utf8'),/PRIVATE UPSTREAM/);
    if(process.platform!=='win32')assert.equal((await stat(diagnostic)).mode&0o777,0o600);
}));

test('Асинхронная подготовка обновляет стадию и запускает Docker только после проверки весов',async()=>fixture(async({root,output,messages})=>{
    let finishPreparation;const calls=[];
    const result=startModelRuntime({root,output,environment:{}},async(command,args,options)=>{
        calls.push(command);options.onTick(12000);
        if(command!=='docker')return await new Promise(resolve=>{finishPreparation=resolve;});
        return {status:0};
    });
    while(!finishPreparation)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls.length,1);
    assert.ok(messages.some(item=>item.text[0]==='Подготовка весов'&&item.text[1].includes('12 с')));
    finishPreparation(prepared);assert.deepEqual(await result,{ok:true});
    assert.deepEqual(calls,[process.execPath,'docker']);
    assert.ok(messages.some(item=>item.text[0]==='Docker: запуск хостинга'&&item.text[1].includes('12 с')));
}));

test('Deadline Docker объясняется без ложного сообщения о готовности',async()=>fixture(async({root,output,messages})=>{
    const result=await startModelRuntime({root,output,environment:{}},command=>command==='docker'
        ? {status:null,error:Object.assign(new Error('PRIVATE timeout'),{code:'ETIMEDOUT'})}:prepared);
    assert.deepEqual(result,{ok:false});
    assert.ok(messages.some(item=>item.text[0]==='Причина'&&item.text[1].includes('10 минут')));
    assert.ok(!JSON.stringify(messages).includes('PRIVATE'));
    assert.ok(!messages.some(item=>item.text[0]==='Хостинг моделей готов; встроенные веса уже доступны'));
}));

for(const stage of ['weights','docker'])test(`Отмена на стадии ${stage} прерывает весь запуск`,async()=>fixture(async({root,output,messages})=>{
    const calls=[];
    await assert.rejects(startModelRuntime({root,output,environment:{}},command=>{
        calls.push(command);
        return stage==='docker'&&command!=='docker'?prepared:
            {status:null,signal:'SIGTERM',error:Object.assign(new Error('cancelled'),{code:'ECANCELED'})};
    }),error=>error.code==='ECANCELED'&&error.signal==='SIGTERM');
    assert.equal(calls.length,stage==='weights'?1:2);
    assert.ok(!messages.some(item=>item.level==='warning'));
}));

test('Диагностика не пишет через символическую ссылку и не мешает остальному запуску',async()=>fixture(async({root,output,messages})=>{
    const outside=path.join(root,'outside');await mkdir(outside);await mkdir(path.join(root,'.run'));
    await symlink(outside,path.join(root,'.run/model-hosting'));
    assert.deepEqual(await startModelRuntime({root,output,environment:{}},command=>command==='docker'
        ? {status:1,stderr:'PRIVATE UPSTREAM'}:prepared),{ok:false});
    assert.deepEqual(await readdir(outside),[]);
    assert.ok(!JSON.stringify(messages).includes('PRIVATE'));
    assert.ok(!messages.some(item=>item.text[0]==='Подробности Docker'));
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

test('Причина отказа весов проходит из CLI в итоговую ошибку с закрытой диагностикой',async()=>fixture(async({root,output,messages})=>{
    const result={status:1,stdout:JSON.stringify({ok:false,error:{code:'EACCES',message:'PRIVATE arbitrary child message'}})};
    await assert.rejects(startModelRuntime({root,output,environment:{}},()=>result),error=>{
        assert.match(error.message,/Нет прав.*data\/embedding/);
        assert.doesNotMatch(error.message,/PRIVATE|свободное место/);return true;
    });
    assert.doesNotMatch(JSON.stringify(messages),/PRIVATE/);
    assert.ok(messages.some(item=>item.text[0]==='Код подготовки моделей'&&item.text[1]==='1'));
    const diagnostic=messages.find(item=>item.text[0]==='Подробности подготовки')?.text[1];
    assert.match(await readFile(diagnostic,'utf8'),/PRIVATE arbitrary child message/);
    if(process.platform!=='win32')assert.equal((await stat(diagnostic)).mode&0o777,0o600);
}));

test('Реальная нехватка места показывает числовое требование вместо общего отказа',async()=>fixture(async({root,output})=>{
    await assert.rejects(startModelRuntime({root,output,environment:{}},()=>({status:1,
        stdout:JSON.stringify({ok:false,error:{code:'ENOSPC',requiredBytes:4*1024**3,availableBytes:2*1024**3}})})),
    /требуется свободно 4.00 ГиБ, доступно 2.00 ГиБ/);
}));

test('Пустой ответ при коде 0 отличим от ошибки диска',async()=>fixture(async({root,output})=>{
    await assert.rejects(startModelRuntime({root,output,environment:{}},()=>({status:0,stdout:''})),/без полного отчёта/);
}));
