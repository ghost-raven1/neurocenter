const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createServer}=require('node:http');
const {once}=require('node:events');
const directory=process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist');
const localRequire=require('node:module').createRequire(path.join(directory,'entry.cjs'));
localRequire('reflect-metadata');
const {Module}=localRequire('@nestjs/common');
const {NestFactory}=localRequire('@nestjs/core');
const {BridgeController}=require(path.join(directory,'bridge/bridge.controller.js'));
const {BridgeSupplyService}=require(path.join(directory,'bridge/bridge-supply.service.js'));
const {defaultFeatureFlags,evaluateFeatureFlags}=require('../../services/shared/feature-flags.cjs');

function environment(t,key,value){const previous=process.env[key];process.env[key]=value;t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});}
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}

/** Actual Nest public routes and a local feature service; no installed runtime or user files are touched. */
test('public workspace installers fail closed before rendering while existing installers remain available',async t=>{
    let enabled=false,available=true,flagReads=0,supplyReads=0;
    const flags=createServer((_req,res)=>{flagReads++;res.writeHead(available?200:503,{'content-type':'application/json'});res.end(JSON.stringify(available?evaluateFeatureFlags({...defaultFeatureFlags(),unified_project_setup:enabled}):{private:'must not be echoed'}));});
    const flagUrl=await listen(flags);t.after(async()=>{flags.closeAllConnections();await new Promise(resolve=>flags.close(resolve));});
    environment(t,'FEATURE_FLAGS_SERVICE_URL',flagUrl);environment(t,'BRIDGE_TEMPLATES_DIR',path.resolve('bridge-dist'));
    environment(t,'API_PUBLIC_URL','https://gateway.example.test');environment(t,'PANEL_URL','https://panel.example.test');
    const supply={supply:async()=>{supplyReads++;return{version:'0.9.23'};}};
    class FixtureModule{}
    Module({controllers:[BridgeController],providers:[{provide:BridgeSupplyService,useValue:supply}]})(FixtureModule);
    const app=await NestFactory.create(FixtureModule,{logger:false});t.after(()=>app.close());
    await app.listen(0,'127.0.0.1');const origin=await app.getUrl();
    for(const suffix of ['sh','ps1']){
        const denied=await fetch(origin+'/api/bridge/install_workspace.'+suffix);assert.equal(denied.status,403);const body=await denied.json();
        assert.equal(body.code,'feature-disabled');assert.equal(body.feature,'unified_project_setup');assert.equal(supplyReads,0);
    }
    const readsBefore=flagReads;
    for(const file of ['install.sh','install.ps1','install_opencode.sh','install_opencode.ps1']){
        const response=await fetch(origin+'/api/bridge/'+file);assert.equal(response.status,200);assert.ok((await response.text()).length>100);
    }
    assert.equal(flagReads,readsBefore);
    available=false;
    const unavailable=await fetch(origin+'/bridge/install_workspace.sh');assert.equal(unavailable.status,503);
    const failure=await unavailable.json();assert.equal(failure.code,'feature-flags-unavailable');assert.doesNotMatch(JSON.stringify(failure),/must not be echoed|127\.0\.0\.1/);
    available=true;enabled=true;
    for(const suffix of ['sh','ps1']){
        const ready=await fetch(origin+'/api/bridge/install_workspace.'+suffix,{headers:{'x-forwarded-host':'attacker.example.test'}});assert.equal(ready.status,200);
        const source=await ready.text();assert.match(source,/https:\/\/gateway\.example\.test\/api\/bridge/);assert.doesNotMatch(source,/attacker\.example|__BRIDGE_VERSION__/);
    }
});
