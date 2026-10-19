import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareStartupAssets} from '../assets/startup.mjs';
import {configuration} from '../embedding/config.mjs';
import {dataDirectory} from '../embedding/runtime.mjs';
import {modelRuntimeEnvironment} from '../models/startup.mjs';

test('Запуск принимает только полный подтверждённый отчёт общей поставки',async()=>{
    const input={root:'/project',output:{success() {},info() {}}};
    const report={ok:true,mode:'prefetch',verifyOnly:false,revision:'a'.repeat(64)};
    assert.deepEqual(await prepareStartupAssets(input,async()=>({status:0,stdout:JSON.stringify(report)})),report);
    for(const result of [{status:1},{status:0,stdout:'{}'},{status:0,stdout:JSON.stringify({...report,verifyOnly:true})}]) {
        await assert.rejects(prepareStartupAssets(input,async()=>result),/Прежние сервисы не остановлены/);
    }
    await assert.rejects(prepareStartupAssets(input,async()=>({error:Object.assign(new Error('cancelled'),{code:'ECANCELED'})})),{code:'ECANCELED'});
});

test('Prefetch, активация и Docker используют один пользовательский каталог внутри проекта',async t=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'neurocenter model path '));t.after(()=>rm(root,{recursive:true,force:true}));
    const config=configuration({MODEL_STORAGE_PATH:'custom/models'},root);
    assert.equal(config.data,path.join(root,'custom/models'));
    assert.equal(await dataDirectory(config,'models/blobs',true),path.join(root,'custom/models/models/blobs'));
    assert.ok((await stat(path.join(config.data,'models/blobs'))).isDirectory());
    assert.equal(modelRuntimeEnvironment(root,{MODEL_STORAGE_PATH:'custom/models'}).MODEL_STORAGE_PATH,config.data);
    assert.equal(configuration({EMBEDDING_DATA_DIR:'cache/models'},root).data,path.join(root,'cache/models'));
    assert.throws(()=>configuration({MODEL_STORAGE_PATH:'../other'},root),/внутри проекта/);
});

test('Незавершённая активация восстанавливается до предзагрузки в выбранном каталоге',async t=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'neurocenter startup recovery '));t.after(()=>rm(root,{recursive:true,force:true}));
    const directory=path.join(root,'custom/models'),managed=path.join(directory,'.bundle-managed');
    await mkdir(managed,{recursive:true});await writeFile(path.join(managed,'pending.json'),'{}');
    const calls=[],messages=[],output={success:value=>messages.push(value),info() {}};
    const report={ok:true,mode:'prefetch',verifyOnly:false,revision:'a'.repeat(64)};
    await prepareStartupAssets({root,environment:{MODEL_STORAGE_PATH:'custom/models'},output},async(command,args)=>{
        calls.push(args);return {status:0,stdout:JSON.stringify(args.includes('--recover-only')?{ok:true,recovered:true}:report)};
    });
    assert.equal(calls.length,2);assert.deepEqual(calls[0],[path.join(root,'scripts/models/bundle-cli.mjs'),'--directory',directory,'--recover-only']);
    assert.equal(calls[1][0],path.join(root,'scripts/assets/cli.mjs'));
    assert.match(messages[0],/Восстановлен/);
});

test('Отказ восстановления останавливает запуск до сети и не скрывает следующий шаг',async t=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'neurocenter startup failed recovery '));t.after(()=>rm(root,{recursive:true,force:true}));
    const managed=path.join(root,'data/embedding/.bundle-managed');await mkdir(managed,{recursive:true});await writeFile(path.join(managed,'pending.json'),'{}');
    const calls=[];
    await assert.rejects(prepareStartupAssets({root,environment:{},output:{success() {},info() {}}},async(command,args)=>{
        calls.push(args);return {status:1,stdout:JSON.stringify({ok:false,error:{code:'MODEL_MANAGED_CONFLICT'}})};
    }),/восстановить.*recover-only.*Прежние сервисы не остановлены/);
    assert.equal(calls.length,1);assert.ok(calls[0].includes('--recover-only'));
});

test('Отмена предзагрузки сохраняет исходный SIGTERM для корректного кода завершения',async()=>{
    await assert.rejects(prepareStartupAssets({root:'/project',environment:{},output:{success() {},info() {}}},async()=>({
        signal:'SIGTERM',error:Object.assign(new Error('cancelled'),{code:'ECANCELED'}),
    })),error=>error.code==='ECANCELED'&&error.signal==='SIGTERM');
});
