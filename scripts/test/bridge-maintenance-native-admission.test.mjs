import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const exec=promisify(execFile),root=fileURLToPath(new URL('../../',import.meta.url));
const keys=['BRIDGE_MAINTENANCE_CONNECTION_FILE','BRIDGE_MAINTENANCE_CANDIDATE','BRIDGE_MAINTENANCE_OUTPUT'];
/** Discovery checks use real Node registration with all PG constructors and network forbidden. */
async function registration(mask,empty=false){
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc-maintenance-admission-')),hook=path.join(directory,'no-pg.mjs'),nonce=randomUUID();
    try{
        await fs.writeFile(hook,`import {createRequire} from 'node:module';const pg=createRequire(${JSON.stringify(path.join(root,'services/catalog-service/package.json'))})('pg');for(const key of ['Pool','Client'])pg[key]=class{constructor(){throw Error('UNEXPECTED_PG_CONSTRUCTOR');}};globalThis.fetch=()=>{throw Error('UNEXPECTED_NETWORK');};`);
        const env={HOME:directory,TMPDIR:directory,PATH:path.dirname(process.execPath)+':/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'};
        const values=[path.join(root,'.run/package-publication-rollback-20261023','cluster-admission-missing-'+nonce,'connection.json'),directory,path.join(root,'.run/bridge-maintenance-20261023','admission-missing-'+nonce)];
        keys.forEach((key,index)=>{if(mask&(1<<index))env[key]=empty?'':values[index];});
        let result;try{result={status:0,...await exec(process.execPath,['--import',hook,'--test','--test-reporter=tap',path.join(root,'scripts/test/bridge-maintenance-native.test.mjs')],{env,encoding:'utf8',timeout:10000,maxBuffer:1024*1024})};}
        catch(error){if(typeof error.code!=='number')throw error;result={status:error.code,stdout:error.stdout,stderr:error.stderr};}
        assert.doesNotMatch(result.stdout+result.stderr,/UNEXPECTED_PG_CONSTRUCTOR|UNEXPECTED_NETWORK/);
        await assert.rejects(fs.stat(values[0]),{code:'ENOENT'});await assert.rejects(fs.stat(values[2]),{code:'ENOENT'});
        return result;
    }finally{await fs.rm(directory,{recursive:true,force:true});}
}

test('Default workspace discovery visibly skips the explicitly owned native integration',async()=>{
    const result=await registration(0);assert.equal(result.status,0,result.stdout+result.stderr);
    assert.match(result.stdout,/# SKIP Requires explicitly owned PostgreSQL, candidate and output/);assert.match(result.stdout,/# skipped 1/);
});
for(let mask=1;mask<7;mask++)test('Partial native configuration '+mask+' refuses before any PostgreSQL or network',async()=>{
    const result=await registration(mask);assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/Set all three BRIDGE_MAINTENANCE_/);
});
test('A fully named but invalid owned connection refuses admission before any PostgreSQL constructor',async()=>{
    const result=await registration(7);assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/ENOENT/);assert.doesNotMatch(result.stdout,/# SKIP/);
});
test('Explicitly empty native variables refuse instead of silently skipping admission',async()=>{
    for(const mask of [1,7]){const result=await registration(mask,true);assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/Set all three BRIDGE_MAINTENANCE_/);}
});
