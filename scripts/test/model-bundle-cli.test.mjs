import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFile,mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const scripts=fileURLToPath(new URL('../models/',import.meta.url));

/** Проверяется настоящий CLI и его guard; веса и сеть заменены изолированным исполнителем. */
async function fixture(action) {
    const root=await mkdtemp(path.join(tmpdir(),'nc-model-cli-')),directory=path.join(root,'physical'),cwd=path.join(root,'working');
    await mkdir(directory);await mkdir(cwd);
    for(const file of ['bundle-cli.mjs','bundle-errors.mjs'])await copyFile(path.join(scripts,file),path.join(directory,file));
    await writeFile(path.join(directory,'bundle.mjs'),`
        export async function readModelBundle(){return {};}
        export async function hydrateModelBundle(options){
            if(process.env.MODEL_CLI_FIXTURE_FAILURE==='network')throw new TypeError('fetch failed',
                {cause:Object.assign(new Error('PRIVATE_TOKEN_AND_PATH'),{code:'ENOTFOUND'})});
            if(process.env.MODEL_CLI_FIXTURE_FAILURE)throw Object.assign(new Error('PRIVATE_TOKEN_AND_PATH'),{code:'EACCES'});
            options.onProgress({stage:'ready',message:'Модели готовы.',completed:9,total:9,unit:'files'});
            return {ok:true,downloadOnly:!!options.downloadOnly,verifyOnly:!!options.verifyOnly,models:2,files:9,bytes:1234};
        }
        export async function packModelBundle(){throw new Error('Упаковка не вызывается в этой проверке.');}
    `);
    const entry=path.join(directory,'bundle-cli.mjs');
    const run=(args=[],options={})=>spawnSync(process.execPath,[entry,...args],{cwd,env:process.env,encoding:'utf8',timeout:3000,...options});
    try {await action({root,directory,cwd,entry,run});} finally {await rm(root,{recursive:true,force:true});}
}

test('Успешный CLI оставляет в stdout один JSON, а прогресс отправляет в stderr',async()=>fixture(async({run})=>{
    const result=run();assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),{ok:true,downloadOnly:false,verifyOnly:false,models:2,files:9,bytes:1234});
    assert.equal(result.stdout.trim().split('\n').length,1);assert.match(result.stderr,/Модели готовы/);
}));

for(const [mode,code] of [['access','EACCES'],['network','MODEL_NETWORK']])test(`Отказ CLI ${mode} возвращает безопасную причину в JSON и stderr`,async()=>fixture(async({run})=>{
    const result=run([],{env:{...process.env,MODEL_CLI_FIXTURE_FAILURE:mode}});
    assert.equal(result.status,1);const report=JSON.parse(result.stdout);
    assert.equal(report.ok,false);assert.equal(report.error.code,code);
    assert.equal(typeof report.error.message,'string');assert.ok(report.error.message);
    assert.equal(result.stdout.trim().split('\n').length,1);assert.equal(result.stderr.trim(),report.error.message);
    assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE_TOKEN_AND_PATH/);
}));

test('Импорт CLI молчит и оставляет валидационную ошибку вызывающему коду',async()=>fixture(async({entry,cwd})=>{
    const result=spawnSync(process.execPath,['--input-type=module','-e',`
        const {runModelBundleCli}=await import(${JSON.stringify(pathToFileURL(entry).href)});
        let rejected=false;try{await runModelBundleCli(['--unknown']);}catch{rejected=true;}
        if(!rejected)process.exitCode=99;
    `],{cwd,encoding:'utf8',timeout:3000});
    assert.equal(result.status,0);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
}));

for(const preserve of [false,true])test(`CLI через symlink выполняется из другого cwd${preserve?' с preserve-symlinks-main':''}`,
    {skip:process.platform==='win32'},async()=>fixture(async({root,entry,cwd})=>{
        const alias=path.join(root,'alias');await symlink(path.dirname(entry),alias);
        const linkedEntry=path.join(alias,path.basename(entry));
        const result=spawnSync(process.execPath,[...(preserve?['--preserve-symlinks-main']:[]),linkedEntry,'--verify-only'],
            {cwd,env:process.env,encoding:'utf8',timeout:3000});
        assert.equal(result.status,0,result.stderr);
        assert.deepEqual(JSON.parse(result.stdout),{ok:true,downloadOnly:false,verifyOnly:true,models:2,files:9,bytes:1234});
    }));
