import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {backendSelection} from '../workspace/dev-watch-plan.mjs';
import {initialWatchGeneration} from '../workspace/dev-watch-files.mjs';
import {startDevWatch,stopDevWatch,devWatchStatus} from '../workspace/dev-watch-control.mjs';

/** Real guardian, IPC, compiler and loopback services; every file and process belongs to this test root. */
export async function daemonFixture(t,{flags=false}={}){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-watch-start-'))),sources=fileURLToPath(new URL('../workspace/',import.meta.url));
    const buildLog=path.join(root,'.run/build-calls.jsonl'),gate=path.join(root,'.run/flags-ready');let watcher;
    t.after(async()=>{await stopDevWatch(root,watcher?.record).catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
    await fs.mkdir(path.join(root,'scripts/workspace'),{recursive:true});await fs.mkdir(path.join(root,'.run/logs'),{recursive:true});await fs.mkdir(path.join(root,'node_modules'));
    for(const name of await fs.readdir(sources))if(name.startsWith('dev-watch-')||name.startsWith('dev-launch-')||['dev-processes.mjs','isolated-build.mjs','isolated-build-source.mjs','isolated-build-process.mjs','node-runtime.mjs'].includes(name))await fs.copyFile(path.join(sources,name),path.join(root,'scripts/workspace',name));
    await fs.writeFile(path.join(root,'package.json'),'{"name":"neurocenter-workspace"}');await fs.writeFile(path.join(root,'.gitignore'),'.run/\nnode_modules/\n**/node_modules/\n**/dist/\n');
    const code=value=>`const fs=require('node:fs'),http=require('node:http');const start=()=>{if(process.env.FAIL_AFTER_GATE==='1')process.exit(17);http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(['/health','/ready'].includes(req.url)?{ok:true}:{value:${JSON.stringify(value)}}));}).listen(Number(process.env.PORT),'127.0.0.1');};if(process.env.READY_GATE){fs.writeFileSync(process.env.READY_GATE+'.started','started');const wait=setInterval(()=>{if(!fs.existsSync(process.env.READY_GATE))return;clearInterval(wait);start();},10);}else start();`;
    for(const [id,folder,entry]of backendSelection){
        const target=path.join(root,folder);await fs.mkdir(path.join(target,'src'),{recursive:true});await fs.mkdir(path.join(target,'node_modules'));await fs.mkdir(path.join(target,'dist'));
        await fs.writeFile(path.join(target,'package.json'),JSON.stringify({name:id,version:'1.0.0',scripts:{build:'node build.cjs'}}));await fs.writeFile(path.join(target,'src/value.json'),'"initial"');await fs.writeFile(path.join(target,'dist',entry),code('initial'));
        await fs.writeFile(path.join(target,'build.cjs'),`const fs=require('node:fs'),value=JSON.parse(fs.readFileSync('src/value.json','utf8'));fs.appendFileSync(${JSON.stringify(buildLog)},JSON.stringify({id:${JSON.stringify(id)},value})+'\\n');const code=${code.toString()};fs.mkdirSync('dist',{recursive:true});fs.writeFileSync(${JSON.stringify('dist/'+entry)},code(value));`);
    }
    execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['-c','user.name=Watch Fixture','-c','user.email=fixture@example.test','commit','-qm','owned startup fixture'],{cwd:root});
    const services=[];
    for(const [name,dir]of [...(flags?[['flags','services/feature-flags-service']]:[]),['catalog','services/catalog-service']]){
        const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));
        services.push({name,dir,port,healthPath:'/ready',entry:path.join(root,dir,'dist/main.js'),environment:{PATH:process.env.PATH,PORT:String(port),PRIVATE_FIXTURE_SECRET:'NEVER_IN_PUBLIC_METADATA',...(name==='flags'?{READY_GATE:gate}:{})}});
    }
    return {root,services,gate,prepare:()=>initialWatchGeneration(root),
        async start(options={}){watcher=await startDevWatch({root,node:process.execPath,logDir:path.join(root,'.run/logs'),services,...options});return watcher;},
        status:()=>devWatchStatus(root),
        records:()=>fs.readFile(path.join(root,'.run/processes.json'),'utf8').then(JSON.parse),
        builds:()=>fs.readFile(buildLog,'utf8').then(text=>text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),()=>[]),
        version:()=>fetch('http://127.0.0.1:'+services.find(item=>item.name==='catalog').port+'/version').then(response=>response.json(),()=>null),
        async edit(value){await fs.writeFile(path.join(root,'services/catalog-service/src/value.json'),JSON.stringify(value));},
    };
}
