import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

export const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** Reserve independently chosen loopback ports until each real process is launched. */
export async function reservePorts(names){
 const reservations={};for(const name of names){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  reservations[name]={port:server.address().port,release:()=>new Promise(resolve=>server.close(resolve))};}return reservations;
}
export async function waitHttp(url,child,log,timeout=90000,signal){
 const deadline=Date.now()+timeout;while(Date.now()<deadline){
  signal?.throwIfAborted();
  if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('QA process exited '+child.exitCode+': '+await fs.readFile(log,'utf8'));
  try{const result=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(1500)});await result.body?.cancel();if(result.status<500)return;}catch{}
  await pause(150);
 }throw Error('QA readiness timed out: '+url+' '+(log?await fs.readFile(log,'utf8'):''));
}
export function spawnLogged(node,args,env,cwd,log){
 const child=spawn(node,args,{cwd,env,stdio:['ignore','pipe','pipe']});let pending=Promise.resolve();
 const write=chunk=>{pending=pending.then(()=>fs.appendFile(log,chunk,{mode:0o600}));};child.stdout.on('data',write);child.stderr.on('data',write);
 child.on('error',error=>write(Buffer.from(String(error))));child.finishLog=()=>pending;return child;
}
export async function stopChild(child){
 if(!child)return;if(child.exitCode===null){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');
  let timer;await Promise.race([exit,new Promise(resolve=>{timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},5000);})]);clearTimeout(timer);await exit;}
 await child.finishLog?.();
}
/** This is deliberately the only mock: a loopback model upstream, not a mocked application service. */
export async function startModelFixture(port,observations){
 const model='qa-project-learning',failureModel='qa-project-learning-failure',server=http.createServer(async(req,res)=>{
  try{assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');let bytes='';for await(const chunk of req){bytes+=chunk;if(bytes.length>128*1024)throw Error('Too large');}
   const body=JSON.parse(bytes);assert.ok([model,failureModel].includes(body.model));const source=body.messages.find(message=>message.role==='user');
   let input;try{input=JSON.parse(source.content);}catch{}
   const experiences=input?.untrustedProjectExperiences;
   const content=experiences?JSON.stringify({hypotheses:[{subject:'project',title:'QA: проверить повтор после потери подтверждения',
    statement:'Повтор наблюдения с тем же ключом может сохранять одну запись опыта.',rationale:'Гипотеза основана на выбранном опыте; это управляемый ответ тестовой модели.',
    verificationPlan:'Потерять ответ после COMMIT, повторить тот же запрос и сравнить количество записей.',experienceIds:[experiences[0].id]}]}):'OK';
   const failed=!!experiences&&body.model===failureModel;
   observations.push({at:new Date().toISOString(),kind:failed?'analysis-failure':experiences?'analysis':'probe',model:body.model,experienceIds:experiences?.map(item=>item.id)||[]});
   res.writeHead(failed?503:200,{'content-type':'application/json'});res.end(JSON.stringify(failed?{error:{message:'Controlled QA model failure'}}:
    {model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  }catch{res.writeHead(400,{'content-type':'application/json'});res.end('{"error":{"message":"QA fixture rejected request"}}');}
 });await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 return {model,failureModel,close:()=>new Promise(resolve=>server.close(resolve))};
}
/** The production MCP index is started before credentials exist, so no detached worker is spawned. */
export async function startMcp(repo,node,env,project){
 const require=createRequire(path.join(repo,'mcp/neurocenter-asset-sync/package.json'));
 const {Client}=await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
 const {StdioClientTransport}=await import(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
 const transport=new StdioClientTransport({command:node,args:[path.join(repo,'mcp/neurocenter-asset-sync/dist/index.js')],env,cwd:project,stderr:'pipe'});
 const client=new Client({name:'project-learning-acceptance',version:'1.0.0'},{capabilities:{}});await client.connect(transport);
 return {client,transport,async call(name,input,fail=false){const result=await client.callTool({name,arguments:input});
  assert.equal(Boolean(result.isError),fail,JSON.stringify(result));const content=result.content.filter(item=>item.type==='text').map(item=>item.text).join('\n');
  return fail?content:JSON.parse(content);},close:()=>client.close()};
}
