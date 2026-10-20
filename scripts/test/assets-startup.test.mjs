import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareStartupAssets} from '../assets/startup.mjs';
const output={success(){},info(){}};
const report={ok:true,mode:'prefetch',verifyOnly:false,revision:'a'.repeat(64)};

test('Запуск принимает только подтверждённый prefetch нового источника',async()=>{
    const input={root:'/project',output};
    assert.deepEqual(await prepareStartupAssets(input,async()=>({status:0,stdout:JSON.stringify(report)})),report);
    for(const result of [{status:1},{status:0,stdout:'{}'},{status:0,stdout:JSON.stringify({...report,verifyOnly:true})},{status:0,stdout:JSON.stringify({...report,mode:'metadata'})}]){
        await assert.rejects(prepareStartupAssets(input,async()=>result),/Прежние сервисы не остановлены/);
    }
});
test('Prefetch не восстанавливает и не активирует теги моделей, выбор каталога остаётся в UI',async t=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'nc startup assets '));t.after(()=>rm(root,{recursive:true,force:true}));
    const pending=path.join(root,'data/embedding/.bundle-managed/pending.json');await mkdir(path.dirname(pending),{recursive:true});await writeFile(pending,'оставить');
    const calls=[];
    await prepareStartupAssets({root,environment:{},output},async(command,args)=>{calls.push(args);return {status:0,stdout:JSON.stringify(report)};});
    assert.deepEqual(calls,[[path.join(root,'scripts/assets/cli.mjs')]]);assert.equal(await readFile(pending,'utf8'),'оставить');
});
for(const signal of ['SIGINT','SIGTERM'])test('Отмена предзагрузки сохраняет '+signal,async()=>{
    await assert.rejects(prepareStartupAssets({root:'/project',environment:{},output},async()=>({signal,error:Object.assign(new Error('cancelled'),{code:'ECANCELED'})})),
        error=>error.code==='ECANCELED'&&error.signal===signal);
});
test('Standard требует точный отчёт withoutModels и передаёт ограничение в CLI',async()=>{
    const input={root:'/project',environment:{},withoutModels:true,output},calls=[];
    assert.equal((await prepareStartupAssets(input,async(command,args)=>{calls.push(args);return {status:0,stdout:JSON.stringify({...report,withoutModels:true})};})).withoutModels,true);
    assert.deepEqual(calls,[['/project/scripts/assets/cli.mjs','--without-models']]);
    for(const flag of [false,'true',1,undefined])await assert.rejects(prepareStartupAssets(input,async()=>({status:0,stdout:JSON.stringify({...report,withoutModels:flag})})),/Прежние сервисы не остановлены/);
});
