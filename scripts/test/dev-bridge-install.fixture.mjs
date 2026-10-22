import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {updateInstalledDevBridge} from '../workspace/dev-bridge-install.mjs';
import {opencodeVersion} from '../opencode-platforms.mjs';

const exec=promisify(execFile),root=fileURLToPath(new URL('../../',import.meta.url)),bridge=path.join(root,'mcp/neurocenter-asset-sync');
const jsonc=createRequire(path.join(bridge,'package.json'))('jsonc-parser'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const version='0.9.18',target=`${process.platform==='win32'?'windows':process.platform}-${process.arch}${process.platform==='linux'&&!process.report.getReport().header.glibcVersionRuntime?'-musl':''}`;
const modules=['lib/install.js','lib/global-config-lock.js','bridge/state.js','bridge/read-bounded.js','bridge/atomic-file.js','bridge/cli.js','bridge/protocol.js','bridge/worker-upgrade.js','bridge-cli.js'];
async function fixture(action,{paired=true,legacy=false}={}){
    const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-dev-bridge-update-')));
    try{
        const home=path.join(directory,'home'),install=path.join(home,'own bridge'),content=path.join(directory,'package'),output=path.join(directory,'runtime');
        for(const folder of [install,path.join(content,'bin'),output,path.join(home,'.config/opencode'),path.join(home,'.local/bin')])await fs.mkdir(folder,{recursive:true});
        await fs.writeFile(path.join(content,'package.json'),JSON.stringify({name:'neurocenter-asset-sync',version,type:'module'}));
        for(const module of modules){const to=path.join(content,'dist',module);await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(path.join(bridge,'dist',module),to);}
        await fs.writeFile(path.join(content,'dist/bridge/connect.js'),'export async function connectBridge(){throw Error("pair/connect forbidden in updater fixture");}\n');
        // A tiny wrapper avoids copying/compressing a native Node binary per unit case; model its installed execPath explicitly.
        await fs.writeFile(path.join(content,'dist/index.js'),`import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {installBridgeGlobal} from './lib/install.js';import {stateDir,writeState} from './bridge/state.js';
process.execPath=fileURLToPath(new URL('../bin/node',import.meta.url));
if(!process.env.BRIDGE_FIXTURE_OWN_NETWORK)globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN_IN_FIXTURE');};
if(['--prepare-upgrade','--finish-upgrade'].includes(process.argv[2])){try{const {prepareWorkerUpgrade,finishWorkerUpgrade}=await import('./bridge/worker-upgrade.js');const result=process.argv[2]==='--prepare-upgrade'?await prepareWorkerUpgrade(process.argv[3]):await finishWorkerUpgrade();console.log(JSON.stringify({ok:true,...result}));}catch(error){console.log(JSON.stringify({ok:false,error:error.message}));process.exit(1);}}
else if(process.argv[2]==='--init')console.log(JSON.stringify({ok:true,...await installBridgeGlobal()}));
else if(process.argv[2]==='--worker'){
 const build=JSON.parse(await fs.readFile(new URL('./build.json',import.meta.url),'utf8'));
 if(process.env.BRIDGE_FIXTURE_EXIT_BUILD===build.buildId)process.exit(7);
 await fs.mkdir(stateDir(),{recursive:true,mode:0o700});const lock=path.join(stateDir(),'worker.lock');
 const handle=await fs.open(lock,'wx',0o600);await handle.writeFile(String(process.pid));await handle.close();
 await writeState('worker-version',{pid:process.pid,version:build.version,buildId:build.buildId,fixtureHome:process.env.HOME,fixtureCwd:process.cwd()});
 process.once('SIGTERM',()=>{void fs.readFile(lock,'utf8').then(value=>value===String(process.pid)?fs.unlink(lock):undefined).finally(()=>process.exit(0));});
 setTimeout(()=>process.exit(98),15000);setInterval(()=>{},1000);
}else throw Error('unexpected fixture CLI');\n`);
        await fs.cp(path.join(bridge,'node_modules/jsonc-parser'),path.join(content,'node_modules/jsonc-parser'),{recursive:true});
        const nodeFile=path.join(content,'bin',process.platform==='win32'?'node.exe':'node');
        await fs.writeFile(nodeFile,`#!/bin/sh\nexec '${process.execPath.replace(/'/g,"'\"'\"'")}' "$@"\n`,{mode:0o755});
        const build=createHash('sha256');for(const file of(await fs.readdir(path.join(content,'dist'),{recursive:true})).sort())if((await fs.stat(path.join(content,'dist',file))).isFile()){build.update(file.split(path.sep).join('/')+'\0');build.update(await fs.readFile(path.join(content,'dist',file)));}
        const buildId=build.digest('hex');await fs.writeFile(path.join(content,'dist/build.json'),JSON.stringify({version,buildId}));
        await fs.writeFile(path.join(content,'runtime.json'),JSON.stringify({version,buildId,target,nodeVersion:process.versions.node}));
        const archive=path.join(output,`neurocenter-asset-sync-${target}-${version}.tgz`);
        async function pack(){
            await exec('tar',['-czf',archive,'-C',content,'bin','dist','node_modules','package.json','runtime.json'],{env:{...process.env,COPYFILE_DISABLE:'1'},timeout:20000});
            const bytes=await fs.readFile(archive),metadata={version,buildId,target,nodeVersion:process.versions.node,ragSupported:true,probeEngine:{version:opencodeVersion},bytes:bytes.length,sha256:sha(bytes)};
            await fs.writeFile(archive+'.json',JSON.stringify(metadata));await fs.writeFile(archive+'.sha256',metadata.sha256+'\n');
        }
        await pack();await fs.writeFile(path.join(install,'package.json'),JSON.stringify({name:'neurocenter-asset-sync',version}));
        await fs.mkdir(path.join(install,'dist'));await fs.writeFile(path.join(install,'dist/index.js'),'old entry');await fs.writeFile(path.join(install,'dist/build.json'),JSON.stringify({version,buildId:'a'.repeat(64)}));await fs.writeFile(path.join(install,'keep.txt'),'old runtime');
        const stateHome=path.join(home,'bridge-state'),state=path.join(stateHome,sha('https://saved-site.example.test').slice(0,20));await fs.mkdir(state,{recursive:true,mode:0o700});
        const credentials=JSON.stringify({token:'fixture-owned-key',deviceId:'owned-device',email:'owner@test'});if(paired)await fs.writeFile(path.join(state,'credentials.json'),credentials,{mode:0o600});await fs.writeFile(path.join(state,'workspace.json'),'{"root":"saved-root","bindings":{"p":"folder"}}',{mode:0o600});
        const config=path.join(home,'.config/opencode/opencode.jsonc'),entry={type:'local',enabled:false,command:['old-node',path.join(install,'dist/index.js')],environment:{NEUROCENTER_URL:'https://saved-site.example.test',NEUROCENTER_API_URL:'https://saved-api.example.test',NEUROCENTER_BRIDGE_HOME:stateHome,CUSTOM_SETTING:'preserve me'}};
        const original='// user comment remains\n'+JSON.stringify({model:'user-model',agent:{external:{description:'do not replace'}},mcp:{other:{type:'remote',url:'https://other.test'},'neurocenter-asset-sync':entry}},null,2)+'\n';await fs.writeFile(config,original,{mode:0o640});
        if(!legacy)await fs.writeFile(path.join(install,'installation.json'),JSON.stringify({schemaVersion:1,siteUrl:entry.environment.NEUROCENTER_URL,apiUrl:entry.environment.NEUROCENTER_API_URL}),{mode:0o600});
        const launcher=path.join(home,'.local/bin/neurocenter-bridge');await fs.writeFile(launcher,'#!/bin/sh\n# Neurocenter bridge command v1\necho old\n',{mode:0o755});const originalLauncher=await fs.readFile(launcher,'utf8');
        const environment={...process.env,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'.config'),INSTALL_DIR:install,NEUROCENTER_URL:'http://localhost:5173',NEUROCENTER_API_URL:'http://localhost:4000'};
        delete environment.NODE_OPTIONS;delete environment.NEUROCENTER_BRIDGE_HOME;
        const events=[],starts=[],options={root,archive,version,buildId,target,environment};
        const dependencies={runCommand:async(command,args,env,timeout)=>{
            events.push({command,args,site:env.NEUROCENTER_URL,api:env.NEUROCENTER_API_URL,timeout});
            if(args[0]==='--version')return'v24.22.0\n';if(args[0]==='-p')return process.platform+':'+process.arch;
            if(args[1]==='--prepare-upgrade')return JSON.stringify({ok:true,paused:paired});if(args[1]==='--finish-upgrade')return'{"ok":true}';
            return(await exec(command,args,{env,timeout,maxBuffer:1024*1024})).stdout;
        },startWorker:(location,env)=>{
            assert.equal(location,install);assert.equal(env.NEUROCENTER_URL,entry.environment.NEUROCENTER_URL);assert.equal(env.NEUROCENTER_BRIDGE_HOME,stateHome);
            const info=JSON.parse(readFileSync(path.join(location,'dist/build.json'))),pid=77000+starts.length;starts.push(info.buildId);
            assert.throws(()=>readFileSync(install+'.install-lock/owner.pid'),{code:'ENOENT'});mkdirSync(state,{recursive:true});writeFileSync(path.join(state,'worker.lock'),String(pid));writeFileSync(path.join(state,'worker-version.json'),JSON.stringify({pid,version,buildId:info.buildId}));return{pid,alive:()=>true};
        }};
        await action({directory,home,install,content,archive,pack,config,original,launcher,originalLauncher,environment,options,dependencies,events,starts,state,credentials,entry,buildId});
    }finally{await fs.rm(directory,{recursive:true,force:true});}
}
const update=f=>updateInstalledDevBridge(f.options,f.dependencies);
async function unchanged(f){assert.equal(await fs.readFile(path.join(f.install,'keep.txt'),'utf8'),'old runtime');assert.equal(await fs.readFile(f.config,'utf8'),f.original);assert.equal(await fs.readFile(f.launcher,'utf8'),f.originalLauncher);}

export {fixture,update,unchanged,jsonc,sha,version,target,root,bridge,modules};
