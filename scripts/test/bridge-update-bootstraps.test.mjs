import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {writeRuntimeBootstraps} from '../../mcp/neurocenter-asset-sync/scripts/runtime-bootstraps.mjs';
const cleanup=createRequire(import.meta.url)('../../services/shared/bridge-update-cleanup.cjs');
const execute=promisify(execFile);
const named={
 'dist/bridge/connect.js':['startWorker','connectBridge','watchPair'],
 'dist/features/opencode-providers/authorization.js':['authorizeManagedProvider'],
 'dist/features/opencode-providers/ollama-sdk.js':['createOllama'],
};

test('all shipped public entrypoints register before main code and retain their named exports',async()=>{
 const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-update-bootstrap-')));
 try{
  const installRoot=path.join(temporary,'installed');await fs.mkdir(installRoot);
  await fs.writeFile(path.join(installRoot,'package.json'),JSON.stringify({type:'module'}));
  await fs.writeFile(path.join(installRoot,cleanup.OWNER_FILE),JSON.stringify({schemaVersion:1,installRoot}));
  const dist=path.join(installRoot,'dist');await fs.mkdir(path.join(dist,'shared'),{recursive:true});
  await fs.copyFile(new URL('../../services/shared/bridge-update-cleanup.cjs',import.meta.url),path.join(dist,'shared/bridge-update-cleanup.cjs'));
  const control=await cleanup.controlRootForInstallRoot(installRoot);
  await fs.mkdir(path.join(control,'leases'),{recursive:true,mode:0o700});
  await fs.mkdir(path.join(control,'locks'),{mode:0o700});
  const inode=await fs.stat(installRoot,{bigint:true});
  // Broken maintenance locks must not prevent current CLI/SDK entrypoints from starting.
  for(const file of [path.join(control,'lock.json'),path.join(control,'locks',`gc-runtime-${inode.dev}-${inode.ino}.json`),path.join(control,'locks',`runtime-${inode.dev}-${inode.ino}.json`)])await fs.writeFile(file,'stale maintenance lock',{mode:0o600});
  for(const entry of cleanup.RUNTIME_USE_ENTRYPOINTS){
   const filename=path.join(installRoot,entry);await fs.mkdir(path.dirname(filename),{recursive:true});
   const code=`import fs from 'node:fs/promises';\nconst leaseRoot=${JSON.stringify(path.join(control,'leases'))};const leases=await fs.readdir(leaseRoot,{recursive:true});const owners=await Promise.all(leases.filter(name=>name.endsWith('.json')).map(async name=>JSON.parse(await fs.readFile(leaseRoot+'/'+name,'utf8'))));if(!owners.some(owner=>owner.pid===process.pid))throw Error('main executed without its own lease');\n`;
   await fs.writeFile(filename,code+(named[entry]??[]).map(name=>`export const ${name}=()=>${JSON.stringify(name)};`).join('\n'));
  }
  await writeRuntimeBootstraps(dist);
  for(const entry of cleanup.RUNTIME_USE_ENTRYPOINTS){
   const names=named[entry]??[];
   const program=`const m=await import(${JSON.stringify(pathToFileURL(path.join(installRoot,entry)).href)});console.log(JSON.stringify(${JSON.stringify(names)}.map(name=>m[name]())));`;
   const result=await execute(process.execPath,['--input-type=module','-e',program],{timeout:10_000});
   assert.deepEqual(JSON.parse(result.stdout.trim()),names);
  }
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dist,'runtime-use.json'),'utf8')),{schemaVersion:1,entrypoints:cleanup.RUNTIME_USE_ENTRYPOINTS});
 }finally{await fs.rm(temporary,{recursive:true,force:true});}
});

test('a malformed managed owner stops the real bootstrap before any main side effect',async()=>{
 const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-update-bootstrap-denied-')));
 try{
  await fs.writeFile(path.join(temporary,'package.json'),JSON.stringify({type:'module'}));
  const dist=path.join(temporary,'dist');await fs.mkdir(path.join(dist,'shared'),{recursive:true});
  await fs.copyFile(new URL('../../services/shared/bridge-update-cleanup.cjs',import.meta.url),path.join(dist,'shared/bridge-update-cleanup.cjs'));
  const effect=path.join(temporary,'executed');
  for(const entry of cleanup.RUNTIME_USE_ENTRYPOINTS){const filename=path.join(temporary,entry);await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,`await (await import('node:fs/promises')).writeFile(${JSON.stringify(effect)},'bad');`);}
  await writeRuntimeBootstraps(dist);await fs.writeFile(path.join(temporary,cleanup.OWNER_FILE),'{}');
  await assert.rejects(execute(process.execPath,[path.join(dist,'index.js')],{timeout:10_000}));
  await assert.rejects(fs.lstat(effect),{code:'ENOENT'});
 }finally{await fs.rm(temporary,{recursive:true,force:true});}
});
