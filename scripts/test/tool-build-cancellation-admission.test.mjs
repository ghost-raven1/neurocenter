import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,access,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));

/** Instrument pool construction so an admission regression cannot reach any PostgreSQL server. */
async function run(t,url){
    const folder=await mkdtemp(path.join(os.tmpdir(),'neurocenter cancel admission '));
    t.after(()=>rm(folder,{recursive:true,force:true}));
    const marker=path.join(folder,'pool-created'),preload=path.join(folder,'preload.cjs');
    await writeFile(preload,`const {createRequire}=require('node:module');
        const requirePackage=createRequire(${JSON.stringify(path.join(root,'services/catalog-service/package.json'))});
        requirePackage('pg').Pool=class{constructor(){require('node:fs').writeFileSync(${JSON.stringify(marker)},'called');throw Error('POOL_CONSTRUCTION_INTERCEPTED');}};`);
    const result=spawnSync(process.execPath,['--require',preload,path.join(root,'scripts/test/tool-build-cancellation-db.mjs')],{
        cwd:folder,encoding:'utf8',timeout:5000,env:{PATH:path.dirname(process.execPath),HOME:folder,
            TOOL_BUILD_TEST_DIST:path.join(folder,'candidate-dist'),...(url===undefined?{}:{TOOL_BUILD_CANCEL_TEST_PG_URL:url})},
    });
    assert.equal(result.error,undefined);assert.equal(result.status,1);
    const poolConstructed=await access(marker).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
    return {...result,poolConstructed};
}

for(const url of [undefined,'not-a-url','https://127.0.0.1:55432/postgres',
    'postgres://qa:guard-secret@127.0.0.1:5432/postgres','postgres://qa@127.0.0.1/postgres',
    'postgres://qa@localhost:55432/postgres','postgres://qa@192.0.2.1:55432/postgres',
    'postgres://qa@127.0.0.1:55432/catalog','postgres://qa@127.0.0.1:55432/postgres?sslmode=disable']){
    test('Cancellation SQL admission rejects '+(url?url.replace('guard-secret','[masked]'):'a missing owned URL')+' before pool construction',async t=>{
        const value=await run(t,url);assert.equal(value.poolConstructed,false);assert.match(value.stderr,/explicitly owned/);
        assert.doesNotMatch(value.stderr,/guard-secret|POOL_CONSTRUCTION_INTERCEPTED/);
    });
}

test('The instrumented positive control proves a valid owned URL reaches the guarded constructor',async t=>{
    const value=await run(t,'postgres://qa@127.0.0.1:55432/postgres');
    assert.equal(value.poolConstructed,true);assert.match(value.stderr,/POOL_CONSTRUCTION_INTERCEPTED/);
});
