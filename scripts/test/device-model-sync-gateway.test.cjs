const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createRequire}=require('node:module');
const fs=require('node:fs'),path=require('node:path');
const ts=createRequire(path.resolve('services/api-gateway/package.json'))('typescript');
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021,experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true}}).outputText,filename);
const {deviceCredentialTransport}=require('../../services/api-gateway/src/security/device-credential-transport.ts');
const {ProxyService}=require('../../services/api-gateway/src/proxy/proxy.service.ts');
const request=(patch={})=>Object.assign(new EventEmitter(),{path:'/api/device-channel/opencode-models/sync',method:'POST',headers:{host:'127.0.0.1:4000',authorization:'Bearer synthetic'},socket:{remoteAddress:'127.0.0.1'},body:{credentials:{candidate:'synthetic'}},...patch});
test('Device secrets require verified TLS or a literal local development socket',()=>{
    assert.equal(deviceCredentialTransport(request(),{}),true);
    assert.equal(deviceCredentialTransport(request(),{NODE_ENV:'production'}),false);
    assert.equal(deviceCredentialTransport(request({socket:{remoteAddress:'::ffff:127.0.0.1'}}),{}),true);
    assert.equal(deviceCredentialTransport(request({socket:{remoteAddress:'10.0.0.5'},headers:{host:'localhost','x-forwarded-proto':'https'}}),{}),false);
    assert.equal(deviceCredentialTransport(request({headers:{host:'public.example'}}),{}),false);
    assert.equal(deviceCredentialTransport(request({socket:{remoteAddress:'10.0.0.5',encrypted:true}}),{NODE_ENV:'production'}),true);
});
test('An explicitly trusted proxy may confirm TLS; spoofed or multi-hop headers never do',()=>{
    const env={NODE_ENV:'production',NEUROCENTER_TLS_PROXY_ADDRESSES:'10.0.0.5,::1'};
    assert.equal(deviceCredentialTransport(request({socket:{remoteAddress:'10.0.0.5'},headers:{'x-forwarded-proto':'https'}}),env),true);
    for(const remoteAddress of ['10.0.0.6','::ffff:10.0.0.6'])assert.equal(deviceCredentialTransport(request({socket:{remoteAddress},headers:{'x-forwarded-proto':'https'}}),env),false);
    for(const proto of ['http','https,http','https, http',['https']])assert.equal(deviceCredentialTransport(request({socket:{remoteAddress:'10.0.0.5'},headers:{'x-forwarded-proto':proto}}),env),false);
    assert.equal(deviceCredentialTransport(request({headers:{'x-forwarded-proto':'https'}}),{...env,NEUROCENTER_TLS_PROXY_ADDRESSES:'localhost'}),false);
});
function fixture(){
    const calls=[],events=[];
    const service=new ProxyService({get:()=>undefined},{authenticate:async()=>({deviceId:'device',email:'qa@example.test'})},{bridge(){},sections:value=>events.push(value)});
    service.http={post:async(url,body)=>{calls.push({url,body});return {status:200,data:{changed:true}};}};
    const res={statusCode:0,status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;}};
    return {service,calls,events,res};
}
test('Only exact context/sync POST device routes pass, with proper catalog invalidation',async()=>{
    for(const suffix of ['context','sync']){const f=fixture();await f.service.forward(request({path:'/api/device-channel/opencode-models/'+suffix,body:{credentials:{}}}),f.res);assert.equal(f.res.statusCode,200);assert.equal(f.calls.length,1);assert.ok(f.calls[0].url.endsWith('/internal/device-channel/opencode-models/'+suffix));if(suffix==='sync')assert.deepEqual(f.events,[['catalog','projects','audit']]);}
    for(const [method,suffix]of [['GET','sync'],['POST','sync/extra'],['PUT','context']]){const f=fixture();await f.service.forward(request({method,path:'/api/device-channel/opencode-models/'+suffix}),f.res);assert.equal(f.res.statusCode,404);assert.equal(f.calls.length,0);}
});
test('Untrusted plain HTTP cannot forward any credentials to Catalog',async()=>{
    const f=fixture();await f.service.forward(request({socket:{remoteAddress:'198.51.100.1'},headers:{host:'app.example','x-forwarded-proto':'https'}}),f.res);
    assert.equal(f.res.statusCode,403);assert.equal(f.calls.length,0);assert.doesNotMatch(JSON.stringify(f.res.body),/synthetic/);
});
