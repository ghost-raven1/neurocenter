import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {startDevWatch,stopDevWatch,devWatchStatus} from '../workspace/dev-watch-control.mjs';
import {backendSelection} from '../workspace/dev-watch-plan.mjs';
import {initialWatchGeneration,readWatchFile} from '../workspace/dev-watch-files.mjs';
const sources=fileURLToPath(new URL('../workspace/',import.meta.url));
for(const prepared of [false,true])test('actual guardian/daemon '+(prepared?'uses a prepared generation without mutable dist':'freezes the current dist')+', rebuilds, preserves a failed runtime and stops',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-watch-daemon-')));let watcher;
 t.after(async()=>{if(watcher)await stopDevWatch(root,watcher.record).catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
 await fs.mkdir(path.join(root,'scripts/workspace'),{recursive:true});await fs.mkdir(path.join(root,'.run/logs'),{recursive:true});await fs.mkdir(path.join(root,'node_modules'));
 for(const name of await fs.readdir(sources))if(name.startsWith('dev-watch-')||name.startsWith('dev-launch-')||['dev-processes.mjs','isolated-build.mjs','isolated-build-source.mjs','isolated-build-process.mjs','node-runtime.mjs'].includes(name))await fs.copyFile(path.join(sources,name),path.join(root,'scripts/workspace',name));
 await fs.writeFile(path.join(root,'package.json'),'{"name":"neurocenter-workspace"}');await fs.writeFile(path.join(root,'.gitignore'),'.run/\nnode_modules/\n**/node_modules/\n**/dist/\n');
 const code=value=>`require('node:http').createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url==='/health'?{ok:true}:{value:${JSON.stringify(value)}}));}).listen(Number(process.env.PORT),'127.0.0.1');`;
 for(const [id,folder,entry]of backendSelection){const target=path.join(root,folder);await fs.mkdir(path.join(target,'src'),{recursive:true});await fs.mkdir(path.join(target,'node_modules'));await fs.mkdir(path.join(target,'dist'));await fs.writeFile(path.join(target,'package.json'),JSON.stringify({name:id,version:'1.0.0',scripts:{build:'node build.cjs'}}));await fs.writeFile(path.join(target,'src/value.json'),'"initial"');await fs.writeFile(path.join(target,'dist',entry),code('initial'));await fs.writeFile(path.join(target,'build.cjs'),`const fs=require('node:fs'),value=JSON.parse(fs.readFileSync('src/value.json','utf8'));if(value==='FAIL'){console.error('synthetic compilation failure');process.exit(2);}fs.mkdirSync('dist',{recursive:true});fs.writeFileSync(${JSON.stringify('dist/'+entry)},'('+${JSON.stringify(code.toString())}+')(value)');`);}
 // Keep compilation a real npm/Node operation, with no install or dependencies/network involved.
 for(const [,folder,entry]of backendSelection)await fs.writeFile(path.join(root,folder,'build.cjs'),`const fs=require('node:fs'),value=JSON.parse(fs.readFileSync('src/value.json','utf8'));if(value==='FAIL'){console.error('synthetic compilation failure');process.exit(2);}const code=${code.toString()};fs.mkdirSync('dist',{recursive:true});fs.writeFileSync(${JSON.stringify('dist/'+entry)},code(value));`);
 execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['-c','user.name=Watch Fixture','-c','user.email=fixture@example.test','commit','-qm','owned fixture'],{cwd:root});
 const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const service={name:'catalog',label:'Fixture',dir:'services/catalog-service',port,entry:path.join(root,'services/catalog-service/dist/main.js'),environment:{PATH:process.env.PATH,PORT:String(port),PRIVATE_FIXTURE_SECRET:'DO_NOT_PERSIST'}};
 const initialGeneration=prepared?await initialWatchGeneration(root):undefined;
 if(prepared)for(const [,folder]of backendSelection)await fs.rm(path.join(root,folder,'dist'),{recursive:true});
 watcher=await startDevWatch({root,node:process.execPath,logDir:path.join(root,'.run/logs'),services:[service],initialGeneration});const version=async()=>fetch('http://127.0.0.1:'+port+'/version',{signal:AbortSignal.timeout(1000)}).then(r=>r.json(),()=>null);
 /** Each phase includes real npm/Node processes, snapshots and ownership admission on a contended host. */
 const waitFor=async(label,budgetMs,check)=>{const started=performance.now();let status;
  while(performance.now()-started<budgetMs){status=await readWatchFile(root,'status.json');const value=await check(status);if(value){t.diagnostic(`${label}: ${Math.round(performance.now()-started)}ms / ${budgetMs}ms`);return value;}
   if(['build-failed','watch-input-error','watch-failed','stopped'].includes(status?.phase))break;await delay(100);}
  const records=JSON.parse(await fs.readFile(path.join(root,'.run/processes.json'),'utf8'));
  assert.fail(`${label}: elapsed=${Math.round(performance.now()-started)}ms budget=${budgetMs}ms ${JSON.stringify({phase:status?.phase,lastBuild:status?.lastBuild,pending:status?.pending,selected:status?.selected,records:records.map(({name,pid,launchId})=>({name,pid,launchId}))})}`);
 };
 // HTTP can answer while launch admission is still proving the new PID/FD, before process publication.
 const published=async(status,previous)=>{if(status?.phase!=='watching'||!status.lastBuild?.ok)return;
  const record=JSON.parse(await fs.readFile(path.join(root,'.run/processes.json'),'utf8')).find(record=>record.name==='catalog');assert.ok(record,'watching must contain the published Catalog record');
  if(previous&&(record.launchId===previous.record.launchId||record.entry===previous.record.entry||status.updatedAt===previous.status.updatedAt))return;
  return {status,record};};
 // Full initial compilation gets 5s per package plus the 20s readiness and 5s admission allowances.
 const initial=await waitFor('initial generation publication ('+backendSelection.length+' packages)',backendSelection.length*5000+25000,status=>published(status));assert.equal((await devWatchStatus(root)).alive,true);assert.equal((await version()).value,'initial');
 await fs.writeFile(path.join(root,service.dir,'src/value.json'),'"edited"');const before=(await waitFor('edited generation publication',45000,async status=>{const value=await published(status,initial);return value&&(await version())?.value==='edited'&&value;})).record;assert.equal((await devWatchStatus(root)).alive,true);
 await fs.writeFile(path.join(root,service.dir,'src/value.json'),'"FAIL"');const failed=await waitFor('failed Catalog compilation',20000,status=>status?.phase==='build-failed'&&status);assert.equal(failed.lastBuild?.ok,false);assert.equal(failed.lastBuild?.code,'BUILD_FAILED');assert.deepEqual(failed.lastBuild?.selected,['catalog-service']);assert.equal((await version()).value,'edited');
 const after=JSON.parse(await fs.readFile(path.join(root,'.run/processes.json'),'utf8')).find(record=>record.name==='catalog');assert.equal(after.pid,before.pid);assert.equal(after.serviceWitness.pid,before.serviceWitness.pid);assert.equal(after.launchId,before.launchId);
 assert.doesNotMatch(await fs.readFile(path.join(root,'.run/processes.json'),'utf8'),/DO_NOT_PERSIST/);await stopDevWatch(root,watcher.record);watcher=undefined;assert.equal((await devWatchStatus(root)).alive,false);assert.equal(await version(),null);
});
