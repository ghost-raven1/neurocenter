import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
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
