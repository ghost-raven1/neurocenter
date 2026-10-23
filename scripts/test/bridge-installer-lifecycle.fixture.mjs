import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readBridgeTemplate} from '../workspace/bridge-templates.mjs';

const require=createRequire(import.meta.url),exec=promisify(execFile),repository=fileURLToPath(new URL('../../',import.meta.url));
const version=JSON.parse(await fs.readFile(path.join(repository,'mcp/neurocenter-asset-sync/package.json'),'utf8')).version;
const target=`${process.platform}-${process.arch}${process.platform==='linux'&&!process.report.getReport().header.glibcVersionRuntime?'-musl':''}`;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),proofs=[];
const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";

/** Actual Bash, curl, tar and Node children; only the tiny CLI workload is controlled. */
export async function installerLifecycleFixture(name,action){
    assert.ok(['darwin','linux'].includes(process.platform));
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-shell-installer-'))),home=path.join(root,'home'),install=path.join(home,'own bridge'),content=path.join(root,'package');
    const state={paused:false,requests:[],issuerRequests:[],cli:[],contexts:[],workers:[],workerDirectories:[],archiveFailures:0,resumeFailures:0,resumeRefusals:0,pauseReply:undefined,token:undefined,issuerToken:undefined,onPause:undefined};let server,issuer,issuerOrigin;
    const issuerRequests=new Set();
    const payload=path.join(root,'bridge.tgz');
    try{
        await fs.mkdir(path.join(content,'bin'),{recursive:true});await fs.mkdir(path.join(content,'dist'),{recursive:true});await fs.mkdir(install,{recursive:true});
        await fs.writeFile(path.join(install,'package.json'),JSON.stringify({name:'neurocenter-asset-sync',version:'0.9.17'}));await fs.writeFile(path.join(install,'previous.txt'),'owned old runtime');
        await fs.writeFile(path.join(content,'package.json'),JSON.stringify({name:'neurocenter-asset-sync',version,type:'module'}));
        await fs.writeFile(path.join(content,'bin/node'),'#!/bin/sh\nexec '+quote(process.execPath)+' "$@"\n',{mode:0o755});
        await fs.cp(path.join(repository,'mcp/neurocenter-asset-sync/node_modules/jsonc-parser'),path.join(content,'node_modules/jsonc-parser'),{recursive:true});
        const entry=`import fs from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';import jsonc from 'jsonc-parser';
const mode=process.argv[2];await fs.appendFile(process.env.INSTALLER_FIXTURE_EVENTS,mode+'\\n');
await fs.appendFile(process.env.INSTALLER_FIXTURE_CONTEXTS,JSON.stringify({mode,site:process.env.NEUROCENTER_URL,api:process.env.NEUROCENTER_API_URL,home:process.env.HOME,xdg:process.env.XDG_CONFIG_HOME,bridgeHome:process.env.NEUROCENTER_BRIDGE_HOME,ca:process.env.NODE_EXTRA_CA_CERTS,proxy:process.env.HTTPS_PROXY})+'\\n');
const configDir=path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'opencode');
async function config(){await fs.mkdir(configDir,{recursive:true});const file=path.join(configDir,'opencode.jsonc');const text=await fs.readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return '{}\\n';throw e;});return{file,text};}
async function token(){if(!process.env.INSTALLER_FIXTURE_REQUIRE_PROFILE)return undefined;const base=process.env.NEUROCENTER_BRIDGE_HOME||path.join(os.homedir(),'.config/neurocenter/bridge'),namespace=createHash('sha256').update(process.env.NEUROCENTER_URL).digest('hex').slice(0,20);try{return JSON.parse(await fs.readFile(path.join(base,namespace,'credentials.json'),'utf8')).token;}catch(error){if(error.code==='ENOENT')return undefined;throw error;}}
async function api(route){const credential=await token(),response=await fetch(process.env.NEUROCENTER_API_URL+'/api/device-channel/'+(['identity','pair/start'].includes(route)?route:'worker/'+route),{method:'POST',body:'{}',headers:{'content-type':'application/json',...(credential?{authorization:'Bearer '+credential}: {})},signal:AbortSignal.timeout(1500)});if(!response.ok)throw Error('Owned fixture API refusal');return response.json();}
const namespace=createHash('sha256').update(process.env.NEUROCENTER_URL).digest('hex').slice(0,20),stateDir=path.join(process.env.NEUROCENTER_BRIDGE_HOME||path.join(os.homedir(),'.config/neurocenter/bridge'),namespace);
if(mode==='--worker'){
 await fs.mkdir(stateDir,{recursive:true});const lock=path.join(stateDir,'worker.lock');await fs.writeFile(lock,String(process.pid),{flag:'wx'});const version=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version,buildId=JSON.parse(await fs.readFile(new URL('./build.json',import.meta.url),'utf8')).buildId;await fs.writeFile(path.join(stateDir,'worker-version.json'),JSON.stringify({pid:process.pid,version,buildId}));process.on('SIGTERM',async()=>{if(await fs.readFile(lock,'utf8').catch(()=>undefined)===String(process.pid))await fs.unlink(lock);process.exit(0);});setInterval(()=>{},1000);await new Promise(()=>{});
}else if(mode==='--prepare-upgrade'){
 if(process.env.INSTALLER_FIXTURE_PREPARE==='refused'){console.log('{"ok":false,"error":"Owned definitive refusal"}');process.exit(1);}
 let prepared={paused:true};if(process.env.INSTALLER_FIXTURE_NATIVE_UPGRADE){try{prepared=await (await import('./bridge/worker-upgrade.js')).prepareWorkerUpgrade(process.argv[3]);}catch(error){console.log(JSON.stringify({ok:false,error:error.message}));process.exit(1);}}else await api('pause');
 if(process.env.INSTALLER_FIXTURE_PREPARE==='lost')process.exit(17);
 console.log(process.env.INSTALLER_FIXTURE_PREPARE||JSON.stringify({ok:true,...prepared}));
}else if(mode==='--finish-upgrade'){if(process.env.INSTALLER_FIXTURE_NATIVE_UPGRADE)await (await import('./bridge/worker-upgrade.js')).finishWorkerUpgrade();else await api('resume');console.log(JSON.stringify({ok:true}));}
else if(mode==='--init'){if(process.env.INSTALLER_FIXTURE_INIT_FAIL){console.log('{"ok":false,"error":"Owned registration failure"}');process.exit(1);}const {file,text}=await config();const entry={type:'local',enabled:true,command:[path.resolve(import.meta.dirname,'../bin/node'),path.join(import.meta.dirname,'index.js')],environment:{NEUROCENTER_URL:process.env.NEUROCENTER_URL,NEUROCENTER_API_URL:process.env.NEUROCENTER_API_URL}};await fs.writeFile(file,jsonc.applyEdits(text,jsonc.modify(text,['mcp','neurocenter-asset-sync'],entry,{})));console.log(JSON.stringify({ok:true,configPath:file,created:false}));}
else if(mode==='--connect-open'||mode==='--reconnect-open'){
 if(process.env.INSTALLER_FIXTURE_CONNECT_FAIL){console.log(JSON.stringify({ok:false,error:'Owned connect failure'}));process.exit(19);}
 if(process.env.INSTALLER_FIXTURE_REQUIRE_PROFILE&&(!await token()||mode==='--reconnect-open')){const pair=await api('pair/start');await fs.mkdir(stateDir,{recursive:true});await fs.writeFile(path.join(stateDir,'pair.json'),JSON.stringify({deviceCode:pair.deviceCode,userCode:pair.userCode,candidateToken:'own-new-pair-candidate'}),{mode:0o600});console.log(JSON.stringify({url:process.env.NEUROCENTER_URL+'/start?step=1&connect='+pair.userCode,code:pair.userCode,expiresIn:pair.expiresIn,browserOpened:false}));}
 else{if(process.env.INSTALLER_FIXTURE_REQUIRE_PROFILE)await api('identity');console.log(JSON.stringify({connected:true}));}
}
else throw Error('Unexpected own fixture CLI mode');\n`;
        const ts=require(path.join(repository,'mcp/neurocenter-asset-sync/node_modules/typescript'));
        await fs.mkdir(path.join(content,'dist/bridge'),{recursive:true});
        for(const name of ['worker-upgrade','state','protocol','read-bounded','atomic-file']){
            const source=await fs.readFile(path.join(repository,'mcp/neurocenter-asset-sync/src/bridge',name+'.ts'),'utf8');
            await fs.writeFile(path.join(content,'dist/bridge',name+'.js'),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
        }
        await fs.mkdir(path.join(content,'dist/features/opencode-providers'),{recursive:true});
        await fs.writeFile(path.join(content,'dist/features/opencode-providers/contract.js'),ts.transpileModule(await fs.readFile(path.join(repository,'mcp/neurocenter-asset-sync/src/features/opencode-providers/contract.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
        await fs.mkdir(path.join(content,'dist/shared'),{recursive:true});await fs.copyFile(path.join(repository,'services/shared/opencode-providers.cjs'),path.join(content,'dist/shared/opencode-providers.cjs'));
        await fs.mkdir(path.join(content,'dist/lib'),{recursive:true});
        await fs.writeFile(path.join(content,'dist/lib/global-config-lock.js'),ts.transpileModule(await fs.readFile(path.join(repository,'mcp/neurocenter-asset-sync/src/lib/global-config-lock.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
        await fs.writeFile(path.join(content,'dist/index.js'),entry);await fs.writeFile(path.join(content,'dist/bridge-cli.js'),"import fs from 'node:fs/promises';import path from 'node:path';await fs.appendFile(process.env.INSTALLER_FIXTURE_CONTEXTS,JSON.stringify({mode:'--install-command',site:process.env.NEUROCENTER_URL,api:process.env.NEUROCENTER_API_URL,home:process.env.HOME,xdg:process.env.XDG_CONFIG_HOME})+'\\n');if(process.env.INSTALLER_FIXTURE_INSTALL_COMMAND_FAIL){console.log(JSON.stringify({ok:false,error:'Owned optional launcher failure'}));process.exit(23);}const file=path.join(process.env.HOME,'.local/bin/neurocenter-bridge');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'owned caller launcher');console.log(file);\n");
        await fs.cp(path.join(content,'dist'),path.join(install,'dist'),{recursive:true});await fs.cp(path.join(content,'bin'),path.join(install,'bin'),{recursive:true});await fs.cp(path.join(content,'node_modules'),path.join(install,'node_modules'),{recursive:true});
        await fs.writeFile(path.join(install,'dist/build.json'),JSON.stringify({version:'0.9.17',buildId:'f'.repeat(64)}));
        const buildId=sha(entry);await fs.writeFile(path.join(content,'dist/build.json'),JSON.stringify({version,buildId}));await fs.writeFile(path.join(content,'runtime.json'),JSON.stringify({version,buildId,target,nodeVersion:process.versions.node}));
        await exec('tar',['-czf',payload,'-C',content,'bin','dist','package.json','runtime.json','node_modules'],{env:{...process.env,COPYFILE_DISABLE:'1'},timeout:10000});
        const bytes=await fs.readFile(payload),filename=`neurocenter-asset-sync-${target}-${version}.tgz`,checksum=sha(bytes)+'\n';
        server=http.createServer(async(request,response)=>{
            const route=request.url;state.requests.push({method:request.method,route,authorization:!!request.headers.authorization});request.resume();
            if(request.method==='GET'&&route.startsWith('/api/bridge/install.sh')){response.end((await readBridgeTemplate(path.join(repository,'bridge-dist/install.sh'))).replace('__BASE_URL__',origin+'/api/bridge').replace('__SITE_URL__',origin).replace('__BRIDGE_VERSION__',version).replace('__RECONNECT__',route.includes('reconnect=1')?'1':'0'));return;}
            if(route==='/api/bridge/runtime/'+filename){if(state.archiveFailures-->0){response.writeHead(200,{'content-length':bytes.length});response.write(bytes.subarray(0,64));setTimeout(()=>response.destroy(),5);return;}response.writeHead(200,{'content-type':'application/gzip','content-length':bytes.length}).end(bytes);return;}
            if(route==='/api/bridge/runtime/'+filename+'.sha256'){response.end(checksum);return;}
            if(request.method==='POST'&&route==='/api/device-channel/pair/start'){if(request.headers.authorization){response.writeHead(403).end('{}');return;}response.end('{"deviceCode":"own-target-device","userCode":"OWN-TARGET","expiresIn":600}');return;}
            if(route.startsWith('/api/device-channel/')&&state.token&&request.headers.authorization!=='Bearer '+state.token){response.writeHead(401).end('{}');return;}
            if(request.method==='POST'&&route==='/api/device-channel/identity'){response.end('{"id":"paired-device"}');return;}
            if(request.method==='POST'&&route==='/api/device-channel/worker/pause'){state.paused=true;await state.onPause?.();response.setHeader('content-type','application/json');response.end(JSON.stringify(state.pauseReply??{activeJobs:0}));return;}
            if(request.method==='POST'&&route==='/api/device-channel/worker/resume'){if(state.resumeRefusals-->0){response.writeHead(503).end('{}');return;}state.paused=false;if(state.resumeFailures-->0){response.destroy();return;}response.setHeader('content-type','application/json');response.end('{"ok":true}');return;}
            response.writeHead(404).end();
        });
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const origin='http://127.0.0.1:'+server.address().port,script=path.join(root,'install.sh');
        const template=(await readBridgeTemplate(process.env.BRIDGE_INSTALLER_TEST_TEMPLATE||path.join(repository,'bridge-dist/install.sh'))).replace('__BASE_URL__',origin+'/api/bridge').replace('__SITE_URL__',origin).replace('__BRIDGE_VERSION__',version).replace('__RECONNECT__','0');await fs.writeFile(script,template);
        const environment={...process.env,TMPDIR:root,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'.config'),INSTALL_DIR:install,BASE_URL:origin+'/api/bridge',SITE_URL:origin,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',INSTALLER_FIXTURE_EVENTS:path.join(root,'cli-events'),INSTALLER_FIXTURE_CONTEXTS:path.join(root,'cli-contexts')};
        for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','NODE_OPTIONS','NODE_USE_ENV_PROXY','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED'])delete environment[key];
        const run=async(overrides,{reconnect=false}={})=>{let source=script;if(reconnect){source=path.join(root,'install-reconnect.sh');await fs.writeFile(source,template.replace("RECONNECT='0'","RECONNECT='1'"));}try{const result=await exec('bash',[source],{env:{...environment,...overrides},encoding:'utf8',timeout:15000,maxBuffer:1024*1024});return{status:0,...result};}catch(error){if(typeof error.code!=='number')throw error;return{status:error.code,stdout:error.stdout,stderr:error.stderr};}};
        const runConnect=async(overrides={}, {reconnect=false}={})=>{const source=path.join(root,'connect.sh'),text=(await readBridgeTemplate(process.env.BRIDGE_CONNECT_TEST_TEMPLATE||path.join(repository,'bridge-dist/connect.sh'))).replace('__BASE_URL__',overrides.BASE_URL??origin+'/api/bridge').replace('__SITE_URL__',overrides.SITE_URL??origin).replace('__BRIDGE_VERSION__',version).replace('__RECONNECT__',reconnect?'1':'0');await fs.writeFile(source,text);try{const result=await exec('bash',[source],{env:{...environment,...overrides},encoding:'utf8',timeout:15000,maxBuffer:1024*1024});return{status:0,...result};}catch(error){if(typeof error.code!=='number')throw error;return{status:error.code,stdout:error.stdout,stderr:error.stderr};}};
        const stateDirectory=env=>path.join(env.NEUROCENTER_BRIDGE_HOME||path.join(env.HOME,'.config/neurocenter/bridge'),sha(env.NEUROCENTER_URL||origin).slice(0,20));
        /** Separate delivery/API origin: pairing rejects old authorization; identity requires its own admitted token. */
        const startIssuer=async()=>{
            if(issuerOrigin)return issuerOrigin;
            issuer=http.createServer((request,response)=>{
                const route=request.url;state.issuerRequests.push({method:request.method,route,authorization:!!request.headers.authorization});request.resume();
                if(request.method==='POST'&&route==='/api/device-channel/pair/start'){if(request.headers.authorization){response.writeHead(403).end('{}');return;}response.end('{"deviceCode":"own-issuer-device","userCode":"OWN-ISSUER","expiresIn":600}');return;}
                if(request.method==='POST'&&route==='/api/device-channel/identity'&&state.issuerToken&&request.headers.authorization==='Bearer '+state.issuerToken){response.end('{"id":"own-issuer-paired-device"}');return;}
                if(request.method!=='GET'||![`/api/bridge/runtime/${filename}`,`/api/bridge/runtime/${filename}.sha256`].includes(route)){response.writeHead(403).end('{}');return;}
                const upstream=http.get(origin+route,incoming=>{response.writeHead(incoming.statusCode??502,incoming.headers);incoming.once('error',()=>response.destroy());incoming.pipe(response);});
                issuerRequests.add(upstream);upstream.setTimeout(2500,()=>upstream.destroy(new Error('Own issuer proxy timeout')));
                upstream.once('close',()=>issuerRequests.delete(upstream));upstream.once('error',()=>{if(!response.headersSent)response.writeHead(502);response.end();});
                response.once('close',()=>upstream.destroy());
            });
            await new Promise((resolve,reject)=>{issuer.once('error',reject);issuer.listen(0,'127.0.0.1',resolve);});
            issuerOrigin='http://127.0.0.1:'+issuer.address().port;return issuerOrigin;
        };
        const startWorker=async(extra={})=>{
            const env={...environment,NEUROCENTER_URL:origin,NEUROCENTER_API_URL:origin,...extra},directory=stateDirectory(env);
            state.workerDirectories.push(directory);await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'credentials.json'),JSON.stringify({token:'owned-worker-token',deviceId:'owned'}));
            const child=spawn(process.execPath,[path.join(install,'dist/index.js'),'--worker'],{env,stdio:'ignore'});state.workers.push({pid:child.pid,entry:path.join(install,'dist/index.js')});
            const deadline=Date.now()+3000;for(;;){const marker=await fs.readFile(path.join(directory,'worker-version.json'),'utf8').then(JSON.parse,()=>undefined);if(marker?.pid===child.pid){process.kill(child.pid,0);return{pid:child.pid,directory};}if(Date.now()>deadline)throw Error('Own worker did not become ready');await new Promise(r=>setTimeout(r,20));}
        };
        await action({root,home,install,state,run,runConnect,environment,version,origin,startWorker,startIssuer});
    }finally{
        const connectStages=(await fs.readdir(root).catch(()=>[])).filter(name=>name.startsWith('neurocenter-connect.'));
        let installedVersion,oldRuntime=false;
        try{installedVersion=JSON.parse(await fs.readFile(path.join(install,'package.json'),'utf8')).version;}catch{}
        try{oldRuntime=(await fs.readFile(path.join(install,'previous.txt'),'utf8'))==='owned old runtime';}catch{}
        try{state.cli=(await fs.readFile(path.join(root,'cli-events'),'utf8')).trim().split('\n');}catch{}
        try{state.contexts=(await fs.readFile(path.join(root,'cli-contexts'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));}catch{}
        for(const directory of state.workerDirectories){const marker=await fs.readFile(path.join(directory,'worker-version.json'),'utf8').then(JSON.parse,()=>undefined);if(marker?.pid&&!state.workers.some(w=>w.pid===marker.pid))state.workers.push({pid:marker.pid,entry:path.join(install,'dist/index.js')});}
        for(const item of state.workers){
            let command;try{command=(await exec('ps',['-p',String(item.pid),'-o','uid=','-o','args='],{timeout:1500})).stdout.trim();}catch(error){if(error.code===1){item.exited=true;continue;}throw error;}
            assert.match(command,new RegExp('^'+process.getuid()+'\\s+'));assert.ok(command.endsWith(item.entry+' --worker'));process.kill(item.pid,'SIGTERM');
            const deadline=Date.now()+3000;for(;;){try{process.kill(item.pid,0);}catch(error){if(error.code==='ESRCH'){item.exited=true;break;}throw error;}if(Date.now()>deadline)throw Error('Owned worker did not terminate');await new Promise(r=>setTimeout(r,20));}
        }
        for(const request of issuerRequests)request.destroy();
        if(issuer?.listening){issuer.closeAllConnections();await new Promise(resolve=>issuer.close(resolve));}
        if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
        await fs.rm(root,{recursive:true,force:true});
        proofs.push({name,connectStages,paused:state.paused,requests:state.requests,issuerRequests:state.issuerRequests,cli:state.cli,contexts:state.contexts,workers:state.workers,installedVersion,oldRuntime,temporaryRemoved:await fs.stat(root).then(()=>false,error=>error.code==='ENOENT'),serverClosed:!server?.listening,issuerClosed:!issuer?.listening});
        if(process.env.BRIDGE_INSTALLER_LIFECYCLE_EVIDENCE)await fs.writeFile(process.env.BRIDGE_INSTALLER_LIFECYCLE_EVIDENCE,JSON.stringify(proofs,null,2)+'\n',{mode:0o600});
    }
}
