import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type {Duplex} from 'node:stream';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import ts from 'typescript';

const source=fileURLToPath(new URL('../src/',import.meta.url));
export const profileSite='https://panel.example.test';
export const profileToken='qa-saved-profile-token';
export const profileCleanup:Array<{root:string;pids:number[];remaining:number[];removed:boolean}>=[];

/** Current source runs in an owned installation; only worker/browser side effects are replaced. */
export async function bridgeCliProfileFixture(kind:'http'|'https'|'proxy'='http'){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-bridge-cli-profile-')));
    const ownedServers:http.Server[]=[];
    const tunnels=new Set<Duplex>();
    try{
    const install=path.join(root,'installed'),callerHome=path.join(root,'caller'),runtimeHome=path.join(root,'runtime');
    const config=path.join(callerHome,'config/opencode/opencode.jsonc'),settings=path.join(install,'installation.json');
    const pidsFile=path.join(root,'pids.jsonl'),spawnFile=path.join(root,'spawns.jsonl');
    const visited=new Set<string>();
    async function compile(relative:string):Promise<void>{
        if(visited.has(relative))return;visited.add(relative);
        const filename=path.join(source,relative),destination=path.join(install,'dist',relative.replace(/\.ts$/,'.js'));
        if(!filename.startsWith(source)||!destination.startsWith(path.join(install,'dist')+path.sep))throw Error('Fixture compiler paths must stay in the source and owned installation.');
        const content=await fs.readFile(filename,'utf8');
        await fs.mkdir(path.dirname(destination),{recursive:true});
        await fs.writeFile(destination,ts.transpileModule(content,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);
        for(const imported of ts.preProcessFile(content).importedFiles){
            if(imported.fileName.startsWith('.')&&!imported.fileName.endsWith('.cjs'))await compile(path.normalize(path.join(path.dirname(relative),imported.fileName.replace(/\.js$/,'.ts'))));
        }
    }
    await compile('bridge-cli.ts');
    await fs.writeFile(path.join(install,'dist/index.js'),"throw Error('Worker fixture must never execute.');\n");
    await fs.mkdir(path.join(install,'dist/shared'),{recursive:true});
    // The owned standalone fixture carries the same explicitly shipped contracts as scripts/build.mjs.
    for(const name of ['agent-method-workflow.cjs','device-codex-inference.cjs','runtime-cache-policy.cjs','bridge-update-cleanup.cjs','bridge-update-lock.cjs','codex-connector-pin.json','codex-connector-source.cjs',
        'runtime-artifacts.cjs','rag-index-contract.cjs','rag-ui-contract.cjs','rag-core-contract.cjs','opencode-model-scan.cjs','adapter-parameters.cjs','opencode-providers.cjs',
        'project-snapshot.cjs','project-agents.cjs','project-configuration.cjs','project-learning.cjs','project-learning-memory-sync.cjs','project-learning-quirks.cjs','system-role-mcp.cjs'])
        await fs.copyFile(fileURLToPath(new URL('../../../services/shared/'+name,import.meta.url)),path.join(install,'dist/shared',name));
    await fs.writeFile(path.join(install,'package.json'),JSON.stringify({type:'module',version:'0.9.18'}));
    await fs.mkdir(path.join(install,'bin'));await fs.symlink(process.execPath,path.join(install,'bin/node'));
    await fs.mkdir(path.join(install,'node_modules'),{recursive:true});
    await fs.symlink(fileURLToPath(new URL('../node_modules/jsonc-parser',import.meta.url)),path.join(install,'node_modules/jsonc-parser'));
    for(const directory of [path.dirname(config),runtimeHome])await fs.mkdir(directory,{recursive:true});
    const hook=path.join(root,'hook.mjs'),worker=path.join(root,'worker.mjs'),spawner=path.join(root,'spawner.mjs'),browser=path.join(root,'browser.mjs');
    await fs.writeFile(worker,'export async function ensureCurrentWorker(){}');
    await fs.writeFile(browser,'export async function openVerificationPage(){return false;}');
    await fs.writeFile(spawner,`import{appendFileSync}from'node:fs';export function spawn(file,args){if(args[1]!=='--worker')throw Error('Unexpected pairing watcher');appendFileSync(${JSON.stringify(spawnFile)},JSON.stringify({file,args,home:process.env.HOME,pid:process.pid})+'\\n');return{unref(){}};}`);
    await fs.writeFile(hook,`import{registerHooks}from'node:module';import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(pidsFile)},JSON.stringify({pid:process.pid})+'\\n');registerHooks({resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(pathToFileURL(path.join(install,'dist/bridge/connect.js')).href)}){const replacements={'node:child_process':${JSON.stringify(pathToFileURL(spawner).href)},'./worker-upgrade.js':${JSON.stringify(pathToFileURL(worker).href)},'./open-browser.js':${JSON.stringify(pathToFileURL(browser).href)}};if(replacements[specifier])return{url:replacements[specifier],shortCircuit:true};}return next(specifier,context);}});`);
    const requests:Array<{route:string;authorization:string|undefined}>=[];
    const handler:http.RequestListener=(request,response)=>{
        requests.push({route:request.url??'',authorization:request.headers.authorization});request.resume();
        if(request.url?.endsWith('/api/device-channel/identity')&&request.headers.authorization==='Bearer '+profileToken){response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'saved-device',email:'qa@example.test',role:'developer'}));}
        else response.writeHead(403,{'content-type':'application/json'}).end('{"message":"Unexpected fresh pairing attempt"}');
    };
    const certificate=path.join(root,'ca.pem'),key=path.join(root,'key.pem');
    if(kind==='https')execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','1','-keyout',key,'-out',certificate,'-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'],{stdio:'ignore'});
    const server=kind==='https'?https.createServer({key:await fs.readFile(key),cert:await fs.readFile(certificate)},handler):http.createServer(handler);
    ownedServers.push(server);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error('Owned server did not bind.');
    const local=`${kind==='https'?'https':'http'}://127.0.0.1:${address.port}`;
    let api=local;
    const directRequests:string[]=[];
    const proxyTunnels:string[]=[];
    if(kind==='proxy'){
        const direct=http.createServer((request,response)=>{directRequests.push(request.url??'');request.resume();response.writeHead(403,{'content-type':'application/json'}).end('{"message":"Direct fixture endpoint requires configured proxy"}');});
        ownedServers.push(direct);await new Promise<void>(resolve=>direct.listen(0,'127.0.0.1',resolve));
        const target=direct.address();if(!target||typeof target==='string')throw Error('Owned direct target did not bind.');
        api='http://127.0.0.1:'+target.port;
        server.on('connect',(request,socket,head)=>{
            if(request.url!==new URL(api).host){socket.destroy();return;}
            proxyTunnels.push(request.url);tunnels.add(socket);
            const upstream=net.connect({host:'127.0.0.1',port:address.port});tunnels.add(upstream);
            upstream.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(socket);socket.pipe(upstream);});
            socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
            socket.once('close',()=>{tunnels.delete(socket);upstream.destroy();});upstream.once('close',()=>{tunnels.delete(upstream);socket.destroy();});
        });
    }
    await fs.writeFile(settings,JSON.stringify({schemaVersion:1,siteUrl:profileSite,apiUrl:api}));
    const namespace=createHash('sha256').update(profileSite).digest('hex').slice(0,20),credentials=path.join(runtimeHome,'.config/neurocenter/bridge',namespace,'credentials.json');
    await fs.mkdir(path.dirname(credentials),{recursive:true});await fs.writeFile(credentials,JSON.stringify({token:profileToken,deviceId:'saved-device',email:'qa@example.test'}),{mode:0o600});
    const savedEnvironment:Record<string,string>={HOME:runtimeHome,USERPROFILE:runtimeHome,XDG_CONFIG_HOME:path.join(runtimeHome,'config'),NEUROCENTER_URL:profileSite,NEUROCENTER_API_URL:api,
        ...(kind==='https'?{NODE_EXTRA_CA_CERTS:certificate}:{}),...(kind==='proxy'?{NODE_USE_ENV_PROXY:'1',HTTP_PROXY:local,NO_PROXY:''}:{})};
    const own={type:'local',enabled:false,command:[path.join(install,'bin/node'),path.join(install,'dist/index.js')],environment:savedEnvironment};
    const configuration={mcp:{'neurocenter-asset-sync':own,'other-agent':{type:'local',enabled:true,command:['other-agent']}}};
    await fs.writeFile(config,'// Caller OpenCode configuration remains untouched.\n'+JSON.stringify(configuration));
    const environment:NodeJS.ProcessEnv={HOME:callerHome,USERPROFILE:callerHome,XDG_CONFIG_HOME:path.join(callerHome,'config'),PATH:process.env.PATH,NODE_OPTIONS:'--import='+pathToFileURL(hook).href,NEUROCENTER_NO_BROWSER:'1'};
    const children:Array<ReturnType<typeof spawn>>=[];
    async function run(args=['connect','--open'],extra:NodeJS.ProcessEnv={}){
        const child=spawn(path.join(install,'bin/node'),[path.join(install,'dist/bridge-cli.js'),...args],{cwd:root,env:{...environment,...extra},stdio:['ignore','pipe','pipe']});children.push(child);
        let stdout='',stderr='';child.stdout!.on('data',chunk=>{stdout+=String(chunk);});child.stderr!.on('data',chunk=>{stderr+=String(chunk);});
        const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
        const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
        return{code,stdout,stderr};
    }
    const lines=async(file:string)=> (await fs.readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return'';throw error;})).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    return{root,install,callerHome,runtimeHome,config,settings,credentials,callerCredentials:path.join(callerHome,'.config/neurocenter/bridge',namespace,'credentials.json'),own,configuration,savedEnvironment,environment,api,requests,directRequests,proxyTunnels,run,workers:()=>lines(spawnFile),
        async close(){
            for(const child of children){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}}
            for(const socket of tunnels)socket.destroy();
            for(const owned of ownedServers){owned.closeAllConnections();await new Promise<void>((resolve,reject)=>owned.close(error=>error?reject(error):resolve()));}
            const pids=(await lines(pidsFile)).map(record=>record.pid as number),remaining=pids.filter(pid=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}});
            await fs.rm(root,{recursive:true,force:true});profileCleanup.push({root,pids,remaining,removed:!await fs.access(root).then(()=>true,()=>false)});
            if(remaining.length)throw Error('Owned CLI child remains alive.');
        }};
    }catch(error){
        for(const socket of tunnels)socket.destroy();
        for(const owned of ownedServers){if(owned.listening){owned.closeAllConnections();await new Promise<void>(resolve=>owned.close(()=>resolve()));}}
        await fs.rm(root,{recursive:true,force:true});throw error;
    }
}
