import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {installerLifecycleFixture} from './bridge-installer-lifecycle.fixture.mjs';
const exec=promisify(execFile),repository=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(import.meta.url),ts=require('../../mcp/neurocenter-asset-sync/node_modules/typescript');
const namespace=site=>createHash('sha256').update(site).digest('hex').slice(0,20);
const posts=rows=>rows.filter(row=>row.method==='POST');

/** Real current launcher generator and CLI/profile admission; only post-admission connect work is controlled. */
async function managedCustomProfile(f,{complex=false}={}){
    if(complex){const custom=path.join(f.root,"custom ' $(printf CUSTOM) `printf BACKTICK`");await fs.rename(f.install,custom);f.install=custom;}
    const directory=path.join(f.install,'dist/bridge');
    for(const name of ['cli','cli-profile']){
        const source=await fs.readFile(path.join(repository,'mcp/neurocenter-asset-sync/src/bridge',name+'.ts'),'utf8');
        await fs.writeFile(path.join(directory,name+'.js'),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
    }
    await fs.writeFile(path.join(directory,'connect.js'),`import fs from 'node:fs/promises';import path from 'node:path';import{createHash}from'node:crypto';
export async function connectBridge(){
 const site=process.env.NEUROCENTER_URL,api=process.env.NEUROCENTER_API_URL,base=process.env.NEUROCENTER_BRIDGE_HOME;
 await fs.appendFile(process.env.INSTALLER_FIXTURE_EVENTS,'--connect-open\\n');
 await fs.appendFile(process.env.INSTALLER_FIXTURE_CONTEXTS,JSON.stringify({mode:'--connect-open',site,api,home:process.env.HOME,xdg:process.env.XDG_CONFIG_HOME})+'\\n');
 const namespace=createHash('sha256').update(site).digest('hex').slice(0,20);let token;
 try{token=JSON.parse(await fs.readFile(path.join(base,namespace,'credentials.json'),'utf8')).token;}catch(error){if(error.code!=='ENOENT')throw error;}
 const response=await fetch(api+'/api/device-channel/'+(token?'identity':'pair/start'),{method:'POST',body:'{}',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},signal:AbortSignal.timeout(1500)});
 if(!response.ok)throw Error('Owned HTTP fixture refusal');const result=await response.json();
 return token?{connected:true}:{url:site+'/start?step=1&connect='+result.userCode,code:result.userCode,expiresIn:result.expiresIn,browserOpened:false};
}
`);
    await fs.writeFile(path.join(f.install,'dist/bridge-cli.js'),"import{runBridgeCli}from'./bridge/cli.js';try{await runBridgeCli(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}\n");
    const savedHome=path.join(f.root,'saved-runtime-home'),bridgeHome=path.join(f.root,'saved-state'),config=path.join(f.environment.XDG_CONFIG_HOME,'opencode/opencode.jsonc');
    const document={agent:{keep:{mode:'subagent'}},mcp:{other:{type:'remote',url:'https://other.example.test'},'neurocenter-asset-sync':{type:'local',enabled:false,timeout:45000,command:[path.join(f.install,'bin/node'),path.join(f.install,'dist/index.js')],environment:{NEUROCENTER_URL:f.origin,NEUROCENTER_API_URL:f.origin,HOME:savedHome,NEUROCENTER_BRIDGE_HOME:bridgeHome,CUSTOM_SETTING:'keep'}}}};
    const text='// Own saved registration\n'+JSON.stringify(document,null,2)+'\n';await fs.mkdir(path.dirname(config),{recursive:true});await fs.writeFile(config,text);
    const credentials=path.join(bridgeHome,namespace(f.origin),'credentials.json'),bytes=Buffer.from(JSON.stringify({token:'owned-worker-token',deviceId:'owned'}));
    await fs.mkdir(path.dirname(credentials),{recursive:true});await fs.writeFile(credentials,bytes,{mode:0o600});f.state.token='owned-worker-token';
    const installer=path.join(f.root,'generate-launcher.mjs');await fs.writeFile(installer,`import{installBridgeCommand}from ${JSON.stringify(new URL('file://'+path.join(directory,'cli.js')).href)};console.log(await installBridgeCommand({directory:${JSON.stringify(f.install)},binDirectory:${JSON.stringify(path.join(f.home,'.local/bin'))}}));\n`);
    await exec(path.join(f.install,'bin/node'),[installer],{env:{...f.environment,NEUROCENTER_URL:f.origin,NEUROCENTER_API_URL:f.origin},timeout:5000});
    const launcher=path.join(f.home,'.local/bin/neurocenter-bridge'),source=await fs.readFile(launcher,'utf8');assert.ok(source.includes('# Neurocenter bridge command v1'));
    await assert.rejects(fs.stat(path.join(f.home,'.opencode/neurocenter-asset-sync')),{code:'ENOENT'});
    return{config,text,document,bridgeHome,credentials,bytes,launcher,source};
}

test('Exact generated launcher with spaces, apostrophe, dollar substitution and backticks is decoded without executing it',()=>installerLifecycleFixture('custom-root-complex-root',async f=>{
    const saved=await managedCustomProfile(f,{complex:true}),result=await f.runConnect({INSTALL_DIR:undefined,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.equal(result.status,0,result.stderr);
    assert.deepEqual(posts(f.state.requests).map(row=>[row.route,row.authorization]),[['/api/device-channel/identity',true]]);
    assert.equal(await fs.readFile(saved.config,'utf8'),saved.text);assert.deepEqual(await fs.readFile(saved.credentials),saved.bytes);assert.equal(f.state.requests.filter(row=>row.method==='GET').length,0);
    assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');
}));

test('The recovered custom root uses the existing guarded workflow for a genuinely different site',()=>installerLifecycleFixture('custom-root-custom-new-site',async f=>{
    const saved=await managedCustomProfile(f,{complex:true}),issuer=await f.startIssuer(),result=await f.runConnect({INSTALL_DIR:undefined,BASE_URL:issuer+'/api/bridge',SITE_URL:issuer,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.equal(result.status,0,result.stderr);
    const {parse}=createRequire(new URL('../../mcp/neurocenter-asset-sync/package.json',import.meta.url))('jsonc-parser');
    const expected=structuredClone(saved.document);Object.assign(expected.mcp['neurocenter-asset-sync'].environment,{NEUROCENTER_URL:issuer,NEUROCENTER_API_URL:issuer});
    assert.deepEqual(parse(await fs.readFile(saved.config,'utf8')),expected);assert.deepEqual(await fs.readFile(saved.credentials),saved.bytes);
    assert.deepEqual(posts(f.state.issuerRequests).map(row=>[row.route,row.authorization]),[['/api/device-channel/pair/start',false]]);assert.equal(f.state.requests.length,0);assert.equal(f.state.issuerRequests.filter(row=>row.method==='GET').length,0);
}));

test('A deleted custom runtime is reinstalled at the exact recovered path while its same-site disabled registration and credentials survive',()=>installerLifecycleFixture('custom-root-custom-deleted',async f=>{
    const saved=await managedCustomProfile(f,{complex:true});await fs.rm(f.install,{recursive:true});
    const result=await f.runConnect({INSTALL_DIR:undefined,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.equal(result.status,0,result.stderr);
    assert.equal(f.state.requests.filter(row=>row.method==='GET'&&row.route.startsWith('/api/bridge/install.sh')).length,1);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.install,'package.json'),'utf8')).version,f.version);
    assert.equal(await fs.readFile(saved.config,'utf8'),saved.text);assert.deepEqual(await fs.readFile(saved.credentials),saved.bytes);
    const calls=(await fs.readFile(f.environment.INSTALLER_FIXTURE_EVENTS,'utf8')).trim().split('\n');assert.equal(calls.includes('--init'),false);assert.equal(calls.filter(mode=>mode==='--connect-open').length,1);
    assert.deepEqual(posts(f.state.requests).map(row=>[row.route,row.authorization]),[['/api/device-channel/identity',true]]);
}));

for(const attack of ['foreign-marker','extra-exec','symlink','oversized','nul-suffix'])test('A '+attack+' launcher is refused as data without any command execution or HTTP',()=>installerLifecycleFixture('custom-root-refuse-'+attack,async f=>{
    const saved=await managedCustomProfile(f),sentinel=path.join(f.root,'must-not-execute');
    if(attack==='foreign-marker')await fs.writeFile(saved.launcher,saved.source.replace('Neurocenter bridge command v1','Neurocenter bridge command v2'));
    if(attack==='extra-exec')await fs.writeFile(saved.launcher,saved.source.replace('\nexec ',"\nexec /bin/sh -c 'printf ran > "+sentinel+"'\nexec "));
    if(attack==='symlink'){await fs.rename(saved.launcher,saved.launcher+'.owned');await fs.symlink(saved.launcher+'.owned',saved.launcher);}
    if(attack==='oversized')await fs.writeFile(saved.launcher,saved.source+'x'.repeat(65537));
    if(attack==='nul-suffix')await fs.writeFile(saved.launcher,Buffer.concat([Buffer.from(saved.source),Buffer.from([0]),Buffer.from('hidden')]));
    const result=await f.runConnect({INSTALL_DIR:undefined,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.notEqual(result.status,0,result.stdout);
    await assert.rejects(fs.stat(sentinel),{code:'ENOENT'});await assert.rejects(fs.stat(f.environment.INSTALLER_FIXTURE_EVENTS),{code:'ENOENT'});
    assert.equal(f.state.requests.length,0);assert.equal(f.state.issuerRequests.length,0);assert.equal(await fs.readFile(saved.config,'utf8'),saved.text);assert.deepEqual(await fs.readFile(saved.credentials),saved.bytes);
}));
