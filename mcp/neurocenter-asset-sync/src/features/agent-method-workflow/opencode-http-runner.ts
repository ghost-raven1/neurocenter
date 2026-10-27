import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';

const limit=1024*1024;
type JsonObject=Record<string,unknown>;
const object=(value:unknown):value is JsonObject=>!!value&&typeof value==='object'&&!Array.isArray(value);
const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>0;
class RuntimeFailure extends Error{code:'EXECUTION_FAILED'|'OUTPUT_LIMIT'|'TIMEOUT';constructor(code:'EXECUTION_FAILED'|'OUTPUT_LIMIT'|'TIMEOUT'='EXECUTION_FAILED'){super(code);this.code=code;}}

/** A successful HTTP response must contain the final completed assistant turn, not a tool-call or partial response. */
export function assertCompletedAssistant(value:unknown,session:string):void{
 if(!object(value)||!object(value.info)||!Array.isArray(value.parts))throw new RuntimeFailure();
 const info=value.info;
 if(info.role!=='assistant'||info.sessionID!==session||!object(info.time)||!finite(info.time.completed)||info.error!==undefined||info.finish!=='stop')throw new RuntimeFailure();
 if(!value.parts.some(part=>object(part)&&part.type==='text'&&typeof part.text==='string'&&part.text.trim()))throw new RuntimeFailure();
 for(const part of value.parts){
  if(!object(part)||part.sessionID!==session||part.messageID!==info.id)throw new RuntimeFailure();
  if(part.type==='tool'&&(!object(part.state)||part.state.status!=='completed'))throw new RuntimeFailure();
  if(part.type==='step-finish'&&part.reason!=='stop')throw new RuntimeFailure();
 }
}

async function boundedJson(response:Response):Promise<unknown>{
 if(!response.ok||!response.body)throw new RuntimeFailure();
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
 try{
  for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>limit)throw new RuntimeFailure('OUTPUT_LIMIT');chunks.push(next.value);}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
 }finally{await reader.cancel().catch(()=>{});}
}

/** Standalone Node24 entry: its server and tools remain descendants of the bridge's durably owned process group. */
async function main():Promise<void>{
 const [engine,root,prompt]=process.argv.slice(3);
 if(!engine||!root||!path.isAbsolute(root)||path.resolve(process.cwd())!==path.resolve(root)||!prompt||Buffer.byteLength(prompt)>96*1024)throw new RuntimeFailure();
 const controller=new AbortController(),password=randomBytes(32).toString('hex'),username='neurocenter-method';
 const timer=setTimeout(()=>controller.abort(new RuntimeFailure('TIMEOUT')),15*60*1000);
 const abort=()=>controller.abort(new RuntimeFailure());process.once('SIGTERM',abort);process.once('SIGINT',abort);
 const server=spawn(engine,['serve','--hostname','127.0.0.1','--port','0'],{
  cwd:root,env:{...process.env,OPENCODE_SERVER_USERNAME:username,OPENCODE_SERVER_PASSWORD:password},shell:false,detached:false,stdio:['ignore','pipe','pipe']});
 const exited=new Promise<void>(resolve=>server.once('close',()=>resolve()));
 let bytes=0,tail='';
 const observe=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>limit)controller.abort(new RuntimeFailure('OUTPUT_LIMIT'));tail=(tail+chunk.toString('utf8')).slice(-8192);};
 server.stdout.on('data',observe);server.stderr.on('data',observe);
 const failed=()=>controller.abort(new RuntimeFailure());server.once('error',failed);server.once('exit',failed);
 try{
  const url=await new Promise<string>((resolve,reject)=>{
   const timeout=setTimeout(()=>finish(new RuntimeFailure('TIMEOUT')),15000);
   const ready=()=>{const match=tail.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);if(match)finish(undefined,match[1]);};
   const cancelled=()=>finish(controller.signal.reason);
   const finish=(error?:unknown,value?:string)=>{clearTimeout(timeout);server.stdout.off('data',ready);server.stderr.off('data',ready);controller.signal.removeEventListener('abort',cancelled);error?reject(error):resolve(value!);};
   server.stdout.on('data',ready);server.stderr.on('data',ready);controller.signal.addEventListener('abort',cancelled,{once:true});if(controller.signal.aborted)cancelled();else ready();
  });
  const post=async(route:string,value:unknown)=>{
   const target=new URL(route,url);target.searchParams.set('directory',root);
   return boundedJson(await fetch(target,{method:'POST',redirect:'error',signal:controller.signal,
    headers:{'content-type':'application/json',authorization:'Basic '+Buffer.from(username+':'+password).toString('base64')},body:JSON.stringify(value)}));
  };
  const permission=['question','plan_enter','plan_exit'].map(permission=>({permission,action:'deny',pattern:'*'}));
  const session=await post('/session',{title:'Neurocenter development workflow',permission});
  if(!object(session)||typeof session.id!=='string'||!/^ses_[a-zA-Z0-9]+$/.test(session.id))throw new RuntimeFailure();
  const response=await post('/session/'+session.id+'/message',{parts:[{type:'text',text:prompt}]});
  assertCompletedAssistant(response,session.id);controller.signal.throwIfAborted();
  // Only fixed metadata leaves this process. Model text, tools, server logs and credentials stay private.
  process.stdout.write(JSON.stringify({type:'agent_method_completed',protocol:'opencode-http-v1'})+'\n');
 }finally{
  clearTimeout(timer);process.off('SIGTERM',abort);process.off('SIGINT',abort);server.off('exit',failed);
  if(server.exitCode===null&&server.signalCode===null)server.kill('SIGTERM');
  const kill=setTimeout(()=>server.kill('SIGKILL'),1000);try{await exited;}finally{clearTimeout(kill);}
 }
}

if(process.argv[2]==='--agent-method-runtime')void main().catch(error=>{
 const code=error instanceof RuntimeFailure?error.code:'EXECUTION_FAILED';
 process.stdout.write(JSON.stringify({type:'agent_method_failed',protocol:'opencode-http-v1',code})+'\n');process.exitCode=1;
});
