import {afterEach,describe,expect,it} from 'vitest';
import {createServer,request,type Server} from 'node:http';
import {once} from 'node:events';
import {ggufRequestTimeouts} from '../../shared/gguf-request-timeout.cjs';

const route='/api/models/gguf-imports/00000000-0000-4000-8000-000000000001/content';
describe('GGUF durable timeout is not shortened by the native HTTP body deadline',()=>{
 const servers:Server[]=[];
 afterEach(async()=>{for(const server of servers){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}servers.length=0;});
 async function fixture(exempt:boolean,ownTimeout?:number){const server=createServer({requestTimeout:30,headersTimeout:20,connectionsCheckingInterval:5},(req,res)=>{
  const action=()=>{const timer=ownTimeout?setTimeout(()=>{res.statusCode=504;res.end('owned-timeout');},ownTimeout):undefined;req.on('data',()=>{});req.on('end',()=>{clearTimeout(timer);if(!res.writableEnded)res.end('received');});res.on('close',()=>clearTimeout(timer));};
  if(middleware)middleware(req,res,action);else action();
 });const before=server.headersTimeout,middleware=exempt?ggufRequestTimeouts(server):undefined;expect(server.headersTimeout).toBe(before);servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw Error('port');return {server,port:address.port};}
 async function send(port:number,path=route){return new Promise<number>((resolve,reject)=>{let responded=false;const req=request({hostname:'127.0.0.1',port,path,method:'PUT',headers:{'content-type':'application/octet-stream','content-length':4}},res=>{responded=true;res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',error=>{if(!responded)reject(error);});req.write('G');const timer=setTimeout(()=>req.end('GUF'),80);req.on('close',()=>clearTimeout(timer));});}
 it('reproduces the native early 408, then accepts the same slow GGUF with its own longer deadline',async()=>{const baseline=await fixture(false);expect(await send(baseline.port)).toBe(408);const owned=await fixture(true,200);expect(owned.server.requestTimeout).toBe(0);expect(await send(owned.port)).toBe(200);});
 it('preserves the original non-GGUF deadline and does not exempt a malformed upload route',async()=>{const owned=await fixture(true);expect(await send(owned.port,'/api/models')).toBe(408);expect(await send(owned.port,route.replace('00000000','not-a-uuid'))).toBe(408);});
 it('leaves the GGUF executor responsible for its shorter retained deadline',async()=>{const owned=await fixture(true,40);expect(await send(owned.port)).toBe(504);});
});
