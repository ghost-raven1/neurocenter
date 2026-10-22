const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const syncFs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {createHash}=require('node:crypto');
const {EventEmitter}=require('node:events');
const {Writable}=require('node:stream');
const directory=process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist');
require('node:module').createRequire(path.join(directory,'entry.cjs'))('reflect-metadata');
const {BridgeController}=require(path.join(directory,'bridge/bridge.controller.js'));
const {BridgeSupplyService}=require(path.join(directory,'bridge/bridge-supply.service.js'));
class Response extends Writable{
    constructor(){super();this.headers={};this.parts=[];this.headersSent=false;this.on('error',()=>{});}
    _write(chunk,_encoding,done){this.headersSent=true;this.parts.push(Buffer.from(chunk));done();}
    setHeader(key,value){this.headers[key.toLowerCase()]=String(value);this.onHeader?.(key);}
    removeHeader(key){delete this.headers[key.toLowerCase()];}
    send(value){this.end(value);}
    get body(){return Buffer.concat(this.parts);}
}
const request=(file,query={download:'1'})=>Object.assign(new EventEmitter(),{params:{file},query,headers:{},aborted:false});
/** Tiny local dev bytes and an actual loopback Catalog prove headers on both delivery paths. */
async function fixture(t,mode){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-bridge-download-'))),payload=Buffer.from('owned archive bytes'),version='9.8.7';
    const target=({darwin:'darwin',linux:'linux',win32:'windows'})[process.platform]+'-'+process.arch+(process.platform==='linux'&&!process.report.getReport().header.glibcVersionRuntime?'-musl':'');
    const file=`neurocenter-asset-sync-${target}-${version}.tgz`,buildId='b'.repeat(64),sha256=createHash('sha256').update(payload).digest('hex');
    const metadata={version,target,buildId,sha256,bytes:payload.length,nodeVersion:'24.22.0',ragSupported:true,probeEngine:{version:'1.14.48',file:'bin/opencode-probe'+(target.startsWith('windows-')?'.exe':''),sha256:'d'.repeat(64)}};
    const supply={assetId:'neurocenter-bridge',version,buildId,sourceCommit:'c'.repeat(40),artifacts:[{file,target,sha256,bytes:payload.length,metadata}]};
    const folder=path.join(root,'generation-one'),archive=path.join(folder,file);await fs.mkdir(folder);await fs.writeFile(archive,payload);
    await fs.writeFile(archive+'.json',JSON.stringify(metadata));await fs.writeFile(archive+'.sha256',sha256+'\n');
    await fs.writeFile(path.join(root,'current.json'),JSON.stringify({version,buildId,target,directory:'generation-one',sourceCommit:'c'.repeat(40)}));
    const calls=[],state={status:200,wrongBlob:false};
    const server=http.createServer((req,res)=>{
        calls.push(req.url);if(req.url.startsWith('/internal/asset-sources/bridge')){res.writeHead(state.status,{'content-type':'application/json'});res.end(JSON.stringify(supply));}
        else {res.writeHead(200,{'content-length':payload.length,etag:'"'+(state.wrongBlob?'f'.repeat(64):sha256)+'"'});res.end(payload);}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});await assert.rejects(fs.stat(root),{code:'ENOENT'});assert.equal(server.listening,false);});
    const settings={NODE_ENV:mode,DEV_BRIDGE_RUNTIME_DIR:root,CATALOG_SERVICE_URL:`http://127.0.0.1:${server.address().port}`};
    const service=new BridgeSupplyService({get:key=>settings[key]}),controller=new BridgeController(service);
    return{controller,service,file,metadata,payload,archive,state,calls,send:async(suffix='',query,reqOverride,res=new Response())=>{
        const req=reqOverride||request(file+suffix,query),on=res.on;let admissionClose;
        res.on=function(event,listener){if(event==='close'&&!admissionClose)admissionClose=listener;return on.call(this,event,listener);};
        try{await controller.runtime(req,res);}finally{res.on=on;}
        // Pipeline retains its own lifecycle listeners; the admission handler must be detached.
        assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listeners('close').includes(admissionClose),false);return res;
    }};
}
for(const mode of ['development','production']){
    for(const suffix of ['', '.sha256','.json'])test(mode+' downloads '+(suffix||'archive')+' with exact safe filename and bytes',async t=>{
        const f=await fixture(t,mode),res=await f.send(suffix);assert.equal(res.headers['content-disposition'],'attachment; filename="'+f.file+suffix+'"');
        assert.equal(res.headers['cache-control'],'no-store');
        if(!suffix)assert.deepEqual(res.body,f.payload);else if(suffix==='.sha256')assert.equal(res.body.toString(),f.metadata.sha256+'\n');else assert.deepEqual(JSON.parse(res.body),f.metadata);
        if(mode==='development')assert.deepEqual(f.calls,[]);
    });
    test(mode+' preserves inline metadata for ordinary fetch and ignores ambiguous download switches',async t=>{
        const f=await fixture(t,mode);
        for(const query of [{},{download:'true'},{download:['1']}]){const res=await f.send('.json',query);assert.equal(res.headers['content-disposition'],undefined);assert.deepEqual(JSON.parse(res.body),f.metadata);}
    });
    test(mode+' rejects a filename containing header characters before attachment or upstream lookup',async t=>{
        const f=await fixture(t,mode),res=new Response();await assert.rejects(f.controller.runtime(request(f.file+'\r\nx: unsafe'),res),error=>error.getStatus?.()===404);
        assert.equal(res.headers['content-disposition'],undefined);assert.deepEqual(f.calls,[]);assert.equal(res.body.length,0);
    });
    test(mode+' missing archive fails without a successful-download header',async t=>{
        const f=await fixture(t,mode),res=new Response();if(mode==='development')await fs.unlink(f.archive);else f.state.status=404;
        await assert.rejects(f.controller.runtime(request(f.file),res));assert.equal(res.headers['content-disposition'],undefined);assert.equal(res.body.length,0);
    });
    test(mode+' cancellation before selection does not read an archive or leak a listener',async t=>{
        const f=await fixture(t,mode),req=request(f.file);req.aborted=true;const res=await f.send('',undefined,req);
        assert.equal(res.body.length,0);assert.equal(res.headers['content-disposition'],undefined);assert.deepEqual(f.calls,[]);
    });
    test(mode+' failed transfer before bytes clears its download header and a later request remains usable',async t=>{
        const f=await fixture(t,mode),res=new Response();
        if(mode==='production')f.state.wrongBlob=true;else res.onHeader=key=>{if(key==='cache-control')syncFs.truncateSync(f.archive,0);};
        if(mode==='production'){
            await assert.rejects(f.controller.runtime(request(f.file),res),error=>error.getStatus?.()===503);
            assert.equal(res.headers['content-disposition'],undefined);
        }else{
            await f.controller.runtime(request(f.file),res);assert.equal(res.destroyed,true);assert.equal(res.headersSent,false);
        }
        assert.equal(res.body.length,0);
        if(mode==='production')f.state.wrongBlob=false;else await fs.writeFile(f.archive,f.payload);
        assert.deepEqual((await f.send()).body,f.payload);
    });
}
