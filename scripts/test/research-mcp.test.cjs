const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const path=require('node:path');
const dist=process.env.GATEWAY_TEST_DIST||path.resolve('services/api-gateway/dist');
const {researchPackage}=require(path.join(dist,'features/research-mcp/research-package.js'));
const {researchArguments,researchOutput,researchTools,publicResearchUrl}=require(path.join(dist,'features/research-mcp/research-tools.js'));
const {ResearchMcpController}=require(path.join(dist,'features/research-mcp/research-mcp.controller.js'));
const {buildPackage}=require('../../services/catalog-service/dist/catalog/bundle-package.js');
const {defaultFeatureFlags,evaluateFeatureFlags}=require('../../services/shared/feature-flags.cjs');
const artifact={target:'darwin-arm64',sha256:'a'.repeat(64),entrypoint:'entrypoint.mjs',compressedBytes:100,unpackedBytes:200,filesCount:1};
const pkg=()=>buildPackage({id:'exa',kind:'mcp',name:'Exa',version:1},[{path:'readme.md',content:'approved'}],'',{
 transport:'stdio',args:[],extra:{hostedMcp:true,researchMcp:{adapter:'exa',tools:['web_search_exa','web_fetch_exa']},runtimeArtifacts:[artifact]}});
const tools=()=>({tools:['web_search_exa','web_fetch_exa'].map(name=>({name,description:'Search',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true,destructiveHint:false}}))});

test('Full package proof rejects mutations, wrong delivery and file corruption',()=>{
 assert.equal(researchPackage(pkg(),'darwin-arm64').artifactSha256,artifact.sha256);
 for(const change of [p=>p.config.extra.hostedMcp=false,p=>p.config.transport='remote',p=>p.files[0].content='replaced',p=>p.files.push(p.files[0]),
  p=>p.config.extra.researchMcp.tools[1]='execute_shell',p=>p.manifest.sha256='b'.repeat(64)]){const p=pkg();change(p);assert.throws(()=>researchPackage(p,'darwin-arm64'));}
 assert.throws(()=>researchPackage(pkg(),'linux-x64-glibc'));assert.throws(()=>researchPackage(null));
});
test('Explicit capability allowlist validates every external argument before dispatch',()=>{
 assert.deepEqual(researchArguments('web_search_exa',{query:'q',objective:'o'}).arguments,{query:'q',objective:'o',numResults:5});
 assert.deepEqual(researchArguments('web_fetch_exa',{urls:['https://example.com/a#part']}).arguments,{urls:['https://example.com/a'],maxCharacters:4000});
 for(const [name,args] of [['execute_shell',{}],['web_search_exa',{query:'q'}],['web_search_exa',{query:' ',objective:'o'}],['web_search_exa',{query:'q',objective:'o',numResults:11}],
  ['web_search_exa',{query:'q',objective:'o',command:'sh'}],['web_fetch_exa',{urls:[]}],['web_fetch_exa',{urls:['http://127.0.0.1/a']}],['web_fetch_exa',{urls:['file:///etc/passwd']}],
  ['web_fetch_exa',{urls:['https://example.com'],maxCharacters:10001}]])assert.throws(()=>researchArguments(name,args));
 for(const url of ['https://user:secret@example.com','http://localhost/a','http://service.internal/a','http://10.1.2.3','http://[::1]/','http://example.com:444/'])assert.equal(publicResearchUrl(url),undefined);
});
test('Mutable MCP annotations cannot grant mutation or an unknown tool',()=>{
 assert.equal(researchTools(tools()).tools.length,2);
 for(const change of [t=>t.tools.pop(),t=>t.tools[0].annotations.readOnlyHint=false,t=>t.tools[0].annotations.destructiveHint=true,t=>t.tools[0].inputSchema={type:'string'}]){const t=tools();change(t);assert.throws(()=>researchTools(t));}
});
test('Tool evidence is bounded and retains only public source links',()=>{
 assert.deepEqual(researchOutput({content:[{type:'text',text:'https://example.com/a and http://127.0.0.1/private'}]}).sources,[{url:'https://example.com/a'}]);
 for(const result of [{isError:true,content:[]},{content:[]},{content:[{type:'text',text:'x'.repeat(65537)}]},null])assert.throws(()=>researchOutput(result));
});
test('Internal controller rechecks flags immediately before MCP call and propagates cancellation',async()=>{
 const originalFetch=global.fetch,oldToken=process.env.NEUROCENTER_INTERNAL_TOKEN;process.env.NEUROCENTER_INTERNAL_TOKEN='qa-research-only';
 const originalTarget=artifact.target;artifact.target=process.platform+'-'+process.arch;
 let configured=defaultFeatureFlags(),actual=0,lookups=0,abort=false;
 global.fetch=async()=>{lookups++;return new Response(JSON.stringify(evaluateFeatureFlags(configured)));};
 const req=new EventEmitter(),res=Object.assign(new EventEmitter(),{writableEnded:false});
 const host={researchTools:async(_claim,signal)=>{if(abort){req.emit('aborted');signal.throwIfAborted();}return tools();},researchCall:async()=>{actual++;return {content:[{type:'text',text:'https://example.com'}]};}};
 const controller=new ResearchMcpController(host),body={pkg:pkg(),name:'web_search_exa',arguments:{query:'q',objective:'o'}};
 try{
  await assert.rejects(controller.list('wrong',body,req,res),{status:403});assert.equal(lookups,0);
  configured.research_tools=false;await assert.rejects(controller.call('qa-research-only',body,req,res),{status:403});assert.equal(actual,0);
  configured.research_tools=true;host.researchTools=async()=>{configured.research_tools=false;return tools();};
  await assert.rejects(controller.call('qa-research-only',body,req,res),{status:403});assert.equal(actual,0);
  configured.research_tools=true;host.researchTools=async(_claim,signal)=>{if(abort){req.emit('aborted');signal.throwIfAborted();}return tools();};
  assert.equal((await controller.call('qa-research-only',body,req,res)).text,'https://example.com');assert.equal(actual,1);
  abort=true;await assert.rejects(controller.call('qa-research-only',body,req,res),{status:503});assert.equal(actual,1);
  assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
 }finally{global.fetch=originalFetch;artifact.target=originalTarget;if(oldToken===undefined)delete process.env.NEUROCENTER_INTERNAL_TOKEN;else process.env.NEUROCENTER_INTERNAL_TOKEN=oldToken;}
});
