import {execFile,spawn,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import type {RoleMcpOwner} from './session-journal.js';
import {readBoundedSnapshot} from '../../bridge/read-bounded.js';
import {syncDirectory} from '../../bridge/atomic-file.js';

const execute=promisify(execFile),runner=fileURLToPath(new URL('./owned-runner'+path.extname(fileURLToPath(import.meta.url)),import.meta.url));
export const roleMcpLifecycleSupported=(platform:NodeJS.Platform=process.platform)=>platform==='darwin'||platform==='linux';
export class RoleMcpCleanupError extends Error{constructor(cause:unknown){super('Очистка принадлежащей сессии MCP не подтверждена.',{cause});}}
async function beforeAbort<T>(promise:Promise<T>,signal:AbortSignal){
 signal.throwIfAborted();let abort:()=>void=()=>{};
 const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason??new Error('Запуск MCP отменён.'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 try{return await Promise.race([promise,cancelled]);}finally{signal.removeEventListener('abort',abort);}
}
async function status(pid:number){
 if(!roleMcpLifecycleSupported())throw new Error('Восстановление локальных MCP на этой ОС пока недоступно.');
 try{
  // UTF-8 preserves exact argv on macOS while C keeps lstart independent of the user's language.
  const {stdout}=await execute('/bin/ps',['-ww','-p',String(pid),'-o','uid=,pgid=,lstart=,stat=,command='],{encoding:'utf8',timeout:3000,maxBuffer:16384,env:{PATH:'/usr/bin:/bin',LC_ALL:'C.UTF-8'}});
  const match=stdout.trim().match(/^(\d+)\s+(\d+)\s+((?:\S+\s+){4}\S+)\s+(\S+)\s+([\s\S]+)$/);
  if(!match)throw new Error('Не удалось подтвердить владельца процесса MCP.');
  return {uid:Number(match[1]),group:Number(match[2]),birth:match[3]!,state:match[4]!,command:match[5]!};
 }catch(error){if((error as {code?:unknown}).code===1)return undefined;throw error;}
}
export async function roleMcpProcessOwner(pid=process.pid,entry=path.resolve(process.argv[1]??process.execPath)):Promise<RoleMcpOwner>{
 const value=await status(pid);if(!value||value.state.startsWith('Z')||value.uid!==process.getuid!())throw new Error('Владелец процесса MCP не подтверждён.');
 return {pid,uid:value.uid,birth:value.birth,entry};
}
export async function roleMcpOwnerAlive(owner:RoleMcpOwner){
 const value=await status(owner.pid);return !!value&&!value.state.startsWith('Z')&&value.uid===owner.uid&&value.birth===owner.birth&&value.command.includes(owner.entry);
}
/** Covers the crash between wrapper spawn and durable PID receipt; it still has no execution permit. */
export async function findRoleMcpProcess(nonce:string,receipt:string){
 if(!/^[a-f0-9-]{36}$/.test(nonce))throw new Error('Некорректный владелец MCP.');
 const {stdout}=await execute('/bin/ps',['-ww','-ax','-o','pid=,uid=,command='],{encoding:'utf8',timeout:3000,maxBuffer:4*1024*1024,env:{PATH:'/usr/bin:/bin',LC_ALL:'C.UTF-8'}});
 const command=process.execPath+' '+runner+' --role-mcp-owner '+nonce+' '+receipt,found:number[]=[];
 for(const line of stdout.split('\n')){const match=line.trim().match(/^(\d+)\s+(\d+)\s+([\s\S]+)$/);if(match&&Number(match[2])===process.getuid!()&&match[3]===command)found.push(Number(match[1]));}
 if(found.length>1)throw new Error('Несколько процессов заявили одно владение MCP.');
 return found[0]?roleMcpProcessOwner(found[0],runner):undefined;
}
async function closure(owner:RoleMcpOwner,nonce:string,receipt:string){
 try{
  const info=await fs.lstat(receipt);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid!()||(info.mode&0o077)!==0)throw new Error('Квитанция очистки MCP изменена.');
  const value=JSON.parse((await readBoundedSnapshot(receipt,16384)).bytes.toString('utf8'))as {schemaVersion:number;nonce:string;owner:RoleMcpOwner;closed:boolean};
  if(value.schemaVersion!==1||value.nonce!==nonce||value.closed!==true||JSON.stringify(value.owner)!==JSON.stringify(owner))throw new Error('Квитанция очистки MCP относится к другому владельцу.');return true;
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
/** Called after the server acknowledged the durable closed intent, never after a timeout. */
export async function retireRoleMcpProcessReceipt(owner:RoleMcpOwner,nonce:string,receipt:string){
 if(!await closure(owner,nonce,receipt))return;
 const before=await readBoundedSnapshot(receipt,16384);if(!await closure(owner,nonce,receipt))return;
 const after=await readBoundedSnapshot(receipt,16384);if(before.fingerprint!==after.fingerprint||!before.bytes.equals(after.bytes))throw new Error('Квитанция очистки MCP заменена.');
 await fs.unlink(receipt);await syncDirectory(path.dirname(receipt));
}
/** No PID-only termination: the exact nonce, birth, UID and group leader must still match. */
export async function closeRoleMcpProcess(owner:RoleMcpOwner,nonce:string,receipt:string){
 const value=await status(owner.pid);
 if(value&&!value.state.startsWith('Z')){
  if(value.uid!==owner.uid||value.birth!==owner.birth||value.group!==owner.pid||value.command!==process.execPath+' '+owner.entry+' --role-mcp-owner '+nonce+' '+receipt){
   if(await closure(owner,nonce,receipt))return;throw new Error('Владелец процесса MCP изменился; чужой процесс не остановлен.');
  }
  try{process.kill(owner.pid,'SIGTERM');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
 }
 for(let attempt=0;attempt<160;attempt++){
  if(!await roleMcpOwnerAlive(owner)){if(await closure(owner,nonce,receipt))return;throw new Error('Владелец MCP завершился без квитанции очистки. Нужна проверка локальной сессии.');}await delay(25);
 }
 throw new Error('Очистка принадлежащих сессии процессов MCP не подтверждена.');
}
export interface RoleMcpProcessJournal {nonce:string;receipt:string;retain(owner:RoleMcpOwner):Promise<void>}
/** The wrapper receives private configuration only after its durable ownership receipt. */
export async function startRoleMcpProcess(command:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,authorize:()=>Promise<void>,signal:AbortSignal,journal?:RoleMcpProcessJournal){
 if(!roleMcpLifecycleSupported())throw new Error('Восстановление локальных MCP на этой ОС пока недоступно.');
 await authorize();signal.throwIfAborted();const nonce=journal?.nonce??randomUUID(),temporary=journal?undefined:await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-mcp-owner-'));
 const receipt=journal?.receipt??path.join(temporary!,'closed.json');
 const child=spawn(process.execPath,[runner,'--role-mcp-owner',nonce,receipt],{cwd,env:{PATH:process.env.PATH,LANG:'C.UTF-8'},detached:true,shell:false,stdio:['pipe','pipe','pipe','ipc']});
 child.stdin!.on('error',()=>{});let owner:RoleMcpOwner|undefined;
 const closed=()=>child.exitCode!==null||child.signalCode!==null;
 const stop=async()=>{
  if(owner)await closeRoleMcpProcess(owner,nonce,receipt);
  else if(child.pid&&!closed()){
   if(child.connected)child.disconnect();await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Обёртка MCP не подтвердила остановку.')),5000);child.once('exit',()=>{clearTimeout(timer);resolve();});if(closed()){clearTimeout(timer);resolve();}});
  }
  child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();
  if(temporary)await fs.rm(temporary,{recursive:true,force:true});
 };
 try{
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>done(new Error('Обёртка MCP не готова.')),5000);
   const message=(value:unknown)=>{const item=value as {ready?:boolean;nonce?:string};if(item.ready&&item.nonce===nonce)done();};
   const abort=()=>done(new Error('Запуск MCP отменён.')),exit=()=>done(new Error('Обёртка MCP завершилась до разрешения.'));
   const done=(error?:Error)=>{clearTimeout(timer);child.off('message',message);child.off('error',done);child.off('exit',exit);signal.removeEventListener('abort',abort);error?reject(error):resolve();};
   child.on('message',message);child.once('error',done);child.once('exit',exit);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
  owner=await roleMcpProcessOwner(child.pid!,runner);if(journal)await beforeAbort(journal.retain(owner),signal);await authorize();signal.throwIfAborted();
  await new Promise<void>((resolve,reject)=>child.send!({nonce,command,args,cwd,env},error=>error?reject(error):resolve()));
  return {child:child as ChildProcess&{stdin:NonNullable<ChildProcess['stdin']>;stdout:NonNullable<ChildProcess['stdout']>;stderr:NonNullable<ChildProcess['stderr']>},close:stop};
 }catch(error){try{await stop();}catch(cleanup){throw new RoleMcpCleanupError(cleanup);}throw error;}
}
