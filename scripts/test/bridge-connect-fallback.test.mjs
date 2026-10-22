import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {installerLifecycleFixture} from './bridge-installer-lifecycle.fixture.mjs';

const {parse}=createRequire(new URL('../../mcp/neurocenter-asset-sync/package.json',import.meta.url))('jsonc-parser');
const namespace=site=>createHash('sha256').update(site).digest('hex').slice(0,20);
const contexts=f=>fs.readFile(f.environment.INSTALLER_FIXTURE_CONTEXTS,'utf8').then(text=>text.trim().split('\n').map(JSON.parse));
const modes=f=>fs.readFile(f.environment.INSTALLER_FIXTURE_EVENTS,'utf8').then(text=>text.trim().split('\n'));
const posts=rows=>rows.filter(row=>row.method==='POST');
const gets=rows=>rows.filter(row=>row.method==='GET');

/** Disabled registration retains its caller config while runtime state lives in a different HOME. */
async function profile(f,{install=f.install,legacyApi=false}={}){
    const config=path.join(f.environment.XDG_CONFIG_HOME,'opencode/opencode.jsonc'),home=path.join(f.root,'saved HOME'),bridgeHome=path.join(f.root,'saved bridge state'),ca=path.join(f.root,'saved CA.pem');
    await fs.writeFile(ca,'');
    const environment={NEUROCENTER_URL:f.origin,...(legacyApi?{}:{NEUROCENTER_API_URL:f.origin}),HOME:home,XDG_CONFIG_HOME:path.join(home,'config'),NEUROCENTER_BRIDGE_HOME:bridgeHome,NODE_EXTRA_CA_CERTS:ca,HTTPS_PROXY:'http://127.0.0.1:1',CUSTOM_SETTING:'retain exact'};
    const document={agent:{existing:{mode:'subagent'}},model:'team/model',mcp:{other:{type:'remote',url:'https://other.example.test'},'neurocenter-asset-sync':{type:'local',enabled:false,timeout:45000,command:[path.join(install,'bin/node'),path.join(install,'dist/index.js')],environment}}};
    const text='// Keep existing OpenCode agents and comments\n'+JSON.stringify(document,null,2)+'\n// Keep trailing comment\n';
    await fs.mkdir(path.dirname(config),{recursive:true});await fs.writeFile(config,text);
    const credentials=path.join(bridgeHome,namespace(f.origin),'credentials.json'),bytes=Buffer.from(JSON.stringify({token:'owned-worker-token',deviceId:'owned'}));
    await fs.mkdir(path.dirname(credentials),{recursive:true});await fs.writeFile(credentials,bytes,{mode:0o600});f.state.token='owned-worker-token';
    return{config,text,document,home,bridgeHome,ca,credentials,bytes};
}
async function unchanged(saved){assert.equal(await fs.readFile(saved.config,'utf8'),saved.text);assert.deepEqual(await fs.readFile(saved.credentials),saved.bytes);}
function noDelivery(f){assert.equal(gets(f.state.requests).length,0);assert.equal(gets(f.state.issuerRequests).length,0);}
async function noRegistrationOrUpgrade(f){const calls=await modes(f);for(const forbidden of ['--init','--prepare-upgrade','--finish-upgrade'])assert.equal(calls.includes(forbidden),false,forbidden);}

test('Existing bundled runtime connects without a short launcher, installation or artifact download',()=>installerLifecycleFixture('connect-existing-bundle',async f=>{
    const install=path.join(f.home,'.opencode/neurocenter-asset-sync');await fs.mkdir(path.dirname(install),{recursive:true});await fs.rename(f.install,install);
    const saved=await profile(f,{install});await assert.rejects(fs.stat(path.join(f.home,'.local/bin/neurocenter-bridge')),{code:'ENOENT'});
    const result=await f.runConnect({INSTALL_DIR:undefined,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.equal(result.status,0,result.stderr);
    assert.deepEqual((await modes(f)).filter(mode=>mode==='--connect-open'),['--connect-open']);
    assert.deepEqual(posts(f.state.requests).map(row=>[row.route,row.authorization]),[['/api/device-channel/identity',true]]);
    await unchanged(saved);await noRegistrationOrUpgrade(f);noDelivery(f);
    assert.equal(await fs.readFile(path.join(install,'previous.txt'),'utf8'),'owned old runtime');
}));

test('Connection selects the saved HOME, CA and proxy while optional launcher repair uses caller HOME and XDG',()=>installerLifecycleFixture('connect-saved-environment',async f=>{
    const saved=await profile(f),result=await f.runConnect({INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.equal(result.status,0,result.stderr);
    const rows=await contexts(f),connect=rows.filter(row=>row.mode==='--connect-open');assert.equal(connect.length,1);
    assert.equal(connect[0].home,saved.home);assert.equal(connect[0].bridgeHome,saved.bridgeHome);assert.equal(connect[0].ca,saved.ca);assert.equal(connect[0].proxy,'http://127.0.0.1:1');
    assert.equal(connect[0].site,f.origin);assert.equal(connect[0].api,f.origin);
    const management=rows.filter(row=>row.mode==='--install-command');assert.equal(management.length,1);assert.equal(management[0].home,f.home);assert.equal(management[0].xdg,f.environment.XDG_CONFIG_HOME);
    await assert.rejects(fs.stat(path.join(f.home,'.config/neurocenter/bridge',namespace(f.origin),'credentials.json')),{code:'ENOENT'});
    await unchanged(saved);noDelivery(f);assert.doesNotMatch(result.stdout+result.stderr,/owned-worker-token/);
}));

test('Explicit INSTALL_DIR with spaces and quotes selects that exact bundle without invoking a launcher',()=>installerLifecycleFixture('connect-custom-install',async f=>{
    const install=path.join(f.root,"custom runtime ' quoted");await fs.rename(f.install,install);const saved=await profile(f,{install});
    const result=await f.runConnect({INSTALL_DIR:install,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.equal(result.status,0,result.stderr);
    assert.equal((await modes(f)).filter(mode=>mode==='--connect-open').length,1);await unchanged(saved);await noRegistrationOrUpgrade(f);noDelivery(f);
    assert.equal(await fs.readFile(path.join(install,'previous.txt'),'utf8'),'owned old runtime');
}));

test('A genuinely new current site migrates only its two origin fields and pairs without the old site token',()=>installerLifecycleFixture('connect-new-site',async f=>{
    const saved=await profile(f),issuer=await f.startIssuer();
    const result=await f.runConnect({BASE_URL:issuer+'/api/bridge',SITE_URL:issuer,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.equal(result.status,0,result.stderr);
    const expected=structuredClone(saved.document);Object.assign(expected.mcp['neurocenter-asset-sync'].environment,{NEUROCENTER_URL:issuer,NEUROCENTER_API_URL:issuer});
    assert.deepEqual(parse(await fs.readFile(saved.config,'utf8')),expected);
    const exact=saved.text.replace('"NEUROCENTER_URL": '+JSON.stringify(f.origin),'"NEUROCENTER_URL": '+JSON.stringify(issuer)).replace('"NEUROCENTER_API_URL": '+JSON.stringify(f.origin),'"NEUROCENTER_API_URL": '+JSON.stringify(issuer));assert.equal(await fs.readFile(saved.config,'utf8'),exact);
    assert.deepEqual(await fs.readFile(saved.credentials),saved.bytes);assert.equal(posts(f.state.requests).length,0);
    assert.deepEqual(posts(f.state.issuerRequests).map(row=>[row.route,row.authorization]),[['/api/device-channel/pair/start',false]]);noDelivery(f);
    const target=path.join(saved.bridgeHome,namespace(issuer));await assert.rejects(fs.stat(path.join(target,'credentials.json')),{code:'ENOENT'});
    assert.equal(JSON.parse(await fs.readFile(path.join(target,'pair.json'),'utf8')).userCode,'OWN-ISSUER');assert.ok(result.stdout.includes(issuer+'/start?step=1&connect=OWN-ISSUER'));
    assert.doesNotMatch(result.stdout+result.stderr,/owned-worker-token/);assert.equal((await modes(f)).includes('--init'),false);
}));

test('A missing saved API falls back to its saved site during same-site transport migration and resumes that API',()=>installerLifecycleFixture('connect-legacy-api',async f=>{
    const saved=await profile(f,{legacyApi:true}),issuer=await f.startIssuer();f.state.issuerToken='owned-worker-token';
    const result=await f.runConnect({BASE_URL:issuer+'/api/bridge',SITE_URL:f.origin,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1',INSTALLER_FIXTURE_NATIVE_UPGRADE:'1'});assert.equal(result.status,0,result.stderr);
    const rows=await contexts(f),upgrade=rows.filter(row=>['--prepare-upgrade','--finish-upgrade'].includes(row.mode));assert.equal(upgrade.length,2);
    for(const row of upgrade){assert.equal(row.site,f.origin);assert.equal(row.api,f.origin);assert.equal(row.home,saved.home);}
    const connect=rows.find(row=>row.mode==='--connect-open');assert.equal(connect.site,f.origin);assert.equal(connect.api,issuer);assert.equal(connect.home,saved.home);
    assert.deepEqual(posts(f.state.requests).map(row=>row.route),['/api/device-channel/worker/pause','/api/device-channel/worker/resume']);
    assert.deepEqual(posts(f.state.issuerRequests).map(row=>[row.route,row.authorization]),[['/api/device-channel/identity',true]]);assert.equal(f.state.paused,false);noDelivery(f);
    const expected=structuredClone(saved.document);expected.mcp['neurocenter-asset-sync'].environment.NEUROCENTER_API_URL=issuer;assert.deepEqual(parse(await fs.readFile(saved.config,'utf8')),expected);assert.deepEqual(await fs.readFile(saved.credentials),saved.bytes);
}));

test('A real connect CLI refusal is returned after one attempt without retrying an installer or downloading artifacts',()=>installerLifecycleFixture('connect-cli-refusal',async f=>{
    const saved=await profile(f),result=await f.runConnect({INSTALLER_FIXTURE_CONNECT_FAIL:'1'});assert.notEqual(result.status,0);
    assert.equal((await modes(f)).filter(mode=>mode==='--connect-open').length,1);await unchanged(saved);await noRegistrationOrUpgrade(f);noDelivery(f);assert.equal(posts(f.state.requests).length,0);
}));

test('Optional short command repair failure does not prevent one successful existing runtime connection',()=>installerLifecycleFixture('connect-optional-launcher-failure',async f=>{
    const saved=await profile(f),result=await f.runConnect({INSTALLER_FIXTURE_INSTALL_COMMAND_FAIL:'1',INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.equal(result.status,0,result.stderr);
    assert.equal((await contexts(f)).filter(row=>row.mode==='--install-command').length,1);assert.equal((await modes(f)).filter(mode=>mode==='--connect-open').length,1);
    assert.deepEqual(posts(f.state.requests).map(row=>row.route),['/api/device-channel/identity']);await unchanged(saved);await noRegistrationOrUpgrade(f);noDelivery(f);
}));

test('A missing runtime falls back once to the trusted installer, then connects exactly once',()=>installerLifecycleFixture('connect-missing-runtime',async f=>{
    await fs.rm(f.install,{recursive:true});const result=await f.runConnect();assert.equal(result.status,0,result.stderr);
    const calls=await modes(f);assert.equal(calls.filter(mode=>mode==='--init').length,1);assert.equal(calls.filter(mode=>mode==='--connect-open').length,1);
    const deliveries=gets(f.state.requests);assert.equal(deliveries.filter(row=>row.route.startsWith('/api/bridge/install.sh')).length,1);
    assert.equal(deliveries.filter(row=>row.route.includes('/runtime/')&&!row.route.endsWith('.sha256')).length,1);assert.equal(deliveries.filter(row=>row.route.endsWith('.sha256')).length,1);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.install,'package.json'),'utf8')).version,f.version);
}));

test('Unknown migration and failed restore retain the private snapshot even when a later marker write is denied',()=>installerLifecycleFixture('connect-retained-before-mutation',async f=>{
    const saved=await profile(f),issuer=await f.startIssuer(),hook=path.join(f.root,'retain-before-migration.cjs'),written=path.join(f.root,'published-before-ack');
    await fs.writeFile(hook,`const fs=require('node:fs');const rename=fs.renameSync,write=fs.writeFileSync;fs.renameSync=function(from,to){if(to!==${JSON.stringify(saved.config)})return rename.call(this,from,to);if(fs.existsSync(${JSON.stringify(written)}))throw Object.assign(Error('Owned restore denied'),{code:'EACCES'});const result=rename.call(this,from,to);write.call(fs,${JSON.stringify(written)},'migration published');throw Error('Owned migration ACK lost');};fs.writeFileSync=function(file,...args){if(typeof file==='string'&&file.endsWith('/retain')&&fs.existsSync(${JSON.stringify(written)}))throw Object.assign(Error('Owned late marker denied'),{code:'ENOSPC'});return write.call(this,file,...args);};`);
    const result=await f.runConnect({BASE_URL:issuer+'/api/bridge',SITE_URL:issuer,NODE_OPTIONS:'--require '+hook});assert.notEqual(result.status,0);
    assert.equal(await fs.readFile(written,'utf8'),'migration published');
    const stages=(await fs.readdir(f.root)).filter(name=>name.startsWith('neurocenter-connect.'));assert.equal(stages.length,1);
    const stage=path.join(f.root,stages[0]),plan=JSON.parse(await fs.readFile(path.join(stage,'profile.json'),'utf8'));
    assert.equal(plan.text,saved.text);assert.equal((await fs.stat(path.join(stage,'profile.json'))).mode&0o777,0o600);
    assert.equal((await fs.stat(stage)).mode&0o777,0o700);await fs.access(path.join(stage,'retain'));
    assert.match(result.stderr,/Приватный снимок сохранён/);await assert.rejects(fs.stat(f.install+'.install-lock'),{code:'ENOENT'});
    assert.deepEqual(await fs.readFile(saved.credentials),saved.bytes);noDelivery(f);assert.equal(posts(f.state.issuerRequests).length,0);
}));

test('Deleting runtime while keeping the old OpenCode registration restores and connects to the current site',()=>installerLifecycleFixture('connect-deleted-runtime-retained-config',async f=>{
    const saved=await profile(f),oldSite='http://127.0.0.1:1',old=structuredClone(saved.document);
    Object.assign(old.mcp['neurocenter-asset-sync'].environment,{NEUROCENTER_URL:oldSite,NEUROCENTER_API_URL:oldSite});
    const text='// Registration remains after deleting the program\n'+JSON.stringify(old,null,2)+'\n';
    await fs.writeFile(saved.config,text);const oldCredentials=path.join(saved.bridgeHome,namespace(oldSite),'credentials.json');
    await fs.mkdir(path.dirname(oldCredentials),{recursive:true});await fs.rename(saved.credentials,oldCredentials);
    await fs.rm(f.install,{recursive:true});
    const result=await f.runConnect({INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.equal(result.status,0,result.stderr);
    const expected=structuredClone(old);Object.assign(expected.mcp['neurocenter-asset-sync'].environment,{NEUROCENTER_URL:f.origin,NEUROCENTER_API_URL:f.origin});
    assert.deepEqual(parse(await fs.readFile(saved.config,'utf8')),expected);assert.deepEqual(await fs.readFile(oldCredentials),saved.bytes);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.install,'package.json'),'utf8')).version,f.version);
    const calls=await modes(f);assert.equal(calls.filter(mode=>mode==='--connect-open').length,1);assert.equal(calls.includes('--init'),false);
    assert.equal(gets(f.state.requests).filter(row=>row.route.startsWith('/api/bridge/install.sh')).length,1);
    assert.deepEqual(posts(f.state.requests).map(row=>[row.route,row.authorization]),[['/api/device-channel/pair/start',false]]);
}));
