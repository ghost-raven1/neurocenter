import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {assertMethodQuirkStorage} from '../src/features/project-learning-quirks/method-preflight.js';

let root:string;
const record={id:'quirk:11111111-1111-4111-8111-111111111111',content:'reported fixture only',tags:[],confidence:1,lastObserved:'2026-10-27T00:00:00.000Z'};
const valid=JSON.stringify(record)+'\n',hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const source=()=>path.join(root,'.opencode/rag_db/quirks.jsonl');
const write=async(value:string|Buffer)=>{await fs.mkdir(path.dirname(source()),{recursive:true});await fs.writeFile(source(),value);};
beforeEach(async()=>{root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-method-quirks-')));});
afterEach(async()=>{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});});

describe('readonly Quirk preflight before method plugin startup',()=>{
    it('allows absence without creating files and accepts a later complete valid source',async()=>{
        const checked=await assertMethodQuirkStorage(root,async()=>{});
        expect(checked.status).toBe('absent');expect(await fs.readdir(root)).toEqual([]);
        await write(valid);await expect(checked.assertCurrent()).resolves.toBeUndefined();
        expect(await fs.readFile(source(),'utf8')).toBe(valid);
    });
    it('validates a complete source without changing bytes, timestamps or directory contents',async()=>{
        await write(valid);const before=await fs.stat(source());
        const checked=await assertMethodQuirkStorage(root,async()=>{});await checked.assertCurrent();
        expect(checked).toMatchObject({status:'verified',fileSha256:hash(valid)});
        expect(hash(await fs.readFile(source()))).toBe(hash(valid));expect((await fs.stat(source())).mtimeMs).toBe(before.mtimeMs);
        expect(await fs.readdir(path.dirname(source()))).toEqual(['quirks.jsonl']);
    });
    it.each(['corrupt','partial','duplicate','invalid-shape','invalid-utf8'])('blocks %s before coding and keeps all original bytes',async kind=>{
        const bytes=kind==='corrupt'?valid+'{broken}\n':kind==='partial'?valid.slice(0,-1):kind==='duplicate'?valid+valid:kind==='invalid-shape'?valid+'{"content":"unverified"}\n':Buffer.from([0xff,0xfe,0x0a]);
        await write(bytes);const before=await fs.readFile(source()),stat=await fs.stat(source()),coding=vi.fn();
        await expect((async()=>{await assertMethodQuirkStorage(root,async()=>{});coding();})()).rejects.toMatchObject({code:'QUIRK_STORAGE_INVALID'});
        expect(coding).not.toHaveBeenCalled();expect(await fs.readFile(source())).toEqual(before);expect((await fs.stat(source())).mtimeMs).toBe(stat.mtimeMs);
        expect(await fs.readdir(path.dirname(source()))).toEqual(['quirks.jsonl']);
    });
    it('does not convert a source I/O failure into an absent or repaired store',async()=>{
        await write(valid);const open=vi.spyOn(fs,'open').mockRejectedValueOnce(Object.assign(new Error('fixture private error'),{code:'EACCES'}));
        await expect(assertMethodQuirkStorage(root,async()=>{})).rejects.toMatchObject({code:'QUIRK_STORAGE_INVALID'});open.mockRestore();
        expect(await fs.readFile(source(),'utf8')).toBe(valid);
    });
    it('rejects a broken configuration even when the optional Quirk file is absent',async()=>{
        await fs.writeFile(path.join(root,'opencode-rag.json'),'{bad');
        await expect(assertMethodQuirkStorage(root,async()=>{})).rejects.toMatchObject({code:'QUIRK_STORAGE_INVALID'});
    });
    it('accepts complete valid append and rewrite without modifying the producer source',async()=>{
        await write(valid);const checked=await assertMethodQuirkStorage(root,async()=>{});
        const appended=JSON.stringify({...record,id:'quirk:22222222-2222-4222-8222-222222222222'})+'\n';
        await fs.appendFile(source(),appended);await expect(checked.assertCurrent()).resolves.toBeUndefined();
        expect(await fs.readFile(source(),'utf8')).toBe(valid+appended);
        await fs.writeFile(source(),valid.replace('reported fixture only','changed fixture'));
        await expect(checked.assertCurrent()).resolves.toBeUndefined();
        expect(await fs.readFile(source(),'utf8')).toBe(valid.replace('reported fixture only','changed fixture'));
    });
    it('rejects corruption introduced by a producer after valid preflight',async()=>{
        await write(valid);const checked=await assertMethodQuirkStorage(root,async()=>{});
        await fs.appendFile(source(),'{incomplete');
        await expect(checked.assertCurrent()).rejects.toMatchObject({code:'QUIRK_STORAGE_INVALID'});
        expect(await fs.readFile(source(),'utf8')).toBe(valid+'{incomplete');
    });
    it('pins configuration and the physical project across producer writes',async()=>{
        await write(valid);const again=await assertMethodQuirkStorage(root,async()=>{});
        await fs.writeFile(path.join(root,'opencode-rag.json'),'{}');
        await expect(again.assertCurrent()).rejects.toMatchObject({code:'QUIRK_STORAGE_INVALID'});
        await fs.rm(path.join(root,'opencode-rag.json'));const checked=await assertMethodQuirkStorage(root,async()=>{});
        const moved=root+'-previous';await fs.rename(root,moved);
        try{await fs.mkdir(root);await write(valid);await expect(checked.assertCurrent()).rejects.toMatchObject({code:'QUIRK_STORAGE_INVALID'});}
        finally{await fs.rm(root,{recursive:true,force:true});await fs.rename(moved,root);}
    });
    it('preserves authorization loss instead of reporting it as optional knowledge corruption',async()=>{
        await write(valid);let denied=false;const failure=Object.assign(Error('revoked'),{code:'AUTHORIZATION_LOST'});
        const checked=await assertMethodQuirkStorage(root,async()=>{if(denied)throw failure;});denied=true;
        await expect(checked.assertCurrent()).rejects.toBe(failure);
    });
});
