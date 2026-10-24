import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {connectRoleMcp,type RoleMcpPort} from '../src/features/system-role-mcp/client.js';
import type {Package} from '../src/bridge/package.js';

const fixture=fileURLToPath(new URL('./system-role-mcp.fixture.mjs',import.meta.url));
const roots:string[]=[],ports:RoleMcpPort[]=[];
async function start(signal=new AbortController().signal,detached=false){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'role mcp boundary '));roots.push(root);
 const port=await connectRoleMcp({pkg:{config:{transport:'stdio'}}as Package,command:process.execPath,
  args:[fixture,'literal $HOME; $(never execute)',...(detached?['--detached-child']:[])],cwd:root,env:{PATH:process.env.PATH,HOME:root}},signal,async()=>{});ports.push(port);
 return {root,port,tools:await port.list()};
}
afterEach(async()=>{await Promise.all(ports.splice(0).map(port=>port.close()));await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
describe('role MCP actual SDK stdio boundary (synthetic state, no Playwright acceptance)',()=>{
 it('discovers exact schemas and preserves one session across navigate then snapshot with literal arguments',async()=>{
  const {port,tools}=await start(),navigate=tools.find(tool=>tool.name==='browser_navigate')!,snapshot=tools.find(tool=>tool.name==='browser_snapshot')!;
  let dispatches=0;await port.call(navigate.name,navigate.schemaDigest,{url:'https://fixture.example/page'},async()=>{dispatches++;});
  const result=await port.call(snapshot.name,snapshot.schemaDigest,{},async()=>{dispatches++;});
  expect(result.text).toContain('https://fixture.example/page');expect(result.text).toContain('literal $HOME; $(never execute)');expect(dispatches).toBe(2);
 });
 it('rejects invalid input, changed schemas and unselected names before a dispatch or external effect',async()=>{
  const {port,tools,root}=await start(),tool=tools.find(tool=>tool.name==='browser_navigate')!;let dispatches=0;
  for(const [name,pin,args]of [[tool.name,tool.schemaDigest,{url:42}],[tool.name,'0'.repeat(64),{url:'x'}],['execute_shell',tool.schemaDigest,{}]]as const)
   await expect(port.call(name,pin,args,async()=>{dispatches++;})).rejects.toThrow();
  expect(dispatches).toBe(0);await expect(fs.readFile(path.join(root,'calls.txt'))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('bounds a completed large result visibly without replaying it',async()=>{
  const {port,tools,root}=await start(),tool=tools.find(tool=>tool.name==='browser_snapshot')!;
  const result=await port.call(tool.name,tool.schemaDigest,{large:true},async()=>{});
  expect(result.truncated).toBe(true);expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(65536);
  expect((await fs.readFile(path.join(root,'calls.txt'),'utf8')).trim()).toBe('browser_snapshot');
 });
 it.skipIf(process.platform==='win32')('cancels an in-flight request and closes its owned descendant process',async()=>{
  const controller=new AbortController(),{port,tools,root}=await start(controller.signal),tool=tools.find(tool=>tool.name==='browser_slow')!;
  const pending=port.call(tool.name,tool.schemaDigest,{},async()=>{}).then(()=>false,()=>true);
  let pid=0;for(let attempt=0;attempt<100;attempt++){try{pid=Number(await fs.readFile(path.join(root,'descendant.pid'),'utf8'));break;}catch{await delay(10);}}
  expect(pid).toBeGreaterThan(0);controller.abort();expect(await pending).toBe(true);await port.close();
  let alive=true;for(let attempt=0;attempt<100;attempt++){try{process.kill(pid,0);await delay(10);}catch{alive=false;break;}}
  expect(alive).toBe(false);
 });
 it.skipIf(process.platform==='win32')('waits for a detached descendant before confirming transport closure',async()=>{
  const controller=new AbortController(),{port,tools,root}=await start(controller.signal,true),tool=tools.find(tool=>tool.name==='browser_slow')!;
  const pending=port.call(tool.name,tool.schemaDigest,{},async()=>{}).catch(()=>undefined);
  let pid=0;for(let attempt=0;attempt<100;attempt++){try{pid=Number(await fs.readFile(path.join(root,'descendant.pid'),'utf8'));break;}catch{await delay(10);}}
  expect(pid).toBeGreaterThan(0);controller.abort();await pending;await port.close();expect(()=>process.kill(pid,0)).toThrow();
 });
});
