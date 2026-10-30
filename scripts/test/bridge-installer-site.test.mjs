import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {installerLifecycleFixture} from './bridge-installer-lifecycle.fixture.mjs';

const {parse}=createRequire(new URL('../../mcp/neurocenter-asset-sync/package.json',import.meta.url))('jsonc-parser');
const namespace=site=>createHash('sha256').update(site).digest('hex').slice(0,20);
const context=f=>fs.readFile(f.environment.INSTALLER_FIXTURE_CONTEXTS,'utf8').then(text=>text.trim().split('\n').map(JSON.parse));
const modes=f=>fs.readFile(f.environment.INSTALLER_FIXTURE_EVENTS,'utf8').then(text=>text.trim().split('\n'));
const posts=rows=>rows.filter(row=>row.method==='POST');

/** The caller config and saved runtime HOME intentionally differ; only the two origin fields may migrate. */
async function savedProfile(f,{legacyApi=false,worker=false}={}){
    const config=path.join(f.environment.XDG_CONFIG_HOME,'opencode/opencode.jsonc'),home=path.join(f.root,'saved-runtime-home'),bridgeHome=path.join(f.root,'saved-bridge-state'),ca=path.join(f.root,'owned-ca.pem');
    await fs.writeFile(ca,'');
    const environment={NEUROCENTER_URL:f.origin,...(legacyApi?{}:{NEUROCENTER_API_URL:f.origin}),HOME:home,XDG_CONFIG_HOME:path.join(home,'runtime-config'),NEUROCENTER_BRIDGE_HOME:bridgeHome,NODE_EXTRA_CA_CERTS:ca,HTTPS_PROXY:'http://127.0.0.1:1',CUSTOM_SETTING:'retain exact'};
    const own={type:'local',enabled:false,command:[path.join(f.install,'bin/node'),path.join(f.install,'dist/index.js')],timeout:45000,environment};
    const document={agent:{existing:{mode:'subagent',description:'keep agent'}},model:'team/model',mcp:{other:{type:'remote',url:'https://other.example.test'},'neurocenter-asset-sync':own}};
    const text='// Existing user profile\n'+JSON.stringify(document,null,2).replace('  "agent":','  // Preserve this agent comment\n  "agent":')+'\n// Preserve trailing comment\n';
    await fs.mkdir(path.dirname(config),{recursive:true});await fs.writeFile(config,text);
    const credentials=path.join(bridgeHome,namespace(f.origin),'credentials.json'),bytes=Buffer.from(JSON.stringify({token:'owned-worker-token',deviceId:'owned'}));
    await fs.mkdir(path.dirname(credentials),{recursive:true,mode:0o700});await fs.writeFile(credentials,bytes,{mode:0o600});f.state.token='owned-worker-token';
    if(worker)await f.startWorker({...environment,NEUROCENTER_API_URL:f.origin});
    return{config,text,own,document,home,bridgeHome,credentials,bytes,legacyApi,site:f.origin,api:f.origin};
}
async function unchangedCredentials(saved){assert.deepEqual(await fs.readFile(saved.credentials),saved.bytes);}
async function migratedProfile(saved,site,api){
    const actual=await fs.readFile(saved.config,'utf8'),expected=structuredClone(saved.document);
    Object.assign(expected.mcp['neurocenter-asset-sync'].environment,{NEUROCENTER_URL:site,NEUROCENTER_API_URL:api});
    assert.deepEqual(parse(actual),expected,'Migration may change only the own entry site/API fields');
    if(!saved.legacyApi){
        const exact=saved.text.replace('"NEUROCENTER_URL": '+JSON.stringify(saved.site),'"NEUROCENTER_URL": '+JSON.stringify(site))
            .replace('"NEUROCENTER_API_URL": '+JSON.stringify(saved.api),'"NEUROCENTER_API_URL": '+JSON.stringify(api));
        assert.equal(actual,exact,'Existing JSONC bytes outside the two origin values must survive');
    }else for(const comment of ['// Existing user profile','// Preserve this agent comment','// Preserve trailing comment'])assert.ok(actual.includes(comment));
    await unchangedCredentials(saved);
}
async function phaseContexts(f,saved,site,api,{prepared=true,reconnect=false}={}){
    const contexts=await context(f),commands=await modes(f);
    assert.equal(commands.includes('--init'),false,'Migrating an exact existing registration must preserve its disabled/options fields');
    const old=contexts.filter(row=>['--prepare-upgrade','--finish-upgrade'].includes(row.mode));
    assert.equal(old.length,prepared?2:0);
    for(const row of old){assert.equal(row.site,saved.site);assert.equal(row.api,saved.api);assert.equal(row.home,saved.home);assert.equal(row.bridgeHome,saved.bridgeHome);}
    const management=contexts.filter(row=>row.mode==='--install-command');assert.equal(management.length,1);
    assert.equal(management[0].home,f.home);assert.equal(management[0].xdg,f.environment.XDG_CONFIG_HOME);
    const connect=contexts.filter(row=>['--connect-open','--reconnect-open'].includes(row.mode));assert.equal(connect.length,1);
    assert.equal(connect[0].mode,reconnect?'--reconnect-open':'--connect-open');assert.equal(connect[0].home,saved.home);
    for(const row of [...management,...connect]){assert.equal(row.site,site);assert.equal(row.api,api);}
    assert.equal(await fs.readFile(path.join(f.home,'.local/bin/neurocenter-bridge'),'utf8'),'owned caller launcher');
    await assert.rejects(fs.stat(path.join(saved.home,'.local/bin/neurocenter-bridge')),{code:'ENOENT'});
}
async function pendingTarget(f,saved,site,result){
    assert.match(result.stdout,/Подключение жд[её]т подтверждения/);assert.ok(result.stdout.includes(site+'/start?setup=1&setupFlow=bridge-first&step=0&connect='));
    assert.doesNotMatch(result.stdout+result.stderr,/owned-worker-token/);
    const directory=path.join(saved.bridgeHome,namespace(site));await assert.rejects(fs.stat(path.join(directory,'credentials.json')),{code:'ENOENT'});
    const pair=JSON.parse(await fs.readFile(path.join(directory,'pair.json'),'utf8'));assert.notEqual(pair.candidateToken,'owned-worker-token');assert.ok(pair.userCode);
    await unchangedCredentials(saved);assert.equal(f.state.paused,false);
}

test('UI alias migration changes only the two origins and pairs in a new namespace without the saved token',()=>installerLifecycleFixture('site-ui-alias',async f=>{
    const saved=await savedProfile(f,{worker:true}),site=f.origin.replace('127.0.0.1','localhost');
    const result=await f.run({SITE_URL:site,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1',INSTALLER_FIXTURE_NATIVE_UPGRADE:'1'});assert.equal(result.status,0,result.stderr);
    await migratedProfile(saved,site,f.origin);await phaseContexts(f,saved,site,f.origin);await pendingTarget(f,saved,site,result);
    assert.deepEqual(posts(f.state.requests).map(row=>[row.route,row.authorization]),[['/api/device-channel/worker/pause',true],['/api/device-channel/worker/resume',true],['/api/device-channel/pair/start',false]]);
}));

test('A distinct issuer receives artifact GETs and unauthenticated new-site pairing, never the old credentials',()=>installerLifecycleFixture('site-new-issuer',async f=>{
    const saved=await savedProfile(f),issuer=await f.startIssuer();
    const result=await f.run({BASE_URL:issuer+'/api/bridge',SITE_URL:issuer,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.equal(result.status,0,result.stderr);
    await migratedProfile(saved,issuer,issuer);await phaseContexts(f,saved,issuer,issuer,{prepared:false});await pendingTarget(f,saved,issuer,result);
    assert.equal(posts(f.state.requests).length,0,'A missing previous worker must not require its old API');
    assert.equal(f.state.issuerRequests.filter(row=>row.method==='GET').length,2);
    assert.deepEqual(posts(f.state.issuerRequests).map(row=>[row.route,row.authorization]),[['/api/device-channel/pair/start',false]]);
}));

test('Migration may reuse the target own credentials without copying or resetting the previous site identity',()=>installerLifecycleFixture('site-existing-target',async f=>{
    const saved=await savedProfile(f),issuer=await f.startIssuer(),targetFile=path.join(saved.bridgeHome,namespace(issuer),'credentials.json');
    const targetBytes=Buffer.from(JSON.stringify({token:'owned-target-token',deviceId:'own-issuer-paired-device'}));
    await fs.mkdir(path.dirname(targetFile),{recursive:true});await fs.writeFile(targetFile,targetBytes,{mode:0o600});f.state.issuerToken='owned-target-token';
    const result=await f.run({BASE_URL:issuer+'/api/bridge',SITE_URL:issuer,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1'});assert.equal(result.status,0,result.stderr);
    await migratedProfile(saved,issuer,issuer);await phaseContexts(f,saved,issuer,issuer,{prepared:false});assert.deepEqual(await fs.readFile(targetFile),targetBytes);
    assert.equal(posts(f.state.requests).length,0);assert.deepEqual(posts(f.state.issuerRequests).map(row=>[row.route,row.authorization]),[['/api/device-channel/identity',true]]);
    await assert.rejects(fs.stat(path.join(path.dirname(targetFile),'pair.json')),{code:'ENOENT'});assert.match(result.stdout,/Компьютер уже подключ[её]н/);
    assert.doesNotMatch(result.stdout+result.stderr,/owned-worker-token|owned-target-token/);
}));

test('A legacy missing API uses the saved site for preparation before same-site API transport migration',()=>installerLifecycleFixture('site-legacy-api',async f=>{
    const saved=await savedProfile(f,{legacyApi:true,worker:true}),issuer=await f.startIssuer();f.state.issuerToken='owned-worker-token';
    const result=await f.run({BASE_URL:issuer+'/api/bridge',SITE_URL:f.origin,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1',INSTALLER_FIXTURE_NATIVE_UPGRADE:'1'});assert.equal(result.status,0,result.stderr);
    await migratedProfile(saved,f.origin,issuer);await phaseContexts(f,saved,f.origin,issuer);assert.equal(f.state.paused,false);
    assert.deepEqual(posts(f.state.requests).map(row=>[row.route,row.authorization]),[['/api/device-channel/worker/pause',true],['/api/device-channel/worker/resume',true]]);
    assert.deepEqual(posts(f.state.issuerRequests).map(row=>[row.route,row.authorization]),[['/api/device-channel/identity',true]]);
    await assert.rejects(fs.stat(path.join(path.dirname(saved.credentials),'pair.json')),{code:'ENOENT'});
}));

test('Reconnect after site migration uses the target origin and does not reset the old site profile',()=>installerLifecycleFixture('site-reconnect-target',async f=>{
    const saved=await savedProfile(f,{worker:true}),issuer=await f.startIssuer();
    const result=await f.run({BASE_URL:issuer+'/api/bridge',SITE_URL:issuer,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1',INSTALLER_FIXTURE_NATIVE_UPGRADE:'1'},{reconnect:true});assert.equal(result.status,0,result.stderr);
    await migratedProfile(saved,issuer,issuer);await phaseContexts(f,saved,issuer,issuer,{reconnect:true});await pendingTarget(f,saved,issuer,result);
    assert.deepEqual(posts(f.state.issuerRequests).map(row=>[row.route,row.authorization]),[['/api/device-channel/pair/start',false]]);
    assert.equal(posts(f.state.requests).filter(row=>!row.route.includes('/worker/')).length,0);
}));

test('A lost prepare ACK resumes only the saved API and retains the old runtime/config/credentials',()=>installerLifecycleFixture('site-lost-prepare',async f=>{
    const saved=await savedProfile(f,{worker:true}),issuer=await f.startIssuer();
    const result=await f.run({BASE_URL:issuer+'/api/bridge',SITE_URL:issuer,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1',INSTALLER_FIXTURE_NATIVE_UPGRADE:'1',INSTALLER_FIXTURE_PREPARE:'lost'});assert.notEqual(result.status,0);
    assert.equal(await fs.readFile(saved.config,'utf8'),saved.text);assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');await unchangedCredentials(saved);
    assert.deepEqual(posts(f.state.requests).map(row=>[row.route,row.authorization]),[['/api/device-channel/worker/pause',true],['/api/device-channel/worker/resume',true]]);
    assert.equal(posts(f.state.issuerRequests).length,0);assert.equal(f.state.paused,false);
    const contexts=await context(f);assert.ok(contexts.length>=2);assert.ok(contexts.every(row=>row.site===saved.site&&row.api===saved.api));
}));

test('A concurrent config edit after old-site pause survives and prevents target publication',()=>installerLifecycleFixture('site-config-cas',async f=>{
    const saved=await savedProfile(f,{worker:true}),issuer=await f.startIssuer(),edited=saved.text+'// Concurrent edit\n';let paused=false;
    f.state.onPause=async()=>{paused=true;await fs.writeFile(saved.config,edited);};
    const result=await f.run({BASE_URL:issuer+'/api/bridge',SITE_URL:issuer,INSTALLER_FIXTURE_REQUIRE_PROFILE:'1',INSTALLER_FIXTURE_NATIVE_UPGRADE:'1'});assert.notEqual(result.status,0);
    assert.equal(paused,true,'The concurrency fault must occur after real old-site admission');assert.equal(await fs.readFile(saved.config,'utf8'),edited);
    assert.equal(await fs.readFile(path.join(f.install,'previous.txt'),'utf8'),'owned old runtime');await unchangedCredentials(saved);
    assert.equal(posts(f.state.issuerRequests).length,0);assert.equal(f.state.paused,false);
    assert.equal(posts(f.state.requests).filter(row=>row.route.endsWith('/worker/resume')).length,1);
}));
