import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {execFile,spawn} from 'node:child_process';
import nativeFs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {prepareDevBridge} from '../workspace/dev-bridge-runtime.mjs';
import {fixture,update,unchanged,jsonc} from './dev-bridge-install.fixture.mjs';
const execute=promisify(execFile);
function loopbackEnvironment(environment){
    assert.equal(new URL(environment.NEUROCENTER_API_URL).hostname,'127.0.0.1');
    const result={...environment,BRIDGE_FIXTURE_OWN_NETWORK:'1'};
    for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','NODE_USE_ENV_PROXY','NODE_OPTIONS','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED','SSL_CERT_FILE','SSL_CERT_DIR'])delete result[key];
    return result;
}

async function savedApi(f,origin){
    f.entry.environment.NEUROCENTER_API_URL=origin;
    await fs.writeFile(f.config,jsonc.applyEdits(f.original,jsonc.modify(f.original,['mcp','neurocenter-asset-sync'],f.entry,{})));
    await fs.writeFile(path.join(f.install,'installation.json'),JSON.stringify({schemaVersion:1,siteUrl:f.entry.environment.NEUROCENTER_URL,apiUrl:origin}));
    return await fs.readFile(f.config,'utf8');
}
async function fakeCheckout(f){
    const root=path.join(f.directory,'checkout'),bridge=path.join(root,'mcp/neurocenter-asset-sync');
    await fs.mkdir(path.join(root,'.git/refs/heads'),{recursive:true});await fs.mkdir(path.join(root,'.git/objects'));await fs.writeFile(path.join(root,'.git/HEAD'),'ref: refs/heads/main\n');await fs.writeFile(path.join(root,'.git/refs/heads/main'),'1'.repeat(40)+'\n');
    await fs.mkdir(bridge,{recursive:true});await fs.writeFile(path.join(bridge,'package.json'),JSON.stringify({version:f.options.version}));
    const run=async(_node,args,options)=>{
        if(path.basename(args[0])==='build.mjs')await fs.cp(path.join(f.content,'dist'),path.join(bridge,'dist'),{recursive:true});
        if(path.basename(args[0])==='package-bridge-runtime.mjs')for(const suffix of['','.json','.sha256'])await fs.copyFile(f.archive+suffix,path.join(options.env.BRIDGE_RUNTIME_OUTPUT_DIR,path.basename(f.archive))+suffix);
    };
    return{root,run};
}

test('Install publishes a verified supply with a real refused API while leaving the paired installation untouched',async()=>fixture(async f=>{
    const reserved=http.createServer();await new Promise(resolve=>reserved.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+reserved.address().port;await new Promise(resolve=>reserved.close(resolve));
    const original=await savedApi(f,origin),checkout=await fakeCheckout(f),output=[];
    const result=await prepareDevBridge({...checkout,node:process.execPath,environment:{...f.environment,BRIDGE_FIXTURE_OWN_NETWORK:'1'},output:{info:(...value)=>output.push(value),success:value=>output.push(value)}});
    assert.equal(result.installed.updated,false);assert.equal(result.installed.reason,'server-start-pending');assert.ok(output.flat().some(value=>/после запуска сервера/i.test(value)));
    const pointer=JSON.parse(await fs.readFile(path.join(checkout.root,'.run/dev-bridge/runtime/current.json'),'utf8'));await fs.access(path.join(checkout.root,'.run/dev-bridge/runtime',pointer.directory,path.basename(f.archive)));
    assert.equal(await fs.readFile(f.config,'utf8'),original);assert.equal(await fs.readFile(path.join(f.install,'keep.txt'),'utf8'),'old runtime');assert.equal(await fs.readFile(f.launcher,'utf8'),f.originalLauncher);assert.equal(await fs.readFile(path.join(f.state,'credentials.json'),'utf8'),f.credentials);
}));
test('A real failed prepare with an unacknowledged native resume is compensated even after CLI ok:false',async()=>fixture(async f=>{
    let paused=false,resumes=0;const server=http.createServer((request,response)=>{request.resume();if(request.url.endsWith('/worker/pause')){paused=true;response.end('{"activeJobs":"invalid"}');}else if(request.url.endsWith('/worker/resume')){if(++resumes===1){response.writeHead(503).end('{}');}else{paused=false;response.end('{"ok":true}');}}else response.writeHead(404).end();});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
        const original=await savedApi(f,'http://127.0.0.1:'+server.address().port),run=f.dependencies.runCommand;
        f.dependencies.runCommand=async(command,args,environment,timeout)=>['--prepare-upgrade','--finish-upgrade'].includes(args[1])?(await execute(command,args,{env:loopbackEnvironment(environment),timeout,encoding:'utf8'})).stdout:run(command,args,environment,timeout);
        await assert.rejects(update(f),/состояние очереди/);assert.equal(paused,false,'CLI rejection does not prove that the native finally resumed its admitted pause');assert.equal(resumes,2);
        assert.equal(await fs.readFile(f.config,'utf8'),original);assert.equal(await fs.readFile(path.join(f.install,'keep.txt'),'utf8'),'old runtime');assert.equal(await fs.readFile(f.launcher,'utf8'),f.originalLauncher);assert.equal(await fs.readFile(path.join(f.state,'credentials.json'),'utf8'),f.credentials);assert.equal(f.starts.length,0);
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}));

async function published(f){
    const checkout=await fakeCheckout(f);await prepareDevBridge({...checkout,environment:f.environment});
    const pointer=path.join(checkout.root,'.run/dev-bridge/runtime/current.json');return{...checkout,pointer};
}
async function startup(f,checkout,updateInstalled){
    const messages=[],{applyPublishedDevBridge}=await import('../workspace/dev-bridge-startup.mjs');
    const result=await applyPublishedDevBridge({root:checkout.root,environment:f.environment,output:{info:(...x)=>messages.push(['info',...x]),warning:x=>messages.push(['warning',x])}},{updateInstalled});
    return{result,messages};
}

test('Startup applies the retained generation transaction, preserves pairing, and skips only the exact installed archive on repeat',async()=>fixture(async f=>{
    const checkout=await published(f);let calls=0;const apply=async options=>{calls++;return(await import('../workspace/dev-bridge-install.mjs')).updateInstalledDevBridge(options,f.dependencies);};
    assert.equal((await startup(f,checkout,apply)).result.updated,true);const installed=JSON.parse(await fs.readFile(path.join(f.install,'.neurocenter-dev-supply.json'),'utf8'));
    assert.equal(installed.schemaVersion,1);assert.equal(installed.buildId,f.buildId);assert.equal(Object.keys(installed).sort().join(','),'buildId,schemaVersion,sha256,target,version');assert.equal((await fs.stat(path.join(f.install,'.neurocenter-dev-supply.json'))).mode&0o777,0o600);
    const second=await startup(f,checkout,apply);assert.equal(second.result.updated,false);assert.equal(second.result.reason,'already-current');assert.equal(calls,1);assert.equal(await fs.readFile(path.join(f.state,'credentials.json'),'utf8'),f.credentials);assert.equal(jsonc.parse(await fs.readFile(f.config,'utf8')).mcp['neurocenter-asset-sync'].enabled,false);
}));
test('A dependency-only new archive with the same source build is applied instead of mistaken for an already-current runtime',async()=>fixture(async f=>{
    const checkout=await published(f);let calls=0;const apply=async options=>{calls++;return(await import('../workspace/dev-bridge-install.mjs')).updateInstalledDevBridge(options,f.dependencies);};
    assert.equal((await startup(f,checkout,apply)).result.updated,true);const previous=JSON.parse(await fs.readFile(path.join(f.install,'.neurocenter-dev-supply.json'),'utf8'));
    await fs.writeFile(path.join(f.content,'node_modules/owned-dependency-change.txt'),'dependency-only generation');await f.pack();await prepareDevBridge({...checkout,environment:f.environment});
    assert.equal((await startup(f,checkout,apply)).result.updated,true);const current=JSON.parse(await fs.readFile(path.join(f.install,'.neurocenter-dev-supply.json'),'utf8'));
    assert.equal(current.buildId,previous.buildId);assert.notEqual(current.sha256,previous.sha256);assert.equal(calls,2);assert.equal(await fs.readFile(path.join(f.install,'node_modules/owned-dependency-change.txt'),'utf8'),'dependency-only generation');
}));
test('A failed optional startup update warns, preserves the old installation and pointer, and is retried on the next startup',async()=>fixture(async f=>{
    const checkout=await published(f),pointer=await fs.readFile(checkout.pointer,'utf8');let calls=0;
    const failure=await startup(f,checkout,async()=>{calls++;throw Error('owned API refused');});assert.equal(failure.result.updated,false);assert.equal(failure.result.reason,'update-deferred');assert.match(failure.messages[0][1],/Сервисы продолжают работать/);await unchanged(f);assert.equal(await fs.readFile(checkout.pointer,'utf8'),pointer);
    const retry=await startup(f,checkout,async options=>{calls++;return(await import('../workspace/dev-bridge-install.mjs')).updateInstalledDevBridge(options,f.dependencies);});assert.equal(retry.result.updated,true);assert.equal(calls,2);assert.equal(await fs.readFile(path.join(f.state,'credentials.json'),'utf8'),f.credentials);
}));
for(const [label,mutate]of[
    ['traversal',value=>value.directory='../outside'],['host',value=>value.target='foreign-x64'],['source checkpoint',value=>value.sourceCommit='bad'],['array checkpoint',value=>value.sourceCommit=['1'.repeat(40)]],['digest',value=>value.buildId='b'.repeat(64)],
])test('A tampered '+label+' pointer is re-read and refused before any installed mutation',async()=>fixture(async f=>{
    const checkout=await published(f);let calls=0;const observed=await startup(f,checkout,async()=>{calls++;return{updated:false,reason:'model-only'};});assert.equal(observed.result.reason,'model-only');assert.equal(calls,1);
    const value=JSON.parse(await fs.readFile(checkout.pointer,'utf8'));mutate(value);await fs.writeFile(checkout.pointer,JSON.stringify(value));
    const result=await startup(f,checkout,async()=>{calls++;throw Error('must not be admitted');});assert.equal(result.result.reason,'update-deferred');assert.equal(calls,1);await unchanged(f);
}));
for(const part of['generation','archive','checkout-dist'])test('A changed '+part+' fails closed before the optional updater',async()=>fixture(async f=>{
    const checkout=await published(f),pointer=JSON.parse(await fs.readFile(checkout.pointer,'utf8')),generation=path.join(path.dirname(checkout.pointer),pointer.directory);
    if(part==='generation'){const foreign=path.join(f.directory,'foreign-generation');await fs.rename(generation,foreign);await fs.symlink(foreign,generation);}
    else if(part==='archive')await fs.appendFile(path.join(generation,path.basename(f.archive)),'corrupt extra bytes');
    else await fs.appendFile(path.join(checkout.root,'mcp/neurocenter-asset-sync/dist/index.js'),'\n// source changed after install');
    let calls=0;const result=await startup(f,checkout,async()=>{calls++;});assert.equal(result.result.reason,'update-deferred');assert.equal(calls,0);await unchanged(f);
}));
for(const part of['receipt','receipt-sha-array','dist','dist-link','runtime'])test('Tampered installed '+part+' is never reported as a successful repeat no-op',async()=>fixture(async f=>{
    const checkout=await published(f);assert.equal((await startup(f,checkout,options=>(import('../workspace/dev-bridge-install.mjs').then(m=>m.updateInstalledDevBridge(options,f.dependencies))))).result.updated,true);
    if(part==='receipt')await fs.writeFile(path.join(f.install,'.neurocenter-dev-supply.json'),'{"schemaVersion":999}');
    else if(part==='receipt-sha-array'){const file=path.join(f.install,'.neurocenter-dev-supply.json'),value=JSON.parse(await fs.readFile(file,'utf8'));value.sha256=[value.sha256];await fs.writeFile(file,JSON.stringify(value));}
    else if(part==='runtime')await fs.writeFile(path.join(f.install,'runtime.json'),'{"target":"foreign"}');
    else if(part==='dist-link'){const foreign=path.join(f.directory,'foreign-dist');await fs.rename(path.join(f.install,'dist'),foreign);await fs.symlink(foreign,path.join(f.install,'dist'));}
    else await fs.appendFile(path.join(f.install,'dist/index.js'),'\n// user modified installed source');
    let calls=0;const result=await startup(f,checkout,async()=>{calls++;});assert.equal(calls,0);assert.equal(result.result.reason,'update-deferred');assert.equal(result.result.updated,false);assert.equal(await fs.readFile(path.join(f.state,'credentials.json'),'utf8'),f.credentials);
}));

test('A newer valid checkout source build is not overwritten by an older prepared generation',async()=>fixture(async f=>{
    const checkout=await published(f),dist=path.join(checkout.root,'mcp/neurocenter-asset-sync/dist');await fs.appendFile(path.join(dist,'index.js'),'\n// new built source');
    const digest=createHash('sha256');for(const file of(await fs.readdir(dist,{recursive:true})).sort())if(file!=='build.json'&&(await fs.stat(path.join(dist,file))).isFile()){digest.update(file.split(path.sep).join('/')+'\0');digest.update(await fs.readFile(path.join(dist,file)));}
    await fs.writeFile(path.join(dist,'build.json'),JSON.stringify({version:f.options.version,buildId:digest.digest('hex')}));
    let calls=0;const result=await startup(f,checkout,async()=>{calls++;});assert.equal(result.result.reason,'update-deferred');assert.match(result.messages[0][1],/старее текущей сборки/);assert.equal(calls,0);await unchanged(f);
}));
test('A missing checkout build defers the update visibly until install is repeated',async()=>fixture(async f=>{
    const checkout=await published(f);await fs.rm(path.join(checkout.root,'mcp/neurocenter-asset-sync/dist'),{recursive:true});let calls=0;
    const result=await startup(f,checkout,async()=>{calls++;});assert.equal(result.result.reason,'update-deferred');assert.match(result.messages[0][1],/scripts\/dev.sh install/);assert.equal(calls,0);await unchanged(f);
}));
test('No prepared supply is a read-only no-op with no installed migration attempt',async()=>fixture(async f=>{
    const checkout={root:path.join(f.directory,'empty-checkout')};await fs.mkdir(checkout.root);let calls=0;
    const result=await startup(f,checkout,async()=>{calls++;});assert.equal(result.result.reason,'no-supply');assert.equal(calls,0);assert.deepEqual(await fs.readdir(checkout.root),[]);await unchanged(f);
}));
test('A pointer change during archive validation refuses admission instead of using a remembered generation',async t=>fixture(async f=>{
    const checkout=await published(f),pointer=JSON.parse(await fs.readFile(checkout.pointer,'utf8')),archive=path.join(path.dirname(checkout.pointer),pointer.directory,path.basename(f.archive)),stat=fs.lstat;let changed=false,calls=0;
    const hook=t.mock.method(fs,'lstat',async(file,...args)=>{const value=await stat(file,...args);if(file===archive&&!changed){changed=true;await fs.writeFile(checkout.pointer,JSON.stringify({...pointer,sourceCommit:'2'.repeat(40)}));}return value;});
    try{const result=await startup(f,checkout,async()=>{calls++;});assert.equal(changed,true);assert.equal(result.result.reason,'update-deferred');assert.equal(calls,0);await unchanged(f);}finally{hook.mock.restore();}
}));
test('A pointer change during installed-build verification cannot report an outdated no-op',async t=>fixture(async f=>{
    const checkout=await published(f);assert.equal((await startup(f,checkout,options=>(import('../workspace/dev-bridge-install.mjs').then(m=>m.updateInstalledDevBridge(options,f.dependencies))))).result.updated,true);
    const pointer=JSON.parse(await fs.readFile(checkout.pointer,'utf8')),entry=path.join(f.install,'dist/index.js'),stat=fs.lstat;let changed=false,calls=0;
    const hook=t.mock.method(fs,'lstat',async(file,...args)=>{const value=await stat(file,...args);if(file===entry&&!changed){changed=true;await fs.writeFile(checkout.pointer,JSON.stringify({...pointer,sourceCommit:'3'.repeat(40)}));}return value;});
    try{const result=await startup(f,checkout,async()=>{calls++;});assert.equal(changed,true);assert.equal(result.result.reason,'update-deferred');assert.equal(calls,0);assert.equal(await fs.readFile(path.join(f.state,'credentials.json'),'utf8'),f.credentials);}finally{hook.mock.restore();}
}));
test('A linked current pointer refuses admission without touching the installed profile',async()=>fixture(async f=>{
    const checkout=await published(f),foreign=path.join(f.directory,'foreign-pointer.json');await fs.rename(checkout.pointer,foreign);await fs.symlink(foreign,checkout.pointer);let calls=0;
    const result=await startup(f,checkout,async()=>{calls++;});assert.equal(result.result.reason,'update-deferred');assert.equal(calls,0);await unchanged(f);
}));

test('A dead stale marker cannot authorize restarting a worker that was not running before prepare',async()=>fixture(async f=>{
    const child=spawn(process.execPath,['-e',''],{stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.throws(()=>process.kill(child.pid,0),error=>error.code==='ESRCH');
    await fs.writeFile(path.join(f.state,'worker.lock'),String(child.pid));await fs.writeFile(path.join(f.state,'worker-version.json'),JSON.stringify({pid:child.pid,version:f.options.version,buildId:'a'.repeat(64)}));
    const server=http.createServer((request,response)=>{request.resume();response.end(request.url.endsWith('/worker/pause')?'{"activeJobs":"invalid"}':'{"ok":true}');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
        const original=await savedApi(f,'http://127.0.0.1:'+server.address().port),run=f.dependencies.runCommand;
        f.dependencies.runCommand=async(command,args,environment,timeout)=>['--prepare-upgrade','--finish-upgrade'].includes(args[1])?(await execute(command,args,{env:loopbackEnvironment(environment),timeout,encoding:'utf8'})).stdout:run(command,args,environment,timeout);
        await assert.rejects(update(f),/состояние очереди/);assert.equal(f.starts.length,0,'A stale PID marker is not proof that preparation stopped an owned running worker');assert.equal(await fs.readFile(f.config,'utf8'),original);assert.equal(await fs.readFile(path.join(f.state,'credentials.json'),'utf8'),f.credentials);
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}));
test('An oversized sparse dev archive is refused before opening a hashing stream',async t=>fixture(async f=>{
    const checkout=await published(f),pointer=JSON.parse(await fs.readFile(checkout.pointer,'utf8')),archive=path.join(path.dirname(checkout.pointer),pointer.directory,path.basename(f.archive)),metadataFile=archive+'.json',metadata=JSON.parse(await fs.readFile(metadataFile,'utf8'));
    metadata.bytes=1024**3+1;await fs.truncate(archive,metadata.bytes);await fs.writeFile(metadataFile,JSON.stringify(metadata));let reads=0,calls=0;const create=nativeFs.createReadStream;
    const hook=t.mock.method(nativeFs,'createReadStream',function(file,...args){if(file===archive){reads++;throw Error('Owned oversized archive stream tripwire');}return create.call(this,file,...args);});syncBuiltinESMExports();
    try{const result=await startup(f,checkout,async()=>{calls++;});assert.equal(reads,0,'Reject oversized metadata before hashing even a sparse matching-length file');assert.equal(calls,0);assert.equal(result.result.reason,'update-deferred');await unchanged(f);}finally{hook.mock.restore();syncBuiltinESMExports();}
}));
