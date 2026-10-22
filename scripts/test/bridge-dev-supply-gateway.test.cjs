const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const syncFs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {Readable,Writable}=require('node:stream');
const {EventEmitter}=require('node:events');
const directory=process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist');
require('node:module').createRequire(path.join(directory,'entry.cjs'))('reflect-metadata');
const {BridgeSupplyService,bridgeRequest}=require(path.join(directory,'bridge/bridge-supply.service.js'));
const {BridgeController}=require(path.join(directory,'bridge/bridge.controller.js'));
const digest=value=>createHash('sha256').update(value).digest('hex');
const target=({darwin:'darwin',linux:'linux',win32:'windows'})[process.platform]+'-'+process.arch+(process.platform==='linux'&&!process.report.getReport().header.glibcVersionRuntime?'-musl':'');
const status=expected=>error=>error.getStatus?.()===expected;
class Response extends Writable{
 constructor(){super();this.parts=[];this.headers={};this.headersSent=false;this.on('error',()=>{});}
 _write(bytes,_encoding,done){this.headersSent=true;this.parts.push(Buffer.from(bytes));done();}
 setHeader(key,value){this.headers[key]=String(value);this.onHeader?.(key);return this;}
 removeHeader(key){delete this.headers[key];}
 send(value){this.end(value);return this;}
 get body(){return Buffer.concat(this.parts);}
}
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-dev-bridge-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let sequence=0;
 async function generation(payload=Buffer.from('local checkout runtime'),version='9.8.7'){
  const buildId=digest('build-'+(++sequence)),name='generation-'+sequence,folder=path.join(root,name),file=`neurocenter-asset-sync-${target}-${version}.tgz`;
  const metadata={version,target,buildId,nodeVersion:'24.22.0',ragSupported:true,probeEngine:{version:'1.14.48',file:'bin/opencode-probe'+(target.startsWith('windows-')?'.exe':''),sha256:'d'.repeat(64)},sha256:digest(payload),bytes:payload.length};
  await fs.mkdir(folder);await fs.writeFile(path.join(folder,file),payload);await fs.writeFile(path.join(folder,file+'.json'),JSON.stringify(metadata));await fs.writeFile(path.join(folder,file+'.sha256'),metadata.sha256+'\n');
  const pointer={version,buildId,target,directory:name,sourceCommit:'c'.repeat(40)};return{payload,metadata,pointer,file,folder,archive:path.join(folder,file)};
 }
 const first=await generation();const publish=async entry=>{const candidate=path.join(root,'next.json');await fs.writeFile(candidate,JSON.stringify(entry.pointer));await fs.rename(candidate,path.join(root,'current.json'));};await publish(first);
 const calls=[],importedPayload=Buffer.from('published catalog runtime'),imported=structuredClone(first.metadata);imported.sha256=digest(importedPayload);imported.bytes=importedPayload.length;
 const importedSupply={assetId:'neurocenter-bridge',version:imported.version,buildId:imported.buildId,sourceCommit:'e'.repeat(40),artifacts:[{file:first.file,target,sha256:imported.sha256,bytes:imported.bytes,metadata:imported}]};
 const service=(mode='development',rootDirectory=root)=>{
  const values={NODE_ENV:mode,DEV_BRIDGE_RUNTIME_DIR:rootDirectory,CATALOG_SERVICE_URL:'http://127.0.0.1:1'};
  const value=new BridgeSupplyService({get:key=>values[key]});value.http.get=async(url)=>{calls.push(url);return url.includes('/blobs/')?{status:200,headers:{'content-length':String(importedPayload.length),etag:'"'+imported.sha256+'"'},data:Readable.from([importedPayload])}:{status:200,data:importedSupply};};return value;
 };
 return{root,first,generation,publish,service,calls,importedSupply,importedPayload,signal:()=>new AbortController().signal};
}
test('Explicit development supply returns only the host generation and exact archive/JSON/SHA without catalog calls',async t=>{
 const f=await fixture(t),service=f.service(),supply=await service.supply(f.signal());assert.equal(supply.assetId,'neurocenter-bridge-dev');assert.deepEqual(supply.artifacts.map(row=>row.target),[target]);assert.equal(supply.buildId,f.first.pointer.buildId);assert.equal(JSON.stringify(supply).includes(f.root),false);
 for(const suffix of ['', '.json','.sha256']){const res=new Response();await service.runtime(f.first.file+suffix,f.signal(),res);assert.equal(res.headers['cache-control'],'no-store');if(!suffix)assert.deepEqual(res.body,f.first.payload);else if(suffix==='.json')assert.deepEqual(JSON.parse(res.body),f.first.metadata);else assert.equal(res.body.toString(),f.first.metadata.sha256+'\n');}assert.equal(f.calls.length,0);
});
test('An atomic pointer update is visible to the same Gateway without changing a published catalog descriptor',async t=>{
 const f=await fixture(t),service=f.service(),before=JSON.stringify(f.importedSupply),next=await f.generation(Buffer.from('new checkout bytes'));assert.equal((await service.supply(f.signal())).buildId,f.first.pointer.buildId);await f.publish(next);assert.equal((await service.supply(f.signal())).buildId,next.pointer.buildId);const res=new Response();await service.runtime(next.file,f.signal(),res);assert.deepEqual(res.body,next.payload);assert.equal(JSON.stringify(f.importedSupply),before);assert.equal(f.calls.length,0);
});
test('The rendered installer uses the current dev version through the existing controller',async t=>{
 const f=await fixture(t),next=await f.generation(Buffer.from('next version'),'9.8.8');await f.publish(next);const previous=process.env.BRIDGE_TEMPLATES_DIR;process.env.BRIDGE_TEMPLATES_DIR=path.resolve('bridge-dist');t.after(()=>{if(previous===undefined)delete process.env.BRIDGE_TEMPLATES_DIR;else process.env.BRIDGE_TEMPLATES_DIR=previous;});const req=Object.assign(new EventEmitter(),{params:{},query:{},headers:{},aborted:false}),res=new Response();await new BridgeController(f.service()).installScript(req,res);assert.ok(res.body.toString().includes("VERSION='9.8.8'"));assert.equal(f.calls.length,0);
});
for(const mode of ['production','test',''])test('The override is ignored outside explicit development: '+JSON.stringify(mode),async t=>{
 const previous=process.env.NODE_ENV;process.env.NODE_ENV='test';t.after(()=>{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;});
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'current.json'),'bad JSON');const service=f.service(mode);assert.deepEqual(await service.supply(f.signal()),f.importedSupply);const res=new Response();await service.runtime(f.first.file,f.signal(),res);assert.deepEqual(res.body,f.importedPayload);assert.equal(f.calls.length,3);
});
for(const missing of ['pointer','directory'])test('Missing dev '+missing+' preserves the normal imported supply',async t=>{
 const f=await fixture(t);await fs.rm(path.join(f.root,'current.json'));const service=f.service('development',missing==='directory'?path.join(f.root,'not-created'):f.root);assert.deepEqual(await service.supply(f.signal()),f.importedSupply);assert.equal(f.calls.length,1);
});
for(const[mode,mutate]of[
 ['malformed pointer',async f=>fs.writeFile(path.join(f.root,'current.json'),'{')],
 ['foreign platform',async f=>{f.first.pointer.target=target==='linux-x64'?'darwin-arm64':'linux-x64';await f.publish(f.first);}],
 ['escaping generation',async f=>{f.first.pointer.directory='../outside';await f.publish(f.first);}],
 ['mismatched build',async f=>{f.first.pointer.buildId='f'.repeat(64);await f.publish(f.first);}],
 ['missing archive',async f=>fs.rm(f.first.archive)],
 ['corrupt bytes',async f=>fs.writeFile(f.first.archive,Buffer.alloc(f.first.payload.length))],
 ['mismatched checksum sidecar',async f=>fs.writeFile(f.first.archive+'.sha256','a'.repeat(64))],
 ['invalid metadata size',async f=>{f.first.metadata.bytes++;await fs.writeFile(f.first.archive+'.json',JSON.stringify(f.first.metadata));}],
 ['overflow before hash completes',async f=>{f.first.metadata.bytes--;await fs.writeFile(f.first.archive+'.json',JSON.stringify(f.first.metadata));}],
 ['invalid runtime version',async f=>{f.first.metadata.nodeVersion='22.1.0';await fs.writeFile(f.first.archive+'.json',JSON.stringify(f.first.metadata));}],
])test('An existing invalid dev supply fails closed before output or fallback: '+mode,async t=>{
 const f=await fixture(t);await mutate(f);const service=f.service();await assert.rejects(service.supply(f.signal()),status(503));const res=new Response();await assert.rejects(service.runtime(f.first.file,f.signal(),res),status(503));assert.equal(res.body.length,0);assert.equal(f.calls.length,0);
});
test('Unbuilt platforms and historical dev versions are refused without claiming catalog readiness',async t=>{
 const f=await fixture(t),service=f.service();await assert.rejects(service.supply(f.signal(),'9.8.6'),status(404));for(const file of [f.first.file.replace('9.8.7','9.8.6'),f.first.file.replace(target,target==='linux-x64'?'darwin-arm64':'linux-x64')])await assert.rejects(service.runtime(file,f.signal(),new Response()),status(404));assert.equal(f.calls.length,0);
});
test('Symbolic links for pointer, generation and archive cannot redirect development reads',async t=>{
 const f=await fixture(t),service=f.service();for(const filename of [path.join(f.root,'current.json'),f.first.folder,f.first.archive]){const moved=filename+'.moved';await fs.rename(filename,moved);await fs.symlink(moved,filename);await assert.rejects(service.supply(f.signal()),status(503));await fs.rm(filename);await fs.rename(moved,filename);}assert.equal(f.calls.length,0);
});
test('A dangling pointer is an invalid existing pointer and cannot silently fall back to catalog',async t=>{
 const f=await fixture(t);await fs.rm(path.join(f.root,'current.json'));await fs.symlink('missing-pointer',path.join(f.root,'current.json'));await assert.rejects(f.service().supply(f.signal()),status(503));assert.equal(f.calls.length,0);
});
test('Replacing the archive pathname after admission cannot change bytes from its open generation',async t=>{
 const f=await fixture(t),res=new Response();let changed=false;res.onHeader=key=>{if(key==='cache-control'&&!changed){changed=true;syncFs.renameSync(f.first.archive,f.first.archive+'.old');syncFs.writeFileSync(f.first.archive,Buffer.alloc(f.first.payload.length));}};await f.service().runtime(f.first.file,f.signal(),res);assert.equal(changed,true);assert.deepEqual(res.body,f.first.payload);assert.equal(res.writableFinished,true);assert.equal(f.calls.length,0);
});
test('Disconnecting an admitted dev download closes its stream without cancelling a later request',async t=>{
 const f=await fixture(t),service=f.service(),abort=new AbortController(),res=new Response();res.onHeader=key=>{if(key==='cache-control')abort.abort();};await service.runtime(f.first.file,abort.signal,res);assert.equal(res.body.length,0);assert.equal(abort.signal.aborted,true);const retry=new Response();await service.runtime(f.first.file,f.signal(),retry);assert.deepEqual(retry.body,f.first.payload);assert.equal(retry.writableFinished,true);assert.equal(f.calls.length,0);
});
test('Growing a pointer after its file stat cannot bypass the bounded metadata admission',async t=>{
 const f=await fixture(t),open=fs.open;let changed=false;
 t.mock.method(fs,'open',async(file,...options)=>{
  const handle=await open(file,...options);
  if(file===path.join(f.root,'current.json')){const stat=handle.stat.bind(handle);handle.stat=async(...args)=>{const info=await stat(...args);if(!changed){changed=true;await fs.appendFile(file,' '.repeat(8192));}return info;};}
  return handle;
 });
 await assert.rejects(f.service().supply(f.signal()),status(503));assert.equal(changed,true);assert.equal(f.calls.length,0);
});
test('A pointer growing during reads is bounded to its byte limit and never reaches catalog fallback',async t=>{
 const f=await fixture(t),open=fs.open;let changed=false,received=0;
 t.mock.method(fs,'open',async(file,...options)=>{
  const handle=await open(file,...options);
  if(file===path.join(f.root,'current.json')){const read=handle.read.bind(handle);handle.read=async(...args)=>{const result=await read(...args);received+=result.bytesRead;if(!changed&&result.bytesRead){changed=true;await fs.appendFile(file,' '.repeat(16384));}return result;};}
  return handle;
 });
 await assert.rejects(f.service().supply(f.signal()),status(503));assert.equal(changed,true);assert.ok(received<=8193);assert.equal(f.calls.length,0);
});
test('In-place same-size metadata mutation during read is refused before archive output',async t=>{
 const f=await fixture(t),open=fs.open;let changed=false;
 t.mock.method(fs,'open',async(file,...options)=>{
  const handle=await open(file,...options);
  if(file===path.join(f.root,'current.json')){const read=handle.read.bind(handle);handle.read=async(...args)=>{const result=await read(...args);if(!changed&&result.bytesRead){changed=true;const bytes=await fs.readFile(file,'utf8');await fs.writeFile(file,bytes.replace('c'.repeat(40),'d'.repeat(40)));await fs.utimes(file,Date.now()/1000+10,Date.now()/1000+10);}return result;};}
  return handle;
 });
 const res=new Response();await assert.rejects(f.service().runtime(f.first.file,f.signal(),res),status(503));assert.equal(changed,true);assert.equal(res.body.length,0);assert.equal(f.calls.length,0);
});
test('A linked pointer rewrite cannot hide behind a restored mtime on its original pathname',async t=>{
 const f=await fixture(t),file=path.join(f.root,'current.json'),open=fs.open,fixedTime=1700000000;await fs.utimes(file,fixedTime,fixedTime);let changed=false;
 t.mock.method(fs,'open',async(selected,...options)=>{const handle=await open(selected,...options);if(selected===file){const read=handle.read.bind(handle);handle.read=async(...args)=>{const result=await read(...args);if(!changed&&result.bytesRead){changed=true;const original=await fs.readFile(file,'utf8');await fs.writeFile(file,original.replace('c'.repeat(40),'d'.repeat(40)));await fs.utimes(file,fixedTime,fixedTime);}return result;};}return handle;});
 await assert.rejects(f.service().supply(f.signal()),status(503));assert.equal(changed,true);assert.equal((await fs.stat(file)).mtimeMs,fixedTime*1000);assert.equal(f.calls.length,0);
});
test('Replacing current.json during an open read retains one coherent old generation and then observes the next',async t=>{
 const f=await fixture(t),next=await f.generation(Buffer.from('next pointer generation')),open=fs.open;let published=false;
 t.mock.method(fs,'open',async(file,...options)=>{
  const handle=await open(file,...options);
  if(file===path.join(f.root,'current.json')){const read=handle.read.bind(handle);handle.read=async(...args)=>{const result=await read(...args);if(!published&&result.bytesRead){published=true;await f.publish(next);}return result;};}
  return handle;
 });
 const service=f.service();assert.equal((await service.supply(f.signal())).buildId,f.first.pointer.buildId);assert.equal(published,true);assert.equal((await service.supply(f.signal())).buildId,next.pointer.buildId);assert.equal(f.calls.length,0);
});
for(const disconnect of ['request','response'])test('Disconnect '+disconnect+' during the real archive hash destroys only that stream and closes its file handle',async t=>{
 const f=await fixture(t),open=fs.open,req=Object.assign(new EventEmitter(),{aborted:false}),res=new Response();let cancelled=false;const streams=[],handles=[];
 t.mock.method(fs,'open',async(file,...options)=>{
  const handle=await open(file,...options);
  if(file===f.first.archive){handles.push(handle);const create=handle.createReadStream.bind(handle);handle.createReadStream=options=>{const stream=create(options);streams.push(stream);stream.once('data',()=>{if(!cancelled){cancelled=true;if(disconnect==='request'){req.aborted=true;req.emit('aborted');}else res.destroy();}});return stream;};}
  return handle;
 });
 const service=f.service();await bridgeRequest(req,res,signal=>service.runtime(f.first.file,signal,res));assert.equal(cancelled,true);assert.equal(res.body.length,0);assert.equal(streams[0].destroyed,true);assert.equal(handles.length,1);assert.equal(handles[0].fd,-1);assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
 const retry=new Response();await service.runtime(f.first.file,f.signal(),retry);assert.deepEqual(retry.body,f.first.payload);assert.equal(handles.length,2);assert.ok(handles.every(handle=>handle.fd===-1));assert.equal(f.calls.length,0);
});
test('Archive stat mutation during its real hash invalidates the snapshot before response headers',async t=>{
 const f=await fixture(t),open=fs.open;let changed=false;
 t.mock.method(fs,'open',async(file,...options)=>{const handle=await open(file,...options);if(file===f.first.archive){const create=handle.createReadStream.bind(handle);handle.createReadStream=options=>{const stream=create(options);stream.once('data',()=>{if(!changed){changed=true;syncFs.utimesSync(file,Date.now()/1000+10,Date.now()/1000+10);}});return stream;};}return handle;});
 const res=new Response();await assert.rejects(f.service().runtime(f.first.file,f.signal(),res),status(503));assert.equal(changed,true);assert.equal(res.body.length,0);assert.equal(res.headers['content-length'],undefined);assert.equal(f.calls.length,0);
});
test('In-place archive corruption after admission destroys the response and a restored archive can retry',async t=>{
 const f=await fixture(t),service=f.service(),res=new Response();let changed=false;res.onHeader=key=>{if(key==='cache-control'&&!changed){changed=true;syncFs.writeFileSync(f.first.archive,Buffer.alloc(f.first.payload.length));}};
 await service.runtime(f.first.file,f.signal(),res);assert.equal(changed,true);assert.equal(res.destroyed,true);assert.equal(res.writableFinished,false);await fs.writeFile(f.first.archive,f.first.payload);const retry=new Response();await service.runtime(f.first.file,f.signal(),retry);assert.deepEqual(retry.body,f.first.payload);assert.equal(f.calls.length,0);
});
for(const suffix of ['current.json','','.json','.sha256'])test('A hard-linked dev file is rejected before output: '+JSON.stringify(suffix),async t=>{
 const f=await fixture(t),file=suffix==='current.json'?path.join(f.root,suffix):f.first.archive+suffix;await fs.link(file,file+'.other-owner');const res=new Response();await assert.rejects(f.service().runtime(f.first.file,f.signal(),res),status(503));assert.equal(res.body.length,0);assert.equal(f.calls.length,0);
});
test('Symlinked sidecars and dev roots cannot redirect reads or silently fall back',async t=>{
 const f=await fixture(t);for(const suffix of ['.json','.sha256']){const file=f.first.archive+suffix,backup=file+'.moved';await fs.rename(file,backup);await fs.symlink(backup,file);await assert.rejects(f.service().supply(f.signal()),status(503));await fs.unlink(file);await fs.rename(backup,file);}
 const alias=path.join(f.root,'root-alias');await fs.symlink(f.root,alias);await assert.rejects(f.service('development',alias).supply(f.signal()),status(503));const nested=path.join(f.root,'nested');await fs.mkdir(nested);await assert.rejects(f.service('development',path.join(alias,'nested')).supply(f.signal()),status(503));assert.equal(f.calls.length,0);
});
for(const point of ['root','pointer'])test('An unavailable '+point+' is an error rather than an absent-pointer fallback',async t=>{
 const f=await fixture(t),lstat=fs.lstat,file=point==='root'?f.root:path.join(f.root,'current.json');t.mock.method(fs,'lstat',async(value,...args)=>{if(value===file)throw Object.assign(Error('owned fixture denial'),{code:'EACCES'});return lstat(value,...args);});await assert.rejects(f.service().supply(f.signal()),status(503));assert.equal(f.calls.length,0);
});
for(const[caseName,change]of[
 ['metadata target',value=>{value.target=target==='linux-x64'?'darwin-arm64':'linux-x64';}],
 ['metadata version',value=>{value.version='9.8.6';}],
 ['rag flag',value=>{value.ragSupported='true';}],
 ['probe path',value=>{value.probeEngine.file='../opencode';}],
 ['probe checksum',value=>{value.probeEngine.sha256='broken';}],
 ['Windows helper checksum',value=>{value.windowsJobHelper={file:'bin/neurocenter-job.exe',sha256:'broken'};}],
])test('Host runtime metadata refuses an invalid '+caseName,async t=>{
 const f=await fixture(t);change(f.first.metadata);await fs.writeFile(f.first.archive+'.json',JSON.stringify(f.first.metadata));await assert.rejects(f.service().supply(f.signal()),status(503));assert.equal(f.calls.length,0);
});
test('A missing generation, oversized sidecar and relative dev directory all fail without fallback',async t=>{
 const f=await fixture(t),service=f.service();f.first.pointer.directory='generation-not-created';await f.publish(f.first);await assert.rejects(service.supply(f.signal()),status(503));f.first.pointer.directory=path.basename(f.first.folder);await f.publish(f.first);await fs.appendFile(f.first.archive+'.json',' '.repeat(65536));await assert.rejects(service.supply(f.signal()),status(503));await assert.rejects(f.service('development','relative-path').supply(f.signal()),status(503));assert.equal(f.calls.length,0);
});
test('Invalid public version and path are rejected before any local filesystem admission',async t=>{
 const f=await fixture(t),service=f.service('development','not-an-absolute-path');for(const version of ['latest','9.8.7-beta','../9.8.7'])await assert.rejects(service.supply(f.signal(),version),status(404));for(const file of ['../runtime.tgz','neurocenter-asset-sync-'+target+'-latest.tgz'])await assert.rejects(service.runtime(file,f.signal(),new Response()),status(404));assert.equal(f.calls.length,0);
});
test('A missing dev pointer followed by catalog transport failure reports unavailability without another fallback',async t=>{
 const f=await fixture(t);await fs.rm(path.join(f.root,'current.json'));const service=f.service();let calls=0;service.http.get=async()=>{calls++;throw Object.assign(Error('owned upstream reset'),{code:'ECONNRESET'});};const res=new Response();await assert.rejects(service.runtime(f.first.file,f.signal(),res),status(503));assert.equal(calls,1);assert.equal(res.body.length,0);
});
