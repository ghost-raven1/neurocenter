import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

// Standalone so Node24 can also execute the source in native causal tests.
const nonce=process.argv[3],receipt=process.argv[4];
if(process.platform==='win32'||process.argv[2]!=='--role-mcp-owner'||!nonce||!receipt||!path.isAbsolute(receipt)||!process.send)process.exit(2);
/** A departed parent cannot receive progress; its closed IPC channel must not interrupt durable cleanup. */
const notify=(value:Record<string,unknown>):void=>{if(process.connected)process.send?.(value,()=>{});};
type Owner={pid:number;parent:number;uid:number;birth:string;state:string};
const known=new Map<number,Owner>();let permitted=false,closing:Promise<void>|undefined;
async function census(){
 let query=0;
 const stdout=await new Promise<string>((resolve,reject)=>{
  const child=execFile('/bin/ps',['-ax','-o','pid=,ppid=,uid=,lstart=,stat='],{encoding:'utf8',timeout:3000,maxBuffer:2*1024*1024,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}},(error,value)=>error?reject(error):resolve(value));query=child.pid??0;
 });
 const rows=new Map<number,Owner>();
 for(const line of stdout.split('\n')){
  const match=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+((?:\S+\s+){4}\S+)\s+(\S+)$/);if(!match)continue;
  const value={pid:Number(match[1]),parent:Number(match[2]),uid:Number(match[3]),birth:match[4]!,state:match[5]!};if(value.pid!==query&&!value.state.startsWith('Z'))rows.set(value.pid,value);
 }
 return rows;
}
function discover(rows:Map<number,Owner>){
 const parents=new Set([process.pid]);for(const value of known.values())if(rows.get(value.pid)?.birth===value.birth)parents.add(value.pid);
 let changed=true;while(changed){changed=false;for(const item of rows.values())if(item.pid!==process.pid&&parents.has(item.parent)&&!parents.has(item.pid)){
  if(item.uid!==process.getuid!())throw new Error('MCP descendant changed owner');if(known.size>=2048&&!known.has(item.pid))throw new Error('MCP descendant limit');
  known.set(item.pid,item);parents.add(item.pid);changed=true;
 }}
}
function exact(rows:Map<number,Owner>,item:Owner){const actual=rows.get(item.pid);return actual?.uid===item.uid&&actual.birth===item.birth;}
async function publish(owner:Owner){
 const directory=path.dirname(receipt!),info=await fs.lstat(directory);
 if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid!()||(info.mode&0o077)!==0)throw new Error('MCP receipt directory changed');
 const temporary=path.join(directory,'.'+randomUUID()+'.tmp');
 try{
  const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify({schemaVersion:1,nonce,owner:{pid:owner.pid,uid:owner.uid,birth:owner.birth,entry:process.argv[1]},closed:true}));await handle.sync();}finally{await handle.close();}
  await fs.link(temporary,receipt!);const parent=await fs.open(directory,'r');try{await parent.sync();}finally{await parent.close();}
 }finally{await fs.rm(temporary,{force:true});}
}
const stop=()=>closing??=(async()=>{
 clearInterval(observing);clearTimeout(timeout);
 const self=(await census()).get(process.pid);if(!self)throw new Error('MCP owner unavailable');
 // Freeze the discovered tree before stopping parents, including descendants
 // which Playwright put into another group. Never signal a reused PID.
 for(let pass=0;pass<3;pass++){
  const rows=await census();discover(rows);
  for(const item of known.values())if(exact(rows,item)){try{process.kill(item.pid,'SIGSTOP');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
  await delay(20);
 }
 for(let pass=0;pass<100;pass++){
  const rows=await census();discover(rows);const live=[...known.values()].filter(item=>exact(rows,item));
  if(!live.length){await publish(self);process.exit(0);}
  for(const item of live.reverse()){const actual=(await census()).get(item.pid);if(actual?.uid===item.uid&&actual.birth===item.birth){try{process.kill(item.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}}
  await delay(20);
 }
 throw new Error('MCP descendants did not close');
})().catch(error=>{const code=(error as NodeJS.ErrnoException).code;notify({nonce,cleanupFailure:typeof code==='string'&&/^[A-Z_]+$/.test(code)?code:'CLEANUP_FAILED'});process.exit(1);});
process.once('disconnect',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
let observingBusy=false;
const observing=setInterval(()=>{if(observingBusy||closing)return;observingBusy=true;void census().then(discover).catch(()=>{void stop();}).finally(()=>{observingBusy=false;});},250);observing.unref();
const timeout=setTimeout(()=>{void stop();},16*60*1000);timeout.unref();
process.on('message',(value:unknown)=>{
 const permit=value as {nonce:string;command:string;args:string[];cwd:string;env:NodeJS.ProcessEnv};
 if(closing||permitted||permit?.nonce!==nonce||typeof permit.command!=='string'||!Array.isArray(permit.args)||typeof permit.cwd!=='string'||!permit.env){void stop();return;}
 permitted=true;
 const child=spawn(permit.command,permit.args,{cwd:permit.cwd,env:permit.env,shell:false,detached:false,stdio:['pipe','pipe','pipe']});
 child.once('spawn',()=>{notify({nonce,executionStarted:true});});
 child.stdin.on('error',()=>{});process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
 child.once('error',()=>{notify({nonce,executionExit:{code:null,signal:null}});void stop();});
 child.once('exit',(code,signal)=>{notify({nonce,executionExit:{code,signal}});void stop();});
});
notify({ready:true,nonce});
