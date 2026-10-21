import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {packRuntime} from '../catalog-plugins/pack.mjs';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../services/shared/feature-flags.cjs';
const require=createRequire(new URL('../../services/api-gateway/package.json',import.meta.url));
require('reflect-metadata');
const {Module}=require('@nestjs/common'),{NestFactory}=require('@nestjs/core');
const {ResearchMcpController}=require('./dist/features/research-mcp/research-mcp.controller.js');
const {McpHostService}=require('./dist/features/mcp-host/host.js');
const {materializeArtifact}=require('./dist/features/mcp-host/artifact-cache.js');
const {researchPackage}=require('./dist/features/research-mcp/research-package.js');
const {hostRuntimeTarget}=require('./dist/features/mcp-host/host-target.js');
const requireCatalog=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {buildPackage}=requireCatalog('./dist/catalog/bundle-package.js');

test('Actual Gateway HTTP → verified native artifact → stdio MCP preserves gates, cache integrity and shutdown',{timeout:60000},async t=>{
 const previous={...process.env},directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc-research-http-'));
 const source=path.join(directory,'source');await fs.mkdir(source);
 const counter=path.join(directory,'actual-calls.txt');
 const code=`const fs=require('node:fs');const r=require('node:readline').createInterface({input:process.stdin});const tools=['web_search_exa','web_fetch_exa'].map(name=>({name,inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true,destructiveHint:false}}));let calls=0;
r.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;if(q.method==='tools/call')fs.appendFileSync(${JSON.stringify(counter)},'call\\n');let result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-search',version:'1'}}:q.method==='tools/list'?{tools}:q.method==='tools/call'?{content:[{type:'text',text:'Synthetic public evidence https://example.com/source; call '+(++calls)}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`;
 await fs.writeFile(path.join(source,'server.cjs'),code);
 const archive=path.join(directory,'runtime.tar.gz'),descriptor=await packRuntime({directory:source,archivePath:archive,target:hostRuntimeTarget(),entrypoint:'server.cjs'}),bytes=await fs.readFile(archive);
 let flags=defaultFeatureFlags(),downloads=0,corrupt=false;
 const upstream=createServer((req,res)=>{
  if(req.headers['x-neurocenter-internal']!=='qa-research-internal'){res.writeHead(403).end();return;}
  if(req.url==='/internal/feature-flags/evaluated'){res.setHeader('content-type','application/json');res.end(JSON.stringify(evaluateFeatureFlags(flags)));return;}
  if(req.url==='/internal/mcp-host/artifact/'+descriptor.sha256){downloads++;res.setHeader('content-type','application/gzip');res.setHeader('x-neurocenter-unpacked-bytes',descriptor.unpackedBytes);res.setHeader('x-neurocenter-files-count',descriptor.filesCount);
   const output=Buffer.from(bytes);if(corrupt)output[20]^=1;res.end(output);return;}
  res.writeHead(404).end();
 });
 await new Promise(done=>upstream.listen(0,'127.0.0.1',done));const base='http://127.0.0.1:'+upstream.address().port;
 Object.assign(process.env,{NEUROCENTER_INTERNAL_TOKEN:'qa-research-internal',FEATURE_FLAGS_SERVICE_URL:base,NEUROCENTER_MCP_HOST_DIR:path.join(directory,'cache')});
 const host=new McpHostService(base,'qa-research-internal');let app;
 t.after(async()=>{try{if(app)await app.close();else await host.onModuleDestroy();await new Promise(done=>upstream.close(done));}finally{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);await fs.rm(directory,{recursive:true,force:true});}});
 class Fixture{}Module({controllers:[ResearchMcpController],providers:[{provide:'MCP_HOST',useValue:host}]})(Fixture);
 app=await NestFactory.create(Fixture,{logger:false,abortOnError:false});await app.listen(0,'127.0.0.1');
 const url='http://127.0.0.1:'+app.getHttpServer().address().port;
 const pkg=buildPackage({id:'synthetic-exa',kind:'mcp',version:1,name:'Synthetic Research'},[],'',{
  transport:'stdio',args:[],extra:{hostedMcp:true,researchMcp:{adapter:'exa',tools:['web_search_exa','web_fetch_exa']},runtimeArtifacts:[descriptor]}});
 const request=async(route,body,token='qa-research-internal')=>{
  const response=await fetch(url+'/internal/research-mcp/'+route,{method:'POST',headers:{'content-type':'application/json','x-neurocenter-internal':token},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  return {status:response.status,data:await response.json()};
 };
 await t.test('internal-only and off capabilities cannot download or execute a host',async()=>{
  assert.equal((await request('list',{pkg},'wrong')).status,403);flags.research_tools=false;
  assert.equal((await request('list',{pkg})).status,403);assert.equal(downloads,0);flags.research_tools=true;
 });
 await t.test('actual artifact starts and search output returns bounded source evidence',async()=>{
  const listed=await request('list',{pkg});assert.equal(listed.status,201,JSON.stringify(listed.data));assert.equal(listed.data.tools.length,2);assert.equal(downloads,1);
  const result=await request('call',{pkg,name:'web_search_exa',arguments:{query:'synthetic test',objective:'verify transport'}});
  assert.equal(result.status,201,JSON.stringify(result.data));assert.match(result.data.text,/call 1/);assert.deepEqual(result.data.sources,[{url:'https://example.com/source'}]);
  assert.equal((await request('call',{pkg,name:'execute_shell',arguments:{command:'never'}})).status,400);
  flags.tool_catalog=false;assert.equal((await request('call',{pkg,name:'web_search_exa',arguments:{query:'q',objective:'o'}})).status,403);flags.tool_catalog=true;
  assert.equal((await fs.readFile(counter,'utf8')).trim().split('\n').length,1);
  const second=await request('call',{pkg,name:'web_search_exa',arguments:{query:'q',objective:'o'}});assert.match(second.data.text,/call 1/);
  assert.equal((await fs.readFile(counter,'utf8')).trim().split('\n').length,2);assert.equal(host.hosts.size,0,'each internal request releases its private child');
 });
 await t.test('cache corruption triggers verified rehydration and changed download bytes cannot publish',async()=>{
  await host.onModuleDestroy();const claim=researchPackage(pkg),filename=path.join(process.env.NEUROCENTER_MCP_HOST_DIR,'artifacts',descriptor.sha256,'server.cjs');
  await fs.chmod(filename,0o600);await fs.writeFile(filename,'modified');
  const legacy={...claim};delete legacy.unpackedBytes;delete legacy.filesCount;
  await materializeArtifact(legacy,base,'qa-research-internal');assert.equal(await fs.readFile(filename,'utf8'),code);assert.equal(downloads,2);
  await fs.chmod(filename,0o600);await fs.writeFile(filename,'corrupted again');corrupt=true;
  await assert.rejects(materializeArtifact(claim,base,'qa-research-internal'),/Комплект хоста недоступен/);assert.equal(downloads,3);await assert.rejects(fs.stat(filename),{code:'ENOENT'});
 });
});
