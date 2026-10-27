const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {EventEmitter}=require('node:events');
const {Writable}=require('node:stream');
const directory=process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist');
require('node:module').createRequire(path.join(directory,'entry.cjs'))('reflect-metadata');
const {BridgeController}=require(path.join(directory,'bridge/bridge.controller.js'));
const {defaultFeatureFlags,evaluateFeatureFlags}=require('../../services/shared/feature-flags.cjs');
const methods=[['installScript','install.sh'],['installWindowsBridge','install.ps1'],['installWorkspace','install_workspace.sh'],['installWorkspaceWindows','install_workspace.ps1']],removed=[];
class Response extends Writable{
    constructor(){super();this.headers={};this.parts=[];this.headersSent=false;}
    _write(chunk,_encoding,done){this.headersSent=true;this.parts.push(Buffer.from(chunk));done();}
    setHeader(name,value){this.headers[name.toLowerCase()]=String(value);}
    send(value){this.end(value);}
    get text(){return Buffer.concat(this.parts).toString();}
}
const request=query=>Object.assign(new EventEmitter(),{query,headers:{},aborted:false});
function env(t,key,value){const before=process.env[key];process.env[key]=value;t.after(()=>{if(before===undefined)delete process.env[key];else process.env[key]=before;});}
function detached(req,res){assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);}
/** The archived package and its installer select the same version without falling back to the head. */
async function fixture(t){
    t.mock.method(globalThis,'fetch',async()=>new globalThis.Response(JSON.stringify(evaluateFeatureFlags({...defaultFeatureFlags(),unified_project_setup:true}))));
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-installer-version-')));
    t.after(async()=>{await fs.rm(root,{recursive:true,force:true});removed.push(root);});
    env(t,'BRIDGE_TEMPLATES_DIR',root);env(t,'PANEL_URL','https://panel.example.test');env(t,'API_PUBLIC_URL','https://api.example.test');
    for(const [,file]of methods)await fs.writeFile(path.join(root,file),"VERSION='__BRIDGE_VERSION__'\nBASE='__BASE_URL__'\nSITE='__SITE_URL__'\nRECONNECT='__RECONNECT__'\n");
    const calls=[],service={supply:async(...args)=>{calls.push(args);return{version:args[1]||'9.9.9'};}};
    return{calls,service,controller:new BridgeController(service)};
}
test('Workspace installers are registered on both public bridge prefixes',()=>{
    assert.deepEqual(Reflect.getMetadata('path',BridgeController),['bridge','api/bridge']);
    for(const [method,file]of methods.filter(([,file])=>file.startsWith('install_workspace.'))){assert.equal(Reflect.getMetadata('path',BridgeController.prototype[method]),file);}
});
for(const [method,file]of methods.filter(([,file])=>file.startsWith('install_workspace.')))test(file+' renders the shipped wrapper with trusted origins instead of forwarded headers',async t=>{
    const f=await fixture(t),req=request({}),res=new Response();req.headers={host:'attacker.example.test','x-forwarded-host':'attacker.example.test','x-forwarded-proto':'http'};
    await fs.copyFile(path.resolve('bridge-dist',file),path.join(process.env.BRIDGE_TEMPLATES_DIR,file));
    await f.controller[method](req,res);
    assert.match(res.text,/https:\/\/api\.example\.test\/api\/bridge/);assert.match(res.text,/https:\/\/panel\.example\.test/);
    assert.match(res.text,file.endsWith('.sh')?/VERSION='9\.9\.9'/:/\$Version = '9\.9\.9'/);
    assert.doesNotMatch(res.text,/attacker\.example|__(?:BRIDGE_[A-Z_]+|BASE_URL|SITE_URL|RECONNECT)__/);
    detached(req,res);
});
for(const [method,file]of methods){
    test(file+' selects the explicit historical version instead of the current supply',async t=>{
        const f=await fixture(t),req=request({version:'0.9.18'}),res=new Response();await f.controller[method](req,res);
        assert.equal(f.calls.length,1);assert.equal(f.calls[0].length,2);assert.ok(f.calls[0][0]instanceof AbortSignal);assert.equal(f.calls[0][1],'0.9.18');
        assert.match(res.text,/VERSION='0\.9\.18'/);assert.doesNotMatch(res.text,/9\.9\.9|__BRIDGE_/);assert.equal(res.headers['cache-control'],'no-store');detached(req,res);
    });
    test(file+' keeps the existing current-version contract when no version is selected',async t=>{
        const f=await fixture(t),req=request({}),res=new Response();await f.controller[method](req,res);
        assert.equal(f.calls.length,1);assert.equal(f.calls[0].length,1);assert.match(res.text,/VERSION='9\.9\.9'/);detached(req,res);
    });
    test(file+' downloads the selected installer as a named attachment for another origin',async t=>{
        const f=await fixture(t),req=request({version:'0.9.18',download:'1'}),res=new Response();await f.controller[method](req,res);
        assert.equal(res.headers['content-disposition'],'attachment; filename="'+file+'"');assert.match(res.text,/VERSION='0\.9\.18'/);detached(req,res);
    });
    test(file+' preserves inline commands unless download is the exact explicit switch',async t=>{
        const f=await fixture(t);
        for(const query of [{},{download:'true'},{download:['1']}]){const req=request(query),res=new Response();await f.controller[method](req,res);assert.equal(res.headers['content-disposition'],undefined);detached(req,res);}
    });
    for(const version of [[],['0.9.18'],{},'', '../0.9.18', '0.9', 'https://other.test', '0.9.18?key=private'])test(file+' rejects an ambiguous version '+JSON.stringify(version)+' before reading a supply',async t=>{
        const f=await fixture(t),req=request({version}),res=new Response();
        await assert.rejects(f.controller[method](req,res),error=>error.getStatus?.()===404);
        assert.deepEqual(f.calls,[]);assert.equal(res.text,'');detached(req,res);
    });
    test(file+' retains a missing historical-version error without serving a current installer',async t=>{
        const f=await fixture(t),error=Object.assign(Error('Historical package unavailable'),{getStatus:()=>404}),req=request({version:'0.9.17'}),res=new Response();
        f.service.supply=async(_signal,version)=>{assert.equal(version,'0.9.17');throw error;};
        await assert.rejects(f.controller[method](req,res),cause=>cause===error);assert.equal(res.text,'');detached(req,res);
    });
    test(file+' stops a cancelled selection without serving a partially rendered installer',async t=>{
        const f=await fixture(t),req=request({version:'0.9.18'}),res=new Response();
        f.service.supply=async(signal,version)=>{assert.equal(version,'0.9.18');req.aborted=true;req.emit('aborted');assert.equal(signal.aborted,true);return{version};};
        await f.controller[method](req,res);assert.equal(res.text,'');detached(req,res);
    });
}
after(async()=>{for(const root of removed)await assert.rejects(fs.stat(root),{code:'ENOENT'});});
