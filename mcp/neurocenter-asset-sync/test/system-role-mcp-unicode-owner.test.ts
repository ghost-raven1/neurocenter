import {it,expect} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {findRoleMcpProcess,startRoleMcpProcess} from '../src/features/system-role-mcp/owned-process.js';
import type {RoleMcpOwner} from '../src/features/system-role-mcp/session-journal.js';

/** Exercise native ps ownership with a non-ASCII receipt instead of mocking its output. */
it.skipIf(process.platform==='win32')('finds and closes the exact MCP owner when its receipt path contains Unicode and spaces',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'роль MCP с пробелами ')),nonce=randomUUID(),receipt=path.join(directory,'закрыто.json');
 let processHandle:Awaited<ReturnType<typeof startRoleMcpProcess>>|undefined,owner:RoleMcpOwner|undefined;
 try{
  processHandle=await startRoleMcpProcess(process.execPath,['-e','setInterval(()=>{},1000)'],directory,{PATH:process.env.PATH},async()=>{},new AbortController().signal,
   {nonce,receipt,retain:async value=>{owner=value;}});
  expect(await findRoleMcpProcess(nonce,receipt)).toEqual(owner);
  await processHandle.close();
  expect(JSON.parse(await fs.readFile(receipt,'utf8'))).toMatchObject({nonce,owner,closed:true});
 }finally{
  // The retained ChildProcess IPC handle remains authoritative even when a regression rejects ps ownership.
  if(processHandle&&processHandle.child.exitCode===null&&processHandle.child.signalCode===null){
   const exited=once(processHandle.child,'exit',{signal:AbortSignal.timeout(8000)});if(processHandle.child.connected)processHandle.child.disconnect();
   await exited;
  }
  await fs.rm(directory,{recursive:true,force:true});
 }
},15000);
