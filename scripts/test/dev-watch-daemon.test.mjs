import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {startDevWatch,stopDevWatch,devWatchStatus} from '../workspace/dev-watch-control.mjs';
import {backendSelection} from '../workspace/dev-watch-plan.mjs';
import {until} from './dev-watch-native.fixture.mjs';
const sources=fileURLToPath(new URL('../workspace/',import.meta.url));
test('actual guardian/daemon builds current source, restarts it, keeps old runtime on compilation failure and stops',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-watch-daemon-')));let watcher;
 t.after(async()=>{if(watcher)await stopDevWatch(root,watcher.record).catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
 await fs.mkdir(path.join(root,'scripts/workspace'),{recursive:true});await fs.mkdir(path.join(root,'.run/logs'),{recursive:true});await fs.mkdir(path.join(root,'node_modules'));
 for(const name of await fs.readdir(sources))if(name.startsWith('dev-watch-')||['dev-processes.mjs','isolated-build.mjs','isolated-build-source.mjs','isolated-build-process.mjs','node-runtime.mjs'].includes(name))await fs.copyFile(path.join(sources,name),path.join(root,'scripts/workspace',name));
 await fs.writeFile(path.join(root,'package.json'),'{"name":"neurocenter-workspace"}');await fs.writeFile(path.join(root,'.gitignore'),'.run/\nnode_modules/\n**/node_modules/\n**/dist/\n');
 const code=value=>`require('node:http').createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url==='/health'?{ok:true}:{value:${JSON.stringify(value)}}));}).listen(Number(process.env.PORT),'127.0.0.1');`;
 for(const [id,folder,entry]of backendSelection){const target=path.join(root,folder);await fs.mkdir(path.join(target,'src'),{recursive:true});await fs.mkdir(path.join(target,'node_modules'));await fs.mkdir(path.join(target,'dist'));await fs.writeFile(path.join(target,'package.json'),JSON.stringify({name:id,version:'1.0.0',scripts:{build:'node build.cjs'}}));await fs.writeFile(path.join(target,'src/value.json'),'"initial"');await fs.writeFile(path.join(target,'dist',entry),code('initial'));await fs.writeFile(path.join(target,'build.cjs'),`const fs=require('node:fs'),value=JSON.parse(fs.readFileSync('src/value.json','utf8'));if(value==='FAIL'){console.error('synthetic compilation failure');process.exit(2);}fs.mkdirSync('dist',{recursive:true});fs.writeFileSync(${JSON.stringify('dist/'+entry)},'('+${JSON.stringify(code.toString())}+')(value)');`);}
 // Keep compilation a real npm/Node operation, with no install or dependencies/network involved.
 for(const [,folder,entry]of backendSelection)await fs.writeFile(path.join(root,folder,'build.cjs'),`const fs=require('node:fs'),value=JSON.parse(fs.readFileSync('src/value.json','utf8'));if(value==='FAIL'){console.error('synthetic compilation failure');process.exit(2);}const code=${code.toString()};fs.mkdirSync('dist',{recursive:true});fs.writeFileSync(${JSON.stringify('dist/'+entry)},code(value));`);
 execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['-c','user.name=Watch Fixture','-c','user.email=fixture@example.test','commit','-qm','owned fixture'],{cwd:root});
 const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const service={name:'catalog',label:'Fixture',dir:'services/catalog-service',port,entry:path.join(root,'services/catalog-service/dist/main.js'),environment:{PATH:process.env.PATH,PORT:String(port),PRIVATE_FIXTURE_SECRET:'DO_NOT_PERSIST'}};
 watcher=await startDevWatch({root,node:process.execPath,logDir:path.join(root,'.run/logs'),services:[service]});const version=async()=>fetch('http://127.0.0.1:'+port+'/version').then(r=>r.json(),()=>null);
 await until(async()=>{const status=await devWatchStatus(root);return status?.phase==='watching'&&status.lastBuild?.ok;});assert.equal((await version()).value,'initial');
 await fs.writeFile(path.join(root,service.dir,'src/value.json'),'"edited"');await until(async()=>(await version())?.value==='edited');const before=JSON.parse(await fs.readFile(path.join(root,'.run/processes.json'),'utf8')).find(record=>record.name==='catalog').pid;
 await fs.writeFile(path.join(root,service.dir,'src/value.json'),'"FAIL"');await until(async()=>(await devWatchStatus(root))?.phase==='build-failed');assert.equal((await version()).value,'edited');assert.equal(JSON.parse(await fs.readFile(path.join(root,'.run/processes.json'),'utf8')).find(record=>record.name==='catalog').pid,before);
 assert.doesNotMatch(await fs.readFile(path.join(root,'.run/processes.json'),'utf8'),/DO_NOT_PERSIST/);await stopDevWatch(root,watcher.record);watcher=undefined;assert.equal((await devWatchStatus(root)).alive,false);assert.equal(await version(),null);
});
