const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{spawn}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises');
const directory=process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const status503=error=>error.getStatus?.()===503;

/** Each child has native stream error semantics: no uncaughtException or unhandled error hook. */
async function childCase(mode,root){
    const requireGateway=require('node:module').createRequire(path.join(directory,'entry.cjs'));requireGateway('reflect-metadata');
    const {readDevBridgeRuntime}=require(path.join(directory,'bridge/dev-bridge-runtime.js'));
    const target=({darwin:'darwin',linux:'linux',win32:'windows'})[process.platform]+'-'+process.arch+(process.platform==='linux'&&!process.report.getReport().header.glibcVersionRuntime?'-musl':'');
    const version='9.8.7',buildId='b'.repeat(64),generation=path.join(root,'generation-owned'),file=`neurocenter-asset-sync-${target}-${version}.tgz`,archive=path.join(generation,file),bytes=Buffer.alloc(1024*1024+37,0x6a);
    await fs.mkdir(generation);await fs.writeFile(archive,bytes);
    const metadata={version,target,buildId,nodeVersion:process.versions.node,ragSupported:true,probeEngine:{version:'1.14.48',file:'bin/opencode-probe'+(process.platform==='win32'?'.exe':''),sha256:'d'.repeat(64)},sha256:sha(bytes),bytes:bytes.length};
    await fs.writeFile(archive+'.json',JSON.stringify(metadata));await fs.writeFile(archive+'.sha256',metadata.sha256+'\n');await fs.writeFile(path.join(root,'current.json'),JSON.stringify({version,target,buildId,directory:path.basename(generation),sourceCommit:'c'.repeat(40)}));
    const abort=new AbortController(),open=fs.open,handles=[],streams=[];let injected=false,gate,abortObserved,operationDone,gateEnabled=false;
    fs.open=async(filename,...args)=>{
        const handle=await open(filename,...args);if(filename!==archive)return handle;handles.push(handle);
        const stat=handle.stat.bind(handle),create=handle.createReadStream.bind(handle);let count=0;
        handle.stat=async(...args)=>{const value=await stat(...args);if(++count===2){
            if(mode==='after-stat'){injected=true;abort.abort(Error('Owned request cancelled after file stat'));}
            if(gateEnabled)await new Promise(resolve=>gate({release:resolve}));
        }return value;};
        handle.createReadStream=options=>{const stream=create(options);streams.push(stream);
            if(!injected&&mode==='during-create'){injected=true;abort.abort(Error('Owned cancellation during stream creation'));}
            if(!injected&&mode==='during-read')stream.once('data',()=>{injected=true;abort.abort(Error('Owned cancellation during actual hash'));});
            return stream;
        };return handle;
    };
    let httpProof;
    try{
        if(mode==='http-pressure'){
            const http=require('node:http'),{Module}=requireGateway('@nestjs/common'),{NestFactory}=requireGateway('@nestjs/core');
            const {BridgeController}=require(path.join(directory,'bridge/bridge.controller.js')),{BridgeSupplyService}=require(path.join(directory,'bridge/bridge-supply.service.js'));
            const service=new BridgeSupplyService({get:key=>({NODE_ENV:'development',DEV_BRIDGE_RUNTIME_DIR:root})[key]});let sourceCalls=0;
            service.http.get=async()=>{sourceCalls++;throw Error('Unexpected Catalog call');};
            const development=service.developmentSupply.bind(service);service.developmentSupply=async signal=>{try{return await development(signal);}finally{operationDone?.();}};
            class FixtureModule{}Module({controllers:[BridgeController],providers:[{provide:BridgeSupplyService,useValue:service}]})(FixtureModule);
            const app=await NestFactory.create(FixtureModule,{logger:false});let server;const requests=[];
            app.use((req,res,next)=>{req.once('aborted',()=>abortObserved?.());res.once('close',()=>abortObserved?.());next();});
            try{
                await app.listen(0,'127.0.0.1');server=app.getHttpServer();const port=server.address().port;assert.ok(![4000,5173].includes(port));
                gateEnabled=true;
                for(let round=0;round<8;round++){
                    let atStat,seen,done;const admitted=new Promise(resolve=>atStat=resolve),aborted=new Promise(resolve=>seen=resolve),finished=new Promise(resolve=>done=resolve);
                    gate=atStat;abortObserved=seen;operationDone=done;
                    const req=http.get({hostname:'127.0.0.1',port,path:'/api/bridge/config',agent:false});requests.push(req);req.on('error',()=>{});
                    const current=await admitted;req.destroy();await aborted;current.release();await finished;await delay(5);
                }
                gateEnabled=false;operationDone=undefined;abortObserved=undefined;
                const result=await new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port,path:'/api/bridge/config',agent:false},res=>{const parts=[];res.on('data',value=>parts.push(value));res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(parts))}));});requests.push(req);req.once('error',reject);req.setTimeout(3000,()=>req.destroy(Error('Own HTTP deadline')));});
                assert.equal(result.status,200);assert.equal(result.body.devSupply.buildId,buildId);assert.equal(sourceCalls,0);httpProof={abortedRequests:8,retryStatus:result.status,catalogCalls:sourceCalls};
            }finally{for(const req of requests)req.destroy();server?.closeAllConnections();await app.close();assert.equal(server?.listening,false);}
        }else if(['after-stat','during-create','during-read'].includes(mode)){
            await assert.rejects(readDevBridgeRuntime(root,abort.signal),status503);assert.equal(injected,true);assert.ok(handles.every(handle=>handle.fd===-1));
            const retry=await readDevBridgeRuntime(root,new AbortController().signal);assert.equal(retry.artifact.sha256,metadata.sha256);assert.ok(retry.archive.fd>=0);await retry.archive.close();
        }else{
            if(mode==='corruption')await fs.writeFile(archive,Buffer.alloc(bytes.length,0x00));
            if(mode==='corruption'){await assert.rejects(readDevBridgeRuntime(root,abort.signal),status503);assert.ok(handles.every(handle=>handle.fd===-1));}
            else{
                const result=await readDevBridgeRuntime(root,abort.signal),chunks=[];assert.ok(result.archive.fd>=0);
                for await(const value of result.archive.createReadStream({start:0,autoClose:false}))chunks.push(value);
                assert.deepEqual(Buffer.concat(chunks),bytes);await result.archive.close();
            }
        }
        await delay(30);assert.ok(handles.every(handle=>handle.fd===-1));
        return{mode,injected,handles:handles.length,openHandles:handles.filter(handle=>handle.fd!==-1).length,streams:streams.length,httpProof};
    }finally{fs.open=open;for(const handle of handles)if(handle.fd!==-1)await handle.close();}
}

if(process.argv[2]==='--child'){
    childCase(process.argv[3],process.argv[4]).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
}else{
    const {test,after}=require('node:test'),proofs=[];
    for(const mode of ['after-stat','during-create','during-read','success','corruption','http-pressure'])test('Dev archive survives '+mode+' without an uncaught stream error or leaked file handle',async()=>{
        const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-dev-abort-race-'))),evidence={mode,root};proofs.push(evidence);let result;
        try{
            const env={...process.env,NODE_ENV:'test',HOME:path.join(root,'home')};for(const key of ['NODE_OPTIONS','NODE_V8_COVERAGE','NODE_USE_ENV_PROXY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[key];
            result=await new Promise((resolve,reject)=>{
                const child=spawn(process.execPath,[__filename,'--child',mode,root],{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
                const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('Own abort child exceeded deadline'));},20000);
                child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({pid:child.pid,code,signal,stdout,stderr});});
            });
            Object.assign(evidence,result);assert.throws(()=>process.kill(result.pid,0),{code:'ESRCH'});evidence.exited=true;
            assert.equal(result.code,0,result.stderr);assert.equal(result.signal,null);const proof=JSON.parse(result.stdout);assert.equal(proof.openHandles,0);evidence.proof=proof;
        }finally{await fs.rm(root,{recursive:true,force:true});evidence.temporaryRemoved=await fs.stat(root).then(()=>false,error=>error.code==='ENOENT');assert.equal(evidence.temporaryRemoved,true);}
    });
    after(async()=>{if(process.env.BRIDGE_ABORT_RACE_PROOF)await fs.writeFile(process.env.BRIDGE_ABORT_RACE_PROOF,JSON.stringify(proofs,null,2)+'\n',{flag:'wx',mode:0o600});});
}
