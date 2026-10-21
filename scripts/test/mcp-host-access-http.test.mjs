import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import {packRuntime} from '../catalog-plugins/pack.mjs';
import {startSkillPackagingFixture} from './skill-packaging.fixture.mjs';

const require=createRequire(new URL('../../services/api-gateway/package.json',import.meta.url));
const catalogRequire=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
require('reflect-metadata');
const {Module}=require('@nestjs/common'),{NestFactory}=require('@nestjs/core'),{ConfigService}=require('@nestjs/config');
const {AuthGuardService}=require('./dist/auth/auth-guard.service.js');
const {McpHostController}=require('./dist/features/mcp-host/mcp-host.controller.js');
const {hostRuntimeTarget}=require('./dist/features/mcp-host/host-target.js');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {buildPackage}=catalogRequire('./dist/catalog/bundle-package.js');
const {RuntimeArtifacts}=catalogRequire('./dist/runtime-artifacts/runtime-artifacts.js');

test('Hosted MCP real Gateway → Catalog → artifact → SDK channel checks fresh project access',{skip:!process.env.CATALOG_TEST_PG_URL,timeout:120000},async t=>{
 const f=await startSkillPackagingFixture({adminUrl:process.env.CATALOG_TEST_PG_URL});let app,client;
 t.after(async()=>{await client?.close();await app?.close();await f.close();});
 process.env.NEUROCENTER_MCP_HOST_DIR=path.join(f.temporary,'host-cache');
 const source=path.join(f.temporary,'host-source');await fs.mkdir(source);
 const code=`const r=require('node:readline').createInterface({input:process.stdin});let calls=0;r.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'qa-mcp',version:'1'}}:q.method==='tools/list'?{tools:[{name:'qa_read',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true,destructiveHint:false}}]}:q.method==='tools/call'?{content:[{type:'text',text:'synthetic call '+(++calls)}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`;
 await fs.writeFile(path.join(source,'server.cjs'),code);const archive=path.join(f.temporary,'host.tar.gz');
 const descriptor=await packRuntime({directory:source,archivePath:archive,target:hostRuntimeTarget(),entrypoint:'server.cjs'});
 await f.catalog.get(RuntimeArtifacts).importArchive(archive,descriptor);
 const pkg=buildPackage({id:'hosted-http-'+randomUUID(),kind:'mcp',name:'Hosted QA',version:1},[],'',{transport:'stdio',args:[],extra:{hostedMcp:true,runtimeArtifacts:[descriptor]}});
 const pin=async(current=pkg,projectId=f.projectId)=>f.pool.query(`INSERT INTO project_assets(project_id,asset_id,asset_kind,added_by,asset_version,asset_manifest,pin_origin,pin_snapshot)
 VALUES($1,$2,'mcp',$3,$4,$5,'assigned',$6) ON CONFLICT(project_id,asset_kind,asset_id) DO UPDATE SET asset_version=excluded.asset_version,asset_manifest=excluded.asset_manifest,pin_snapshot=excluded.pin_snapshot`,[projectId,current.plugin.id,f.actors.main.email,current.plugin.version,current.manifest.sha256,{card:{id:current.plugin.id},package:current}]);
 await pin();
 const deviceId=randomUUID(),token=randomBytes(32).toString('hex'),report={protocolVersion:2,capabilities:['durable-completions','managed-installations'],bindings:[{projectId:f.projectId,bindingId:'a'.repeat(64),valid:true}]};
 await f.pool.query("INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) VALUES($1,$2,'Разработчик','Hosted HTTP QA',$3,$4,$5)",[deviceId,f.actors.developer.email,'f'.repeat(64),createHash('sha256').update(token).digest('hex'),report]);
 const config={get:key=>process.env[key]},auth=new AuthGuardService(config);
 class Fixture{}Module({controllers:[McpHostController],providers:[{provide:AuthGuardService,useValue:auth},{provide:ConfigService,useValue:config}]})(Fixture);
 app=await NestFactory.create(Fixture,{logger:false,abortOnError:false});await app.listen(0,'127.0.0.1');const base='http://127.0.0.1:'+app.getHttpServer().address().port;
 const connect=async(current=pkg,projectId=f.projectId)=>{
  const response=await fetch(base+'/api/mcp-host/connect',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({projectId,pkg:current}),signal:AbortSignal.timeout(15000)});
  return {status:response.status,data:await response.json()};
 };
 await t.test('self-signed substitution and foreign project never receive a ticket',async()=>{
  const forged=buildPackage({...pkg.plugin,version:2},[],'',pkg.config);assert.equal((await connect(forged)).status,403);
  await f.pool.query("INSERT INTO projects(id,name) VALUES('prj-host-other','Other')");await pin(pkg,'prj-host-other');assert.equal((await connect(pkg,'prj-host-other')).status,403);
 });
 let channel;
 await t.test('actual SDK initialize → tools/list → tools/call works with exact approved runtime',async()=>{
  const connected=await connect();assert.equal(connected.status,200,JSON.stringify(connected.data));channel=connected.data.path;
  client=new Client({name:'qa-client',version:'1'},{capabilities:{}});await client.connect(new StreamableHTTPClientTransport(new URL(base+channel)),{timeout:15000});
  assert.equal((await client.listTools(undefined,{timeout:15000})).tools[0].name,'qa_read');assert.match((await client.callTool({name:'qa_read',arguments:{}},undefined,{timeout:15000})).content[0].text,/synthetic call 1/);
 });
 await t.test('installation off preserves existing sessions but refuses a new connection',async()=>{
  f.state.featureOverrides.tool_installation=false;assert.equal((await connect()).status,403);assert.equal((await client.listTools(undefined,{timeout:15000})).tools.length,1);f.state.featureOverrides.tool_installation=true;
 });
 await t.test('project role revocation blocks a previously issued signed ticket',async()=>{
  await f.pool.query('DELETE FROM project_members WHERE principal_name=$1',[f.actors.developer.email]);await assert.rejects(client.callTool({name:'qa_read',arguments:{}},undefined,{timeout:15000}));
  await f.pool.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)',[f.projectId,f.actors.developer.email,'Разработчик']);assert.equal((await client.listTools(undefined,{timeout:15000})).tools.length,1);
  assert.match((await client.callTool({name:'qa_read',arguments:{}},undefined,{timeout:15000})).content[0].text,/synthetic call 2/);
 });
 await t.test('repinning the assigned package invalidates the old ticket without executing a tool',async()=>{
  await pin(buildPackage({...pkg.plugin,version:2},[],'',pkg.config));await assert.rejects(client.callTool({name:'qa_read',arguments:{}},undefined,{timeout:15000}));await pin();
  assert.match((await client.callTool({name:'qa_read',arguments:{}},undefined,{timeout:15000})).content[0].text,/synthetic call 3/);
 });
 await t.test('a signed legacy ticket without project/device lineage requires reinstall',async()=>{
  const raw=channel.split('/').at(-1).split('.')[0],claim=JSON.parse(Buffer.from(raw,'base64url'));delete claim.session;
  const payload=Buffer.from(JSON.stringify(claim)).toString('base64url'),secret=process.env.NEUROCENTER_MCP_HOST_SECRET||process.env.NEUROCENTER_INTERNAL_TOKEN;
  const legacy=payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');
  const response=await fetch(base+'/api/mcp-host/m/'+legacy,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(response.status,401);await response.body.cancel();
 });
 await t.test('device revocation blocks the existing SDK channel',async()=>{
  await f.pool.query('UPDATE bridge_devices SET revoked=true WHERE id=$1',[deviceId]);await assert.rejects(client.listTools(undefined,{timeout:15000}));assert.equal((await connect()).status,401);
 });
 assert.deepEqual(f.state.externalCalls,[]);
});
