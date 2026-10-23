import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectMemory,type MemoryPort} from '../src/features/project-learning-memory-sync/memory-client.js';

let port:MemoryPort|undefined,root:string|undefined;
afterEach(async()=>{await port?.close();port=undefined;if(root)await fs.rm(root,{recursive:true,force:true});root=undefined;});
describe('Real MCP SDK stdio boundary',()=>{
 it('uses the pinned contents ABI for add, bounded names for reads, and targeted observation removal',async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-memory-wire-'));
  port=await connectMemory(fileURLToPath(new URL('./fixtures/memory-sync-server.mjs',import.meta.url)),root,new AbortController().signal);
  const item={name:'neurocenter:learning:fixture:approved',entityType:'neurocenter.approved-project-knowledge.v1',observations:['approved']};
  await port.create(item);await port.add(item.name,['manual fixture']);
  expect(await port.nodes([item.name])).toEqual([{...item,observations:['approved','manual fixture']}]);
  await port.remove(item.name,['approved']);expect(await port.nodes([item.name])).toEqual([{...item,observations:['manual fixture']}]);
  await expect(port.nodes(Array(33).fill(item.name))).rejects.toThrow('ограниченный');expect(await fs.readdir(root)).toEqual([]);
 });
 it('propagates cancellation without connecting to the supplied runtime',async()=>{
  const cancelled=new AbortController();cancelled.abort();root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-memory-aborted-'));
  await expect(connectMemory(fileURLToPath(new URL('./fixtures/memory-sync-server.mjs',import.meta.url)),root,cancelled.signal)).rejects.toThrow();
 });
});
