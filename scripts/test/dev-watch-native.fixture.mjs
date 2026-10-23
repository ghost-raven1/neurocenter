import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {devProcessIdentity} from '../workspace/dev-processes.mjs';
import {stopWatchGroup,groupAlive} from '../workspace/dev-watch-owned.mjs';
import {WatchRuntime} from '../workspace/dev-watch-runtime.mjs';
const source=fileURLToPath(new URL('../workspace/dev-watch-child.mjs',import.meta.url));
export const until=async check=>{const end=Date.now()+7000;while(Date.now()<end){const value=await check();if(value)return value;await delay(25);}throw Error('fixture condition timed out');};
export async function nativeWatchFixture(t){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc watch own '))),groups=[],children=[];await fs.mkdir(path.join(root,'scripts/workspace'),{recursive:true});await fs.copyFile(source,path.join(root,'scripts/workspace/dev-watch-child.mjs'));await fs.mkdir(path.join(root,'.run/logs'),{recursive:true});
    t.after(async()=>{await Promise.allSettled(groups.map(record=>stopWatchGroup(record)));for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await fs.rm(root,{recursive:true,force:true});});
    const port=async()=>{const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;};
    const owner=async(args,env={})=>{const child=spawn(process.execPath,[path.join(root,'scripts/workspace/dev-watch-child.mjs')],{cwd:root,env:{PATH:process.env.PATH},detached:true,stdio:['ignore','ignore','ignore','ipc']});children.push(child);await once(child,'spawn');const record={pid:child.pid,identity:devProcessIdentity(child.pid)};groups.push(record);child.send({kind:'run',args,environment:{PATH:process.env.PATH,...env}});return {child,record};};
    const generation=async(value,{crash=false}={})=>{const folder=path.join(root,'.run/dev-watch/generations',randomUUID()),repository=path.join(folder,'repository');await fs.mkdir(path.join(repository,'services/shared'),{recursive:true});await fs.writeFile(path.join(repository,'services/shared/value.json'),JSON.stringify({value}));for(const name of ['catalog-service','api-gateway']){const directory=path.join(repository,'services',name,'dist');await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'main.js'),crash?'process.exit(17)':`const http=require('node:http'),value=require('../../shared/value.json');http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url==='/health'?{ok:true}:value));}).listen(Number(process.env.PORT),'127.0.0.1');`);}return {folder,repository};};
    const runtime=async()=>{const services=[];for(const [name,dir]of [['catalog','services/catalog-service'],['gateway','services/api-gateway']]){await fs.mkdir(path.join(root,dir),{recursive:true});services.push({name,dir,port:await port(),environment:{PATH:process.env.PATH,PORT:'',PRIVATE_FIXTURE_SECRET:'NEVER_IN_METADATA'},entry:''});services.at(-1).environment.PORT=String(services.at(-1).port);}
        const value=new WatchRuntime({root,node:process.execPath,logDir:path.join(root,'.run/logs'),watcherRecord:{name:'source-watch',pid:process.pid,identity:devProcessIdentity(process.pid)},services},message=>{if(message.kind==='group')groups.push(message.record);});t.after(()=>value.close().catch(()=>{}));return value;};
    return {root,groups,children,owner,generation,runtime,groupAlive};
}
