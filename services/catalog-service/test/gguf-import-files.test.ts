import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {GgufImportFiles} from '../src/models/gguf-import/gguf-import.files';
import {inspectGguf} from '../src/models/gguf-import/gguf-inspection';
import {ggufImportPolicy} from '../../shared/gguf-import-policy.cjs';
import {gguf} from './gguf-import.fixture';

const policy=ggufImportPolicy(),sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
describe('Bounded GGUF envelope and streamed immutable bytes',()=>{
 let root:string,files:GgufImportFiles;
 beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'gguf-import-'));files=new GgufImportFiles(root);await files.setup();});
 afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
 const save=async(bytes:Buffer)=>{const file=path.join(root,'fixture.gguf');await fs.writeFile(file,bytes);return file;};
 it.each([2,3])('accepts a complete LE v%s file and reports metadata without loading tensor data',async version=>{expect(await inspectGguf(await save(gguf({version})),policy)).toEqual({format:'gguf',version,architecture:'llama',tensorCount:1,metadataCount:1});});
 it.each([
  ['wrong magic',()=>Buffer.from('not a gguf')],['unsupported version',()=>gguf({version:4})],['missing architecture',()=>gguf({architecture:''})],['projector',()=>gguf({architecture:'clip'})],['split',()=>gguf({metadata:[['split.count',2]]})],['adapter',()=>gguf({metadata:[['general.type','adapter']]})],['duplicate metadata',()=>gguf({metadata:[['general.architecture','llama']]})],['zero tensors',()=>gguf({tensors:[]})],['truncated tensor',()=>gguf({dataBytes:15})],['offset beyond EOF',()=>gguf({tensors:[{name:'weight',offset:32}]})],['unaligned offset',()=>gguf({tensors:[{name:'weight',offset:1}]})],['overlap',()=>gguf({tensors:[{name:'a'},{name:'b'}]})],['unknown tensor type',()=>gguf({tensors:[{name:'a',type:999}]})],['quant block mismatch',()=>gguf({tensors:[{name:'a',type:2}]})],['LoRA tensor',()=>gguf({tensors:[{name:'weight.lora_a'}]})],
 ] as const)('rejects %s',async(_label,bytes)=>{await expect(inspectGguf(await save(bytes()),policy)).rejects.toMatchObject({status:400});});
 it('checks quantized extent including bytes per block',async()=>{const bytes=gguf({tensors:[{name:'token_embd.weight',type:12,dimensions:[256]}],dataBytes:144});await expect(inspectGguf(await save(bytes),policy)).resolves.toMatchObject({tensorCount:1});await expect(inspectGguf(await save(bytes.subarray(0,-1)),policy)).rejects.toThrow('границы');});
 it('uses the pinned Ollama 0.35.1 Q8_1 layout of 36 bytes per 32-value block',async()=>{const bytes=gguf({tensors:[{name:'token_embd.weight',type:9,dimensions:[32]}],dataBytes:36});await expect(inspectGguf(await save(bytes),policy)).resolves.toMatchObject({tensorCount:1});await expect(inspectGguf(await save(bytes.subarray(0,-1)),policy)).rejects.toThrow('границы');});
 it('honors configured parser bounds before large allocation',async()=>{await expect(inspectGguf(await save(gguf()),{...policy,metadataBytes:24})).rejects.toThrow('лимит');await expect(inspectGguf(await save(gguf()),{...policy,stringBytes:3})).rejects.toThrow('строка');});
 it('streams chunked bytes, computes server SHA, fsyncs and makes the single-link receipt read-only',async()=>{const bytes=gguf(),id=randomUUID(),checks:number[]=[];const result=await files.receiveGguf(Readable.from([bytes.subarray(0,17),bytes.subarray(17)]),id,randomUUID(),bytes.length,null,new AbortController().signal,async()=>{checks.push(1);},1);expect(result).toBe(sha(bytes));expect(await files.digest(id,bytes.length,result)).toBe(result);expect((await fs.stat(files.filename(id))).mode&0o222).toBe(0);expect(await fs.readdir(root)).toEqual([id+'.source']);expect(checks.length).toBeGreaterThan(0);});
 it.each(['overflow','short','sha'] as const)('does not retain a receipt after %s',async kind=>{const bytes=gguf(),id=randomUUID();await expect(files.receiveGguf(Readable.from([bytes]),id,randomUUID(),bytes.length+(kind==='short'?1:kind==='overflow'?-1:0),kind==='sha'?'f'.repeat(64):null,new AbortController().signal,async()=>{},1)).rejects.toMatchObject({status:409});expect(await fs.readdir(root)).toEqual([]);});
 it('aborts a stalled stream without publishing a partial file',async()=>{const id=randomUUID(),input=new Readable({read(){}}),controller=new AbortController(),transfer=files.receiveGguf(input,id,randomUUID(),10,null,controller.signal,async()=>{},1);input.push(Buffer.from('part'));controller.abort();await expect(transfer).rejects.toMatchObject({name:'AbortError'});expect(await fs.readdir(root)).toEqual([]);});
 it('rejects a symlink or hardlink instead of hashing foreign files',async()=>{const target=await save(gguf()),id=randomUUID();await fs.chmod(target,0o400);await fs.symlink(target,files.filename(id));await expect(files.digest(id,gguf().length)).rejects.toBeDefined();await fs.rm(files.filename(id));await fs.link(target,files.filename(id));await expect(files.digest(id,gguf().length)).rejects.toMatchObject({status:409});});
 it('preserves parser cancellation before a READY receipt',async()=>{await expect(inspectGguf(await save(gguf()),policy,async()=>{throw Error('cancelled');})).rejects.toThrow('cancelled');});
});
