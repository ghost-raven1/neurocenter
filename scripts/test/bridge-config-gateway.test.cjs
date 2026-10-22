const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {EventEmitter}=require('node:events');
const {Writable}=require('node:stream');
const directory=process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist');
require('node:module').createRequire(path.join(directory,'entry.cjs'))('reflect-metadata');
const {BridgeSupplyService}=require(path.join(directory,'bridge/bridge-supply.service.js'));
const {BridgeController}=require(path.join(directory,'bridge/bridge.controller.js'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const target=({darwin:'darwin',linux:'linux',win32:'windows'})[process.platform]+'-'+process.arch+(process.platform==='linux'&&!process.report.getReport().header.glibcVersionRuntime?'-musl':'');
const publicOrigin='https://gateway.fixture.test:8443',status=expected=>error=>error.getStatus?.()===expected;
class Response extends Writable{
    constructor(){super();this.headers={};this.parts=[];this.headersSent=false;this.on('error',()=>{});}
    _write(bytes,_encoding,done){this.headersSent=true;this.parts.push(Buffer.from(bytes));done();}
    setHeader(key,value){this.headers[key.toLowerCase()]=String(value);return this;}
    removeHeader(key){delete this.headers[key.toLowerCase()];}
    send(value){this.end(value);return this;}
    json(value){this.setHeader('content-type','application/json; charset=utf-8');return this.send(JSON.stringify(value));}
    get body(){return Buffer.concat(this.parts);}
}
const request=()=>Object.assign(new EventEmitter(),{params:{},query:{},headers:{host:'spoofed.test','x-forwarded-host':'spoofed.test'},aborted:false});
function environment(t,key,value){const previous=process.env[key];process.env[key]=value;t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});}

/** Real immutable local bytes; any Catalog/source request is a failing tripwire, never a network call. */
async function fixture(t){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-dev-bridge-config-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    environment(t,'API_PUBLIC_URL',publicOrigin);environment(t,'BRIDGE_TEMPLATES_DIR',path.resolve('bridge-dist'));
    let sequence=0;
    const generation=async(payload=Buffer.from('local dev bytes'),version='9.8.7')=>{
        const buildId=digest('generation-'+(++sequence)),folder=path.join(root,'generation-'+sequence),file=`neurocenter-asset-sync-${target}-${version}.tgz`;
        const metadata={version,target,buildId,nodeVersion:'24.22.0',ragSupported:true,probeEngine:{version:'1.14.48',file:'bin/opencode-probe'+(process.platform==='win32'?'.exe':''),sha256:'d'.repeat(64)},sha256:digest(payload),bytes:payload.length};
        await fs.mkdir(folder);await fs.writeFile(path.join(folder,file),payload);await fs.writeFile(path.join(folder,file+'.json'),JSON.stringify(metadata));await fs.writeFile(path.join(folder,file+'.sha256'),metadata.sha256+'\n');
        return{folder,file,archive:path.join(folder,file),payload,metadata,pointer:{version,buildId,target,directory:path.basename(folder),sourceCommit:'c'.repeat(40)}};
    };
    const publish=async value=>{const candidate=path.join(root,'next.json');await fs.writeFile(candidate,JSON.stringify(value.pointer));await fs.rename(candidate,path.join(root,'current.json'));};
    const first=await generation();await publish(first);const calls=[];
    const service=(mode='development',runtime=root)=>{
        const values={NODE_ENV:mode,DEV_BRIDGE_RUNTIME_DIR:runtime,CATALOG_SERVICE_URL:'http://127.0.0.1:1'};
        const service=new BridgeSupplyService({get:key=>values[key]});service.http.get=async(...args)=>{calls.push(args);throw Error('Catalog/source-list tripwire: unavailable');};return service;
    };
    const configuration=async(serviceValue=service(),req=request(),res=new Response())=>{const value=await new BridgeController(serviceValue).configuration(req,res);if(value!==undefined&&!res.writableEnded)res.json(value);return{req,res,value:res.body.length?JSON.parse(res.body):undefined};};
    return{root,first,generation,publish,service,calls,configuration};
}
function archiveHandles(t,file,onHandle){
    const open=fs.open,handles=[];
    t.mock.method(fs,'open',async(filename,...args)=>{const handle=await open(filename,...args);if(filename===file){handles.push(handle);onHandle?.(handle);}return handle;});return handles;
}
function detached(req,res){assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);}

test('Config reports only verified dev version/build/targets and public origin while Catalog is unavailable',async t=>{
    const f=await fixture(t),handles=archiveHandles(t,f.first.archive),{req,res,value}=await f.configuration();
    assert.deepEqual(value,{origin:publicOrigin,devSupply:{version:f.first.pointer.version,buildId:f.first.pointer.buildId,targets:[target]}});
    assert.equal(res.headers['cache-control'],'no-store');assert.match(res.headers['content-type'],/application\/json/);
    for(const privateValue of [f.root,f.first.metadata.sha256,f.first.pointer.sourceCommit,'spoofed.test','127.0.0.1:1'])assert.equal(res.body.toString().includes(privateValue),false);
    assert.equal(f.calls.length,0);assert.equal(handles.length,1);assert.equal(handles[0].fd,-1);detached(req,res);
});
test('Config, both bridge installers and runtime all use local dev bytes without Catalog/source-list access',async t=>{
    const f=await fixture(t),service=f.service(),controller=new BridgeController(service);await f.configuration(service);
    for(const method of ['installScript','installWindowsBridge']){const res=new Response();await controller[method](request(),res);assert.ok(res.body.toString().includes("'9.8.7'"));}
    const req=request(),res=new Response();req.params.file=f.first.file;await controller.runtime(req,res);assert.deepEqual(res.body,f.first.payload);assert.equal(res.writableFinished,true);assert.equal(f.calls.length,0);
});
test('Same-version atomic repack is visible in config from the same service without stale catalog provenance',async t=>{
    const f=await fixture(t),service=f.service(),before=(await f.configuration(service)).value,next=await f.generation(Buffer.from('dependency-only repack'));await f.publish(next);
    const after=(await f.configuration(service)).value;assert.equal(after.devSupply.version,before.devSupply.version);assert.notEqual(after.devSupply.buildId,before.devSupply.buildId);assert.equal(after.devSupply.buildId,next.pointer.buildId);assert.equal(f.calls.length,0);
});
test('Production config ignores a corrupt configured dev runtime and keeps exactly the previous origin object',async t=>{
    const f=await fixture(t);await fs.writeFile(path.join(f.root,'current.json'),'corrupt');const handles=archiveHandles(t,f.first.archive);
    assert.deepEqual((await f.configuration(f.service('production'))).value,{origin:publicOrigin});assert.equal(handles.length,0);assert.equal(f.calls.length,0);
});
test('An unconfigured development override keeps exactly origin and does not consult Catalog',async t=>{
    const f=await fixture(t);assert.deepEqual((await f.configuration(f.service('development',null))).value,{origin:publicOrigin});assert.equal(f.calls.length,0);
});
test('A missing dev directory keeps exactly origin without pretending a catalog bridge is available',async t=>{
    const f=await fixture(t);assert.deepEqual((await f.configuration(f.service('development',path.join(f.root,'absent')))).value,{origin:publicOrigin});assert.equal(f.calls.length,0);
});
test('A missing dev pointer keeps config origin and supply still uses the previous imported fallback',async t=>{
    const f=await fixture(t),service=f.service();await fs.unlink(path.join(f.root,'current.json'));assert.deepEqual((await f.configuration(service)).value,{origin:publicOrigin});assert.equal(f.calls.length,0);
    await assert.rejects(service.supply(new AbortController().signal),status(503));assert.equal(f.calls.length,1);
});
test('A malformed existing dev pointer fails config closed without fake origin success or catalog fallback',async t=>{
    const f=await fixture(t),req=request(),res=new Response();await fs.writeFile(path.join(f.root,'current.json'),'{');
    await assert.rejects(f.configuration(f.service(),req,res),status(503));assert.equal(res.body.length,0);assert.equal(f.calls.length,0);detached(req,res);
});
test('Corrupt dev bytes fail config closed and close the actual archive descriptor',async t=>{
    const f=await fixture(t),req=request(),res=new Response();await fs.writeFile(f.first.archive,Buffer.alloc(f.first.payload.length));const handles=archiveHandles(t,f.first.archive);
    await assert.rejects(f.configuration(f.service(),req,res),status(503));assert.equal(res.body.length,0);assert.equal(f.calls.length,0);assert.equal(handles.length,1);assert.equal(handles[0].fd,-1);detached(req,res);
});
test('A pre-disconnected config request does not start descriptor reads and releases handlers',async t=>{
    const f=await fixture(t),req=request(),res=new Response(),handles=archiveHandles(t,f.first.archive);req.aborted=true;
    await f.configuration(f.service(),req,res);assert.equal(handles.length,0);assert.equal(res.body.length,0);assert.equal(f.calls.length,0);detached(req,res);
});
async function cancelDuringHash(t,mode){
    const f=await fixture(t),service=f.service(),req=request(),res=new Response();let cancelled=false;
    const handles=archiveHandles(t,f.first.archive,handle=>{const stream=handle.createReadStream.bind(handle);handle.createReadStream=options=>{const input=stream(options);input.once('data',()=>{if(!cancelled){cancelled=true;if(mode==='request'){req.aborted=true;req.emit('aborted');}else res.destroy();}});return input;};});
    await f.configuration(service,req,res);assert.equal(cancelled,true);assert.equal(res.body.length,0);assert.equal(handles[0].fd,-1);detached(req,res);
    assert.ok((await f.configuration(service)).value.devSupply);assert.ok(handles.every(handle=>handle.fd===-1));assert.equal(f.calls.length,0);
}
test('Request cancellation during config hashing closes the descriptor and leaves the next request independent',t=>cancelDuringHash(t,'request'));
test('Response cancellation during config hashing closes the descriptor and leaves the next request independent',t=>cancelDuringHash(t,'response'));
test('Cancellation while descriptor close completes cannot publish a stale config success',async t=>{
    const f=await fixture(t),req=request(),res=new Response(),handles=archiveHandles(t,f.first.archive,handle=>{const close=handle.close.bind(handle);handle.close=async()=>{await close();req.aborted=true;req.emit('aborted');};});
    await f.configuration(f.service(),req,res);assert.equal(res.body.length,0);assert.equal(handles[0].fd,-1);detached(req,res);assert.equal(f.calls.length,0);
});
test('Public developmentSupply closes its archive and supply reuses it once with exact version semantics',async t=>{
    const f=await fixture(t),service=f.service(),handles=archiveHandles(t,f.first.archive);let lookups=0;const development=service.developmentSupply.bind(service);service.developmentSupply=signal=>{lookups++;return development(signal);};
    const signal=new AbortController().signal,value=await service.supply(signal,'9.8.7');assert.equal(value.buildId,f.first.pointer.buildId);assert.equal(lookups,1);assert.equal(handles.length,1);assert.equal(handles[0].fd,-1);
    await assert.rejects(service.supply(signal,'9.8.6'),status(404));assert.equal(lookups,2);assert.ok(handles.every(handle=>handle.fd===-1));assert.equal(f.calls.length,0);
});
test('Config validates public origin before any dev read and never uses untrusted request headers',async t=>{
    const f=await fixture(t),handles=archiveHandles(t,f.first.archive);environment(t,'API_PUBLIC_URL','https://owner:secret@invalid.test');
    await assert.rejects(f.configuration());assert.equal(handles.length,0);assert.equal(f.calls.length,0);
});
