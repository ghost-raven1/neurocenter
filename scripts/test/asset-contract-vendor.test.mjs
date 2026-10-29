import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const vendor=path.join(root,'vendor/asset-contract');
const sourceCommit='e1255b4e522a0b38e471d5624cc63f5f13442649';
const legacyUrl='https://codeload.github.com/ghost-raven1/neurocenter-assets/tar.gz/'+sourceCommit;
const npmCli=process.env.NPM_CLI_JS||path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));

/** Network attempts fail before opening a socket and are recorded without credentials. */
const networkGuard=`const fs=require('node:fs');
const deny=(kind,value)=>{let host='unknown';try{host=typeof value==='string'?new URL(value).hostname:value?.hostname||value?.host||'unknown';}catch{}
 fs.appendFileSync(process.env.NC_CONTRACT_NETWORK_LOG,JSON.stringify({kind,host})+'\\n');throw Object.assign(Error('Asset host unavailable in cold fixture'),{code:'EASSETBLOCKED'});};
for(const name of ['node:http','node:https']){const client=require(name);for(const method of ['request','get'])client[method]=(...args)=>deny(name+':'+method,args[0]);}
globalThis.fetch=(value)=>deny('fetch',value);require('node:module').syncBuiltinESMExports();`;

/** Every install gets a new checkout, HOME and cache; no workspace dependency links are copied. */
async function coldCheckout(t,{legacy=false}={}){
    const directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'nc-contract-cold-'));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const checkout=path.join(directory,'checkout'),home=path.join(directory,'home'),cache=path.join(directory,'npm-cache');
    for(const folder of [checkout,home,cache,path.join(directory,'tmp')])await fs.mkdir(folder);
    for(const name of ['package.json','package-lock.json'])await fs.copyFile(path.join(root,name),path.join(checkout,name));
    try{await fs.cp(vendor,path.join(checkout,'vendor/asset-contract'),{recursive:true,errorOnExist:true,force:false,dereference:false});}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(legacy){
        const pkg=await json(path.join(checkout,'package.json'));
        pkg.dependencies={'@neurocenter/asset-contract':legacyUrl};
        const lock={name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages:{
            '':{name:pkg.name,version:pkg.version,dependencies:pkg.dependencies},
            'node_modules/@neurocenter/asset-contract':{version:'1.2.1',resolved:legacyUrl},
        }};
        await fs.writeFile(path.join(checkout,'package.json'),JSON.stringify(pkg));
        await fs.writeFile(path.join(checkout,'package-lock.json'),JSON.stringify(lock));
    }
    const guard=path.join(directory,'deny-network.cjs'),attempts=path.join(directory,'network.jsonl');
    const userconfig=path.join(home,'npmrc'),globalconfig=path.join(home,'global-npmrc');
    await fs.writeFile(guard,networkGuard);await fs.writeFile(attempts,'');
    await fs.writeFile(userconfig,'');await fs.writeFile(globalconfig,'');
    const env={PATH:path.dirname(process.execPath)+path.delimiter+'/usr/bin:/bin',HOME:home,USERPROFILE:home,
        TMPDIR:path.join(directory,'tmp'),LANG:'C',LC_ALL:'C',NPM_CONFIG_CACHE:cache,
        NPM_CONFIG_USERCONFIG:userconfig,NPM_CONFIG_GLOBALCONFIG:globalconfig,NPM_CONFIG_UPDATE_NOTIFIER:'false',
        NC_CONTRACT_NETWORK_LOG:attempts,NODE_OPTIONS:'--require '+JSON.stringify(guard)};
    const run=(args,command=npmCli)=>spawnSync(process.execPath,command===null?args:[command,...args],{cwd:checkout,env,encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
    return {checkout,run,attempts:async()=>(await fs.readFile(attempts,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))};
}

test('Vendored contract retains exact reviewed upstream bytes and no runtime dependencies',async()=>{
    const source=await json(path.join(vendor,'SOURCE.json')),pkg=await json(path.join(vendor,'package.json'));
    assert.equal(source.commit,sourceCommit);assert.equal(source.files.length,14);
    assert.equal(source.repository,'https://github.com/ghost-raven1/neurocenter-assets');
    assert.equal(pkg.name,'@neurocenter/asset-contract');assert.equal(pkg.version,'1.2.1');assert.equal(pkg.license,'UNLICENSED');
    for(const kind of ['dependencies','optionalDependencies','peerDependencies'])assert.equal(Object.keys(pkg[kind]||{}).length,0);
    for(const hook of ['preinstall','install','postinstall','prepare'])assert.equal(pkg.scripts?.[hook],undefined);
    let bytes=0;
    for(const record of source.files){
        const contents=await fs.readFile(path.join(vendor,record.path));bytes+=contents.length;
        assert.equal(contents.length,record.bytes);assert.equal(digest(contents),record.sha256);
        assert.equal(createHash('sha1').update('blob '+contents.length).update(Buffer.from([0])).update(contents).digest('hex'),record.gitBlobSha1);
    }
    assert.equal(bytes,61664);
    const sums=(await fs.readFile(path.join(vendor,'SHA256SUMS'),'utf8')).trim().split('\n');
    assert.equal(sums.length,16);
    for(const line of sums){const [sha,name]=line.split('  ');assert.equal(digest(await fs.readFile(path.join(vendor,name))),sha);}
    assert.deepEqual(pkg.exports['.'],{types:'./index.d.ts',import:'./lib/index.mjs',require:'./lib/index.mjs',default:'./lib/index.mjs'});
});

test('Cold root npm ci works offline with an empty HOME/cache; ESM and CJS resolve only the fresh vendor', {timeout:60000},async t=>{
    const f=await coldCheckout(t);
    await assert.rejects(fs.lstat(path.join(f.checkout,'node_modules')),{code:'ENOENT'});
    const installed=f.run(['ci','--offline','--ignore-scripts','--no-audit','--no-fund']);
    assert.equal(installed.error,undefined);assert.equal(installed.status,0,installed.stderr);
    const expected=path.join(f.checkout,'vendor/asset-contract/lib/index.mjs');
    const esm=f.run(['--input-type=module','-e',`import * as c from '@neurocenter/asset-contract';console.log(JSON.stringify({resolved:import.meta.resolve('@neurocenter/asset-contract'),names:Object.keys(c).sort(),digest:c.assetDigest('cold probe'),assets:c.validateIndex({schemaVersion:1,assets:[]}).assets.length}));`],null);
    assert.equal(esm.status,0,esm.stderr);
    const cjs=f.run(['-e',`const c=require('@neurocenter/asset-contract');console.log(JSON.stringify({resolved:require.resolve('@neurocenter/asset-contract'),names:Object.keys(c).sort(),digest:c.assetDigest('cold probe'),assets:c.validateIndex({schemaVersion:1,assets:[]}).assets.length}));`],null);
    assert.equal(cjs.status,0,cjs.stderr);
    const left=JSON.parse(esm.stdout),right=JSON.parse(cjs.stdout);
    assert.equal(left.resolved,pathToFileURL(expected).href);assert.equal(right.resolved,expected);
    assert.deepEqual(left.names,right.names);assert.ok(left.names.includes('assertIndexEvolution'));assert.ok(left.names.includes('toBridgeRelease'));
    assert.equal(left.digest,digest('cold probe'));assert.equal(right.digest,left.digest);assert.equal(left.assets,0);assert.equal(right.assets,0);
    const pruned=f.run(['prune','--omit=dev','--offline','--ignore-scripts','--no-audit','--no-fund']);
    assert.equal(pruned.status,0,pruned.stderr);
    const after=f.run(['-e',"require('@neurocenter/asset-contract').validateIndex({schemaVersion:1,assets:[]})"],null);
    assert.equal(after.status,0,after.stderr);assert.deepEqual(await f.attempts(),[]);
});

test('The previous remote contract dependency fails when its asset host is unavailable', {timeout:30000},async t=>{
    const f=await coldCheckout(t,{legacy:true});
    const result=f.run(['ci','--ignore-scripts','--no-audit','--no-fund','--fetch-retries=0','--fetch-timeout=1000']);
    assert.equal(result.error,undefined);assert.notEqual(result.status,0);
    const attempts=await f.attempts();assert.ok(attempts.length>0);
    assert.ok(attempts.every(attempt=>attempt.host==='codeload.github.com'));
    assert.match(result.stderr,/EASSETBLOCKED|Asset host unavailable/);
});

test('All consumer locks and Docker paths retain the local contract independently of asset storage',async()=>{
    for(const directory of ['', 'services/catalog-service','services/api-gateway']){
        const consumer=path.join(root,directory),pkg=await json(path.join(consumer,'package.json')),lock=await json(path.join(consumer,'package-lock.json'));
        const kind=directory==='services/api-gateway'?'devDependencies':'dependencies',reference=pkg[kind]['@neurocenter/asset-contract'];
        assert.match(reference,/^file:/);assert.equal(path.resolve(consumer,reference.slice(5)),vendor);
        assert.equal(lock.packages[''][kind]['@neurocenter/asset-contract'],reference);
        assert.equal(lock.packages['node_modules/@neurocenter/asset-contract'].link,true);
        assert.ok(!JSON.stringify(lock).includes('codeload.github.com/ghost-raven1/neurocenter-assets'));
        if(directory){
            const docker=await fs.readFile(path.join(consumer,'Dockerfile'),'utf8');
            const copy=docker.match(/^COPY vendor\/asset-contract\/? (\/vendor\/asset-contract\/?)$/m);
            assert.ok(copy,'The local dependency must be copied before npm ci.');
            assert.ok(copy.index<docker.indexOf('npm ci'));
            assert.equal(path.posix.resolve('/app',reference.slice(5)),copy[1].replace(/\/$/,''));
            assert.ok(!docker.slice(copy.index).includes('rm -rf /vendor'));
            if(directory==='services/catalog-service')assert.ok(docker.includes('COPY vendor/asset-contract/ /tools/vendor/asset-contract/'));
        }
    }
});
