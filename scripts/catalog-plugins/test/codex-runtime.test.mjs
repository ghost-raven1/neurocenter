import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {codexFixture} from './codex-runtime.fixture.mjs';
import {prepareCodexBridge,CODEX_CONNECTOR} from '../recipes/codex-bridge.mjs';

test('unknown target fails before any staging or download',async()=>{
 let downloaded=false;await assert.rejects(prepareCodexBridge({target:'linux-mips',directory:'/must-not-exist'},{downloadFile:async()=>{downloaded=true;}}),/платформа/);assert.equal(downloaded,false);
});
test('auth-only recipe uses six pinned sources, two locked dependencies and a native executable',async()=>{
 const f=await codexFixture();try{
  assert.equal(f.downloads.length,6);assert.equal(new Set(f.downloads).size,6);assert.deepEqual(f.installs,[{target:'darwin-arm64',dependencies:{'@openai/codex':'0.159.3',zod:'3.25.76'}}]);
  assert.deepEqual(f.result.config.extra,{codexConnector:CODEX_CONNECTOR});assert.equal(f.result.kind,'plugin');assert.equal(f.result.executables.length,1);
  const files=await fs.readdir(path.join(f.directory,'upstream'));assert.deepEqual(files.sort(),['auth-login.js','auth-provider.js','auth-session.js','connection.js','executable.js','types.js']);
  for(const name of ['plugin.js','run.js','approvals.js','tools.js','voice.js'])assert.equal(files.includes(name),false);
  assert.deepEqual(await(await f.plugin()).default(),{});
 }finally{await f.close();}
});
test('local model discovery returns only metadata and reaps all RPC children',async()=>{
 const f=await codexFixture(),before=process.env.QA_CODEX_RPC_LOG;process.env.QA_CODEX_RPC_LOG=path.join(f.root,'rpc.log');
 try{const result=await(await f.setup()).readCodexModels();assert.equal(result.defaultModel,'gpt-synthetic');assert.equal(result.models.length,1);assert.equal(JSON.stringify(result).includes('synthetic-account'),false);
  const calls=(await fs.readFile(process.env.QA_CODEX_RPC_LOG,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.some(call=>call.method==='model/list'),true);assert.equal(calls.some(call=>/response|turn\/start/.test(call.method)),false);for(const pid of new Set(calls.map(call=>call.pid)))assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{if(before===undefined)delete process.env.QA_CODEX_RPC_LOG;else process.env.QA_CODEX_RPC_LOG=before;await f.close();}
});
test('model pagination stops on a repeated cursor',async()=>{
 const f=await codexFixture();process.env.QA_CODEX_PAGINATION='loop';try{await assert.rejects((await f.setup()).readCodexModels(),{code:'CODEX_DISCOVERY_UNAVAILABLE'});}finally{delete process.env.QA_CODEX_PAGINATION;await f.close();}
});
test('missing login has an actionable message without account credentials',async()=>{
 const f=await codexFixture();process.env.QA_CODEX_LOGIN='missing';try{await assert.rejects((await f.setup()).readCodexModels(),{code:'CODEX_LOGIN_REQUIRED'});}finally{delete process.env.QA_CODEX_LOGIN;await f.close();}
});
test('official login can be cancelled and retried',async()=>{
 const f=await codexFixture();try{const setup=await f.setup(),login=await setup.beginCodexSetupLogin();assert.equal(new URL(login.url).hostname,'auth.openai.com');await login.close();await assert.rejects(login.finished,/Вход не завершён/);const next=await setup.beginCodexSetupLogin();await next.finished;await next.close();}finally{await f.close();}
});
test('unexpected auth host is rejected',async()=>{
 const f=await codexFixture();process.env.QA_CODEX_LOGIN_URL='https://untrusted.example/authorize';try{await assert.rejects((await f.setup()).beginCodexSetupLogin(),/Не удалось/);}finally{delete process.env.QA_CODEX_LOGIN_URL;await f.close();}
});
for(const phase of ['models','login'])test(`cancellation reaps a pending ${phase} RPC instead of leaving hidden work`,async()=>{
 const f=await codexFixture(),previous=process.env.QA_CODEX_RPC_LOG;process.env.QA_CODEX_HANG=phase;process.env.QA_CODEX_RPC_LOG=path.join(f.root,'pending.log');
 try{
  const setup=await f.setup(),abort=new AbortController(),reason=new Error('synthetic-cancel');
  const pending=phase==='models'?setup.readCodexModels({signal:abort.signal}):setup.beginCodexSetupLogin({signal:abort.signal});
  const rejected=assert.rejects(pending,error=>error===reason);const deadline=Date.now()+2000;let calls=[];
  while(Date.now()<deadline){calls=await fs.readFile(process.env.QA_CODEX_RPC_LOG,'utf8').then(text=>text.trim().split('\n').map(JSON.parse)).catch(()=>[]);if(calls.some(call=>call.method===(phase==='models'?'model/list':'account/login/start')))break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(calls.some(call=>call.method===(phase==='models'?'model/list':'account/login/start')),true);abort.abort(reason);await rejected;
  for(const pid of new Set(calls.map(call=>call.pid)))assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{delete process.env.QA_CODEX_HANG;if(previous===undefined)delete process.env.QA_CODEX_RPC_LOG;else process.env.QA_CODEX_RPC_LOG=previous;await f.close();}
});
test('managed plugin requires an owned project context',async()=>{
 const f=await codexFixture();try{const {createManagedCodexPlugin}=await f.plugin();assert.throws(()=>createManagedCodexPlugin({...f.options,bridgeCommand:['node','bridge.js']}),/Доступ/);await assert.rejects(createManagedCodexPlugin(f.options)({directory:f.directory}),/Доступ/);assert.equal(await fs.stat(f.log).catch(()=>null),null);}finally{await f.close();}
});
test('normal OpenCode boot installs guarded runtime fetch without a global auth-store marker',async()=>{
 const f=await codexFixture();try{
  const hook=await(await f.plugin()).createManagedCodexPlugin(f.options)({directory:f.root});
  const manual={options:{apiKey:'manual-value'}},provider={npm:'@ai-sdk/openai',options:{baseURL:'https://chatgpt.com/backend-api/codex'}};
  const config={provider:{manual,[f.options.providerId]:provider}};
  assert.equal(typeof hook.config,'function');await hook.config(config);
  assert.equal(typeof provider.options.fetch,'function');assert.equal(provider.options.apiKey,'codexbridge-managed');assert.equal(config.provider.manual,manual);assert.equal(await fs.stat(f.log).catch(()=>null),null);
 }finally{await f.close();}
});
test('separate project factories keep their saved Codex account when the parent environment differs',async()=>{
 const f=await codexFixture(),original=globalThis.fetch,previous=process.env.CODEX_HOME;const accounts=[];process.env.CODEX_HOME=path.join(f.root,'unrelated-parent');
 try{
  const {createManagedCodexPlugin}=await f.plugin(),loaders=[];
  for(const account of ['account-a','account-b'])loaders.push(await(await createManagedCodexPlugin({...f.options,codexHome:path.join(f.root,account)})({directory:f.root})).auth.loader());
  globalThis.fetch=async(_url,init)=>{accounts.push(new Headers(init.headers).get('ChatGPT-Account-Id'));return new Response('data: {"type":"response.completed","response":{"id":"synthetic"}}\n\n');};
  for(const loader of [loaders[0],loaders[1],loaders[0]])await loader.fetch('https://api.openai.com/v1/responses',{method:'POST',body:'{}'});
  assert.deepEqual(accounts,['account-a','account-b','account-a']);assert.equal(process.env.CODEX_HOME,path.join(f.root,'unrelated-parent'));
 }finally{globalThis.fetch=original;if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;await f.close();}
});
test('fresh permit gates every HTTP request after session reads, including a 401 refresh',async()=>{
 const f=await codexFixture(),original=globalThis.fetch;let count=0;
 try{const plugin=await(await f.plugin()).createManagedCodexPlugin(f.options)({directory:f.root});const loader=await plugin.auth.loader();globalThis.fetch=async(url,init)=>{count++;assert.equal(url,'https://chatgpt.com/backend-api/codex/responses');assert.equal(init.redirect,'error');const body=JSON.parse(init.body);assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(body.temperature,undefined);assert.equal(new Headers(init.headers).get('ChatGPT-Account-Id'),'synthetic-account');const permits=(await fs.readFile(f.log,'utf8')).trim().split('\n');assert.equal(permits.length,count*2);return new Response(count===1?'unauthorized':'data: {"type":"response.completed","response":{"id":"synthetic-response"}}\n\n',{status:count===1?401:200});};
  const response=await loader.fetch('https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify({model:'gpt-synthetic',temperature:0.8})});assert.deepEqual(await response.json(),{id:'synthetic-response'});assert.equal(count,2);
  process.env.QA_CODEX_DENY='1';await assert.rejects(loader.fetch('https://api.openai.com/v1/responses',{method:'POST',body:'{}'}),/Доступ/);assert.equal(count,2);
  const guards=(await fs.readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(guards.every(value=>value.phase==='request'&&!JSON.stringify(value).includes('fixture.')),true);
 }finally{globalThis.fetch=original;delete process.env.QA_CODEX_DENY;await f.close();}
});
test('aborted requests and other destinations never reach transport',async()=>{
 const f=await codexFixture(),original=globalThis.fetch;let calls=0;
 try{const loader=await(await(await f.plugin()).createManagedCodexPlugin(f.options)({directory:f.root})).auth.loader();globalThis.fetch=async()=>{calls++;return new Response('bad');};await assert.rejects(loader.fetch('https://untrusted.example/v1/responses',{method:'POST',body:'{}'}),/official/);const abort=new AbortController();abort.abort();await assert.rejects(loader.fetch('https://api.openai.com/v1/responses',{method:'POST',body:'{}',signal:abort.signal}));assert.equal(calls,0);}finally{globalThis.fetch=original;await f.close();}
});
