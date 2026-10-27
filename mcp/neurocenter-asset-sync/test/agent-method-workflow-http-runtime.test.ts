import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {assertCompletedAssistant} from '../src/features/agent-method-workflow/opencode-http-runner.js';
import {runMethodCommand,MethodExecutionError} from '../src/features/agent-method-workflow/process.js';

const runner=fileURLToPath(new URL('../src/features/agent-method-workflow/opencode-http-runner.ts',import.meta.url));
const final=()=>({info:{id:'msg_owned',sessionID:'ses_owned',role:'assistant',time:{created:1,completed:2},finish:'stop'},parts:[{id:'prt_owned',messageID:'msg_owned',sessionID:'ses_owned',type:'text',text:'PRIVATE_MODEL_TEXT'}]});
describe('Final pinned OpenCode HTTP response boundary',()=>{
 it('accepts a completed final assistant and rejects partial/tool-only/error/cross-session outcomes',()=>{
  expect(()=>assertCompletedAssistant(final(),'ses_owned')).not.toThrow();
  for(const info of [{time:{created:1}},{finish:'length'},{finish:'tool-calls'},{error:{name:'APIError'}},{sessionID:'ses_other'}]){
   const value=final();Object.assign(value.info,info);expect(()=>assertCompletedAssistant(value,'ses_owned')).toThrow();
  }
  const value=final();value.parts=[];expect(()=>assertCompletedAssistant(value,'ses_owned')).toThrow();
  expect(()=>assertCompletedAssistant({...final(),parts:[...final().parts,{type:'tool',messageID:'msg_owned',sessionID:'ses_owned',state:{status:'error'}}]},'ses_owned')).toThrow();
 });
});

describe('Owned HTTP runtime adapter against a harmless real loopback server, no model',()=>{
 let temporary:string,root:string,engine:string;
 beforeEach(async()=>{
  temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'method-http-runtime-')));root=path.join(temporary,'Проекты 日本','мой проект');await fs.mkdir(root,{recursive:true});engine=path.join(root,'engine');
  await fs.mkdir(path.join(root,'processes'),{mode:0o700});
  // The fixture server validates actual private auth, exact directory and noninteractive rules before changing its own file.
  await fs.writeFile(engine,`#!${process.execPath}
const http=require('node:http'),fs=require('node:fs'),{spawn}=require('node:child_process');
const expected='Basic '+Buffer.from(process.env.OPENCODE_SERVER_USERNAME+':'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
if(process.argv.slice(2).join(' ')!=='serve --hostname 127.0.0.1 --port 0'||!process.env.OPENCODE_SERVER_PASSWORD)process.exit(2);
const mode=process.env.OWNED_METHOD_HTTP_MODE;
const server=http.createServer(async(req,res)=>{
 const route=new URL(req.url,'http://127.0.0.1');
 if(req.headers.authorization!==expected||route.searchParams.get('directory')!==process.cwd()){res.writeHead(401);res.end('{}');return;}
 let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);res.setHeader('content-type','application/json');
 if(route.pathname==='/session'){
  if(body.permission.length!==3||body.permission.some(rule=>rule.action!=='deny')){res.writeHead(400);res.end('{}');return;}
  res.end(JSON.stringify({id:'ses_owned'}));return;
 }
 if(route.pathname!=='/session/ses_owned/message'||body.parts[0].text!=='OWNED_TASK'){res.writeHead(400);res.end('{}');return;}
 fs.writeFileSync('app.js','implemented by owned HTTP runtime');
 if(mode==='waiting'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('child.pid',String(child.pid));return;}
 const result=${JSON.stringify(final())};if(mode==='error')result.info.error={name:'APIError',data:{message:'PRIVATE_ERROR'}};
 if(mode==='overflow')result.parts[0].text='PRIVATE_OVERFLOW'.repeat(100000);
 res.end(JSON.stringify(result));
});
server.listen(0,'127.0.0.1',()=>{fs.writeFileSync('server.pid',String(process.pid));console.error('PRIVATE_SERVER_LOG');console.log('opencode server listening on http://127.0.0.1:'+server.address().port);});
`);await fs.chmod(engine,0o700);
 });
 afterEach(async()=>{await fs.rm(temporary,{recursive:true,force:true});});
 const run=(mode:string,signal=new AbortController().signal)=>runMethodCommand(process.execPath,[runner,'--agent-method-runtime',engine,root,'OWNED_TASK'],root,
  {...process.env,OWNED_METHOD_HTTP_MODE:mode},async()=>{},signal,{nonce:randomUUID(),receipt:path.join(root,'processes',randomUUID()+'.json'),retain:async()=>{}},true);
 it('awaits a real file change in a Unicode and space directory, keeps final contents private and closes its server',async()=>{
  const result=await run('success');expect(result).toEqual({code:0,signal:null,stdout:'{"type":"agent_method_completed","protocol":"opencode-http-v1"}\n'});
  expect(await fs.readFile(path.join(root,'app.js'),'utf8')).toBe('implemented by owned HTTP runtime');
  const pid=Number(await fs.readFile(path.join(root,'server.pid'),'utf8'));expect(()=>process.kill(pid,0)).toThrow();
 },30000);
 it('does not convert HTTP200 with a model error into completion or expose raw response/logs',async()=>{
  const result=await run('error');expect(result.code).toBe(1);expect(JSON.parse(result.stdout)).toMatchObject({type:'agent_method_failed',code:'EXECUTION_FAILED'});expect(result.stdout).not.toContain('PRIVATE');
 },30000);
 it('bounds the actual HTTP response before parsing or returning model contents',async()=>{
  const result=await run('overflow');expect(result.code).toBe(1);expect(JSON.parse(result.stdout)).toMatchObject({type:'agent_method_failed',code:'OUTPUT_LIMIT'});expect(result.stdout).not.toContain('PRIVATE');
 },30000);
 it('cancels the waiting HTTP runtime, server and nested tool process through the durable owned group',async()=>{
  const controller=new AbortController(),pending=run('waiting',controller.signal);
  const settled=pending.then(value=>({value}),error=>({error}));
  await vi.waitFor(async()=>expect(await fs.readFile(path.join(root,'child.pid'),'utf8')).toMatch(/^\d+$/),{timeout:15000});
  const child=Number(await fs.readFile(path.join(root,'child.pid'),'utf8')),server=Number(await fs.readFile(path.join(root,'server.pid'),'utf8'));
  controller.abort(new MethodExecutionError('CANCELLED'));expect(await settled).toMatchObject({error:{code:'CANCELLED'}});
  expect(()=>process.kill(child,0)).toThrow();expect(()=>process.kill(server,0)).toThrow();
 },30000);
});
