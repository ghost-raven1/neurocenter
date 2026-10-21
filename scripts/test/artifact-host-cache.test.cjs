const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createServer}=require('node:http');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const dist=process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist');

for(const failure of ['ENOSPC','EACCES'])test('Gateway artifact cache survives '+failure+' under backpressure without unhandled rejection or leaked stage',{timeout:15000},async t=>{
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-host-cache-fault-'))),bytes=Buffer.alloc(256*1024,65),sha=createHash('sha256').update(bytes).digest('hex');
 const upstream=createServer((req,res)=>{if(req.headers['x-neurocenter-internal']!=='qa-only'){res.writeHead(403).end();return;}res.setHeader('content-type','application/gzip');res.end(bytes);});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>upstream.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
 const modulePath=path.join(dist,'features/mcp-host/artifact-cache.js'),base='http://127.0.0.1:'+upstream.address().port;
 // A separate strict process proves the Gateway code survives; no actual disk exhaustion or user path is involved.
 const source=`const assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),{Writable}=require('node:stream');
 process.env.NEUROCENTER_MCP_HOST_DIR=${JSON.stringify(directory)};
 const original=fs.createWriteStream;let faulted=false;
 fs.createWriteStream=function(file,options){if(path.basename(file)==='artifact.tar.gz'){faulted=true;return new Writable({highWaterMark:1,write(chunk,encoding,callback){setImmediate(()=>callback(Object.assign(new Error('Synthetic ${failure}'),{code:'${failure}'})));}});}return original.call(this,file,options);};
 const {materializeArtifact}=require(${JSON.stringify(modulePath)});
 (async()=>{await assert.rejects(materializeArtifact({artifactSha256:${JSON.stringify(sha)},entrypoint:'entrypoint.mjs',executable:false,name:'QA',compressedBytes:${bytes.length},unpackedBytes:1,filesCount:1,exp:Date.now()+60000},${JSON.stringify(base)},'qa-only'),/Комплект хоста недоступен/);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(faulted,true);assert.deepEqual(await fsp.readdir(path.join(process.env.NEUROCENTER_MCP_HOST_DIR,'building')),[]);await assert.rejects(fsp.stat(path.join(process.env.NEUROCENTER_MCP_HOST_DIR,'artifacts',${JSON.stringify(sha)},'.ready')),{code:'ENOENT'});console.log(JSON.stringify({alive:true,faulted,stageClean:true,readyPublished:false}));})().catch(error=>{console.error(error);process.exitCode=1;});`;
 const child=spawn(process.execPath,['--unhandled-rejections=strict','-e',source],{stdio:['ignore','pipe','pipe']});let output='',error='';
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);const timer=setTimeout(()=>child.kill('SIGKILL'),7000);
 const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);
 assert.equal(exit.signal,null,'Artifact writer hung: '+error);assert.equal(exit.code,0,'Gateway process failed: '+error);assert.deepEqual(JSON.parse(output),{alive:true,faulted:true,stageClean:true,readyPublished:false});
});
