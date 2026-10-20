import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile,realpath} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
/** Настоящий CLI в отдельном checkout, без Docker/сети/пользовательской БД. */
async function fixture(t,mode,fail=''){
    const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'nc setup source ')));t.after(()=>rm(directory,{recursive:true,force:true}));
    const scripts=path.join(directory,'scripts/production'),config=path.join(directory,'config'),calls=path.join(directory,'calls.jsonl');
    await mkdir(scripts,{recursive:true});await mkdir(path.join(directory,'scripts/workspace'));await writeFile(path.join(directory,'scripts/workspace/model-credentials.mjs'),'export const ensureModelCredentialKey=async()=>{};');await mkdir(config);await writeFile(path.join(config,'.env'),"NEUROCENTER_RELEASE='fixture'\n");await writeFile(path.join(config,'tls'),'fixture');
    await copyFile(path.join(root,'scripts/production/setup.mjs'),path.join(scripts,'setup.mjs'));
    await writeFile(path.join(scripts,'configuration.mjs'),'export const ensureMetricsToken=async()=>{};export const configureProduction=async()=>{};');
    await writeFile(path.join(scripts,'model-credentials.mjs'),`import fs from 'node:fs';export const assertProductionModelKey=async()=>{fs.appendFileSync(process.env.SETUP_CALLS,JSON.stringify('key-check')+'\\n');if(process.env.SETUP_FAIL==='model-key')throw Error('fixture failed');};`);
    await writeFile(path.join(scripts,'compose-client.mjs'),`
        import fs from 'node:fs';
        const record=value=>fs.appendFileSync(process.env.SETUP_CALLS,JSON.stringify(value)+'\\n');
        export const composeClient=()=>({run:async command=>{record(command);if(command.includes(process.env.SETUP_FAIL)&&process.env.SETUP_FAIL)throw Error('fixture failed');return '';}});
        export const composeConfiguration=async()=>({services:{'catalog-service':{image:'fixture'}},secrets:{tls_cert:{file:${JSON.stringify(path.join(config,'tls'))}},tls_key:{file:${JSON.stringify(path.join(config,'tls'))}}}});
        export const maintenanceLock=async(client,image,mode,action)=>{record('lock');try{return await action();}finally{record('unlock');}};
    `);
    const preload=path.join(directory,'no-network.mjs');await writeFile(preload,'globalThis.fetch=()=>{throw Error("Unexpected asset network")};');
    const result=spawnSync(process.execPath,['--import',preload,path.join(scripts,'setup.mjs'),mode,'--directory',config,'--project-name','fixture'],
        {encoding:'utf8',env:{...process.env,SETUP_CALLS:calls,SETUP_FAIL:fail},timeout:10000});assert.equal(result.error,undefined);
    const events=await readFile(calls,'utf8').then(text=>text.trim().split('\n').filter(Boolean).map(JSON.parse),error=>{if(error.code==='ENOENT')return [];throw error;});return {result,events};
}
test('Production up запускает пустой каталог без скрытого импорта ассетов и весов',async t=>{
    const {result,events}=await fixture(t,'up');assert.equal(result.status,0,result.stderr);
    assert.deepEqual(events,['lock',['up','-d','--wait','postgres'],['--profile','setup','run','--rm','database-init'],'key-check',['up','-d','--wait','capacity-collector'],['up','-d','--wait'],'unlock']);
});
test('Production build не готовит старые bridge-dist/runtime или source binaries',async t=>{
    const {result,events}=await fixture(t,'build');assert.equal(result.status,0,result.stderr);assert.deepEqual(events,[['build']]);
});
test('Seed создаёт только первого администратора и не добавляет карточки',async t=>{
    const {result,events}=await fixture(t,'seed');assert.equal(result.status,0,result.stderr);
    assert.deepEqual(events,['lock',['up','-d','--wait','postgres'],['--profile','setup','run','--rm','database-init'],'key-check',['--profile','setup','run','--rm','bootstrap-admin'],'unlock']);
});
for(const stage of ['postgres','database-init','model-key','capacity-collector'])test('Отказ '+stage+' не запускает приложения и освобождает обслуживание',async t=>{
    const {result,events}=await fixture(t,'up',stage);assert.equal(result.status,1);assert.match(result.stderr,/fixture failed/);
    assert.equal(events.some(value=>Array.isArray(value)&&value.join(' ')==='up -d --wait'),false);assert.equal(events.at(-1),'unlock');
});
