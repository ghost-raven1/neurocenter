import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {ReadBuffer,serializeMessage} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type {JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';
import {startRoleMcpProcess,type RoleMcpProcessJournal} from './owned-process.js';

/** Cancellation awaits the owned group, rather than treating a delivered kill signal as cleanup. */
export class OwnedRoleMcpTransport implements Transport{
 onmessage?:(message:JSONRPCMessage)=>void;onclose?:()=>void;onerror?:(error:Error)=>void;
 private running?:Awaited<ReturnType<typeof startRoleMcpProcess>>;private starting?:Promise<void>;private closing?:Promise<void>;
 private readonly buffer=new ReadBuffer({maxBufferSize:1024*1024});private bytes=0;
 constructor(private readonly command:string,private readonly args:string[],private readonly cwd:string,private readonly env:NodeJS.ProcessEnv,
  private readonly authorize:()=>Promise<void>,private readonly signal:AbortSignal,private readonly journal?:RoleMcpProcessJournal){}
 async start(){
  this.starting=(async()=>{
   this.running=await startRoleMcpProcess(this.command,this.args,this.cwd,this.env,this.authorize,this.signal,this.journal);
   const child=this.running.child,fail=(error:Error)=>{this.onerror?.(error);void this.close().catch(()=>{});};
   child.stdout.on('data',(chunk:Buffer)=>{try{this.bytes+=chunk.length;if(this.bytes>8*1024*1024)throw new Error('MCP превысил предел транспорта.');
    this.buffer.append(chunk);for(let value=this.buffer.readMessage();value;value=this.buffer.readMessage())this.onmessage?.(value);
   }catch(error){fail(error as Error);}});
   child.stderr.on('data',(chunk:Buffer)=>{this.bytes+=chunk.length;if(this.bytes>8*1024*1024)fail(new Error('MCP превысил предел транспорта.'));});
   child.once('error',fail);child.once('close',()=>this.onclose?.());
  })();await this.starting;
 }
 async send(value:JSONRPCMessage){
  const input=this.running?.child.stdin;if(!input?.writable)throw new Error('Транспорт MCP закрыт.');
  await new Promise<void>((resolve,reject)=>input.write(serializeMessage(value),error=>error?reject(error):resolve()));
 }
 async close(){
  if(!this.closing)this.closing=(async()=>{await this.starting?.catch(()=>{});await this.running?.close();this.buffer.clear();this.onclose?.();})();
  return this.closing;
 }
}
