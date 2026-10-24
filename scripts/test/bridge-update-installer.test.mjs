import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {installerLifecycleFixture} from './bridge-installer-lifecycle.fixture.mjs';
import {writeRuntimeBootstraps} from '../../mcp/neurocenter-asset-sync/scripts/runtime-bootstraps.mjs';
const cleanup=createRequire(import.meta.url)('../../services/shared/bridge-update-cleanup.cjs');
const execute=promisify(execFile);

test('public archive installer records verified stages and cleans older successful backups after repeated updates',()=>installerLifecycleFixture('cleanup-updates',async f=>{
 const content=path.join(f.root,'package'),dist=path.join(content,'dist');
 await fs.copyFile(new URL('../../services/shared/bridge-update-cleanup.cjs',import.meta.url),path.join(dist,'shared/bridge-update-cleanup.cjs'));
 const names={
  'dist/bridge/connect.js':['startWorker','connectBridge','watchPair'],
  'dist/features/opencode-providers/authorization.js':['authorizeManagedProvider'],
  'dist/features/opencode-providers/ollama-sdk.js':['createOllama'],
 };
 for(const entry of cleanup.RUNTIME_USE_ENTRYPOINTS){
  if(['dist/index.js','dist/bridge-cli.js'].includes(entry))continue;
  const file=path.join(content,entry);await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,(names[entry]??[]).map(name=>`export const ${name}=()=>{};`).join('\n'));
 }
 await writeRuntimeBootstraps(dist);
 const archive=path.join(f.root,'cleanup.tgz');
 await execute('tar',['-czf',archive,'-C',content,'bin','dist','package.json','runtime.json','node_modules'],{env:{...f.environment,COPYFILE_DISABLE:'1'},timeout:20_000});
 const listing=await execute('tar',['-tvzf',archive],{timeout:10_000});assert.deepEqual(listing.stdout.trimEnd().split('\n').filter(line=>!/^[-d]/.test(line)),[]);
 const sha=createHash('sha256').update(await fs.readFile(archive)).digest('hex');await fs.writeFile(archive+'.sha256',sha+'\n');
 const script=path.join(f.root,'install.sh');
 const run=()=>execute('/bin/bash',[script,'--archive',archive],{env:f.environment,timeout:20_000,maxBuffer:1024**2});
 await run();
 const configuration=path.join(f.environment.XDG_CONFIG_HOME,'opencode/opencode.jsonc');
 const original=await fs.readFile(configuration),mode=(await fs.stat(configuration)).mode&0o777;
 for(let update=0;update<3;update++)await run();
 assert.deepEqual(await fs.readFile(configuration),original);assert.equal((await fs.stat(configuration)).mode&0o777,mode);
 const control=await cleanup.controlRootForInstallRoot(f.install);
 const receipts=(await fs.readdir(path.join(control,'receipts'))).filter(name=>name.endsWith('.json'));
 assert.equal(receipts.length,3);
 const records=await Promise.all(receipts.map(async name=>JSON.parse(await fs.readFile(path.join(control,'receipts',name),'utf8'))));
 const expectedRemoved=records.toSorted((a,b)=>a.completedAt-b.completedAt)[0].backup.root;
 let permits=0;
 const result=await cleanup.cleanupSuccessfulBackups({installRoot:f.install,now:Date.now()+8*86400000,beforeDelete:async()=>{permits++;}});
 assert.deepEqual(result.removed,[expectedRemoved]);assert.ok(permits>=2);
 assert.equal(result.kept.filter(item=>item.reason==='retained-rollback').length,2);
 await assert.rejects(fs.lstat(expectedRemoved),{code:'ENOENT'});
 assert.deepEqual(await fs.readFile(configuration),original);
 assert.equal(JSON.parse(await fs.readFile(path.join(f.install,cleanup.OWNER_FILE),'utf8')).installRoot,f.install);
 assert.equal(await fs.lstat(f.install+'.install-lock').then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}),false);
}));
