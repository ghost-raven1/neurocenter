import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,access,lstat,readdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {modelSourceFixture} from './model-source.fixture.mjs';
import {parseModelBundleArguments} from '../models/bundle-cli.mjs';

const execute=promisify(execFile),cli=fileURLToPath(new URL('../models/bundle-cli.mjs',import.meta.url));
async function run(args,options={}){try{return {status:0,...await execute(process.execPath,[cli,...args],{timeout:20000,maxBuffer:1024*1024,...options})};}catch(error){return {status:error.code,stdout:error.stdout,stderr:error.stderr};}}

test('CLI requires exact new asset and rejects every old source/default before I/O',()=>{
    assert.deepEqual(parseModelBundleArguments(['--asset','new.json','--directory','data','--verify-only']),{asset:'new.json',directory:'data',verifyOnly:true});
    for(const args of [[],['--directory','data'],['--manifest','old.json','--directory','data'],['--adopt-from-git','HEAD'],['--pack'],['--directory','data','--recover-only','--asset','new.json'],['constructor','x'],['--asset','x','--directory','data','--verify-only','--verify-only']])assert.throws(()=>parseModelBundleArguments(args));
});
test('Actual CLI installs from SHA cache offline and verifies immutable alias without network',async t=>{
    const f=await modelSourceFixture(t);await f.prepare();const asset=await f.cached(),descriptor=path.join(f.output,'asset.json');
    const hook=path.join(f.root,'deny-network.mjs');await writeFile(hook,"globalThis.fetch=()=>{throw new Error('NETWORK_FORBIDDEN')};\n");
    const options={env:{...process.env,NODE_OPTIONS:'--import='+pathToFileURL(hook).href}},args=['--asset',descriptor,'--directory',f.target];
    const first=await run([...args,'--blob-directory',f.blobs],options);assert.equal(first.status,0,first.stderr);
    const report=JSON.parse(first.stdout);assert.equal(report.assetId,asset.id);assert.equal(report.version,asset.version);
    const alias=path.join(f.target,'models/manifests/registry.ollama.ai/neurocenter',asset.delivery.lock.manifestSha256,'v1');assert.ok((await lstat(alias)).isFile());
    await assert.rejects(access(path.join(f.target,'models/manifests/registry.ollama.ai/library/fixture-embedding/1')),{code:'ENOENT'});
    const before=await readFile(alias),verified=await run([...args,'--verify-only'],options);assert.equal(verified.status,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).verifyOnly,true);assert.deepEqual(await readFile(alias),before);
    assert.equal((await readdir(f.root)).includes('.run'),true); // Producer lease belongs to this fixture only.
});
test('CLI rejects old native bundle JSON even when it is otherwise internally valid',async t=>{
    const f=await modelSourceFixture(t);await f.prepare();const asset=await f.cached(),old=path.join(f.root,'old-bundle.json');await writeFile(old,JSON.stringify(asset.delivery.bundle));
    const result=await run(['--asset',old,'--directory',f.target]);assert.notEqual(result.status,0);await assert.rejects(access(f.target),{code:'ENOENT'});
});
test('Missing/corrupt local content cannot trigger remote download or activate a model',async t=>{
    const f=await modelSourceFixture(t);await f.prepare();const asset=await f.cached(),part=asset.delivery.bundle.files.flatMap(file=>file.parts||[])[0];
    await writeFile(path.join(f.blobs,part.sha256+'.blob'),Buffer.alloc(part.size,9));
    const result=await run(['--asset',path.join(f.output,'asset.json'),'--directory',f.target,'--blob-directory',f.blobs]);assert.notEqual(result.status,0);assert.match(result.stdout,/SHA|MODEL_BUNDLE/);
    await assert.rejects(access(path.join(f.target,'models/manifests/registry.ollama.ai/neurocenter',asset.delivery.lock.manifestSha256,'v1')),{code:'ENOENT'});
});
test('Source descriptor symlink is rejected and foreign bytes remain intact',async t=>{
    const f=await modelSourceFixture(t);const result=await f.prepare(),link=path.join(f.root,'linked.json');await symlink(result.descriptor,link);const before=await readFile(result.descriptor);
    assert.notEqual((await run(['--asset',link,'--directory',f.target])).status,0);assert.deepEqual(await readFile(result.descriptor),before);
});
test('Help and module import perform no operation and need no asset configuration',async()=>{
    const help=await run(['--help']);assert.equal(help.status,0);assert.match(help.stdout,/asset.json/);
    const imported=await execute(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('../models/bundle-cli.mjs',import.meta.url).href)})`]);assert.equal(imported.stdout,'');assert.equal(imported.stderr,'');
});
