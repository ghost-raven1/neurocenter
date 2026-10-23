import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readQuirksSource} from '../src/features/project-learning-quirks/source.js';

let root:string;
const quirk={id:'quirk:11111111-1111-4111-8111-111111111111',content:'reported fixture',tags:[],confidence:1,lastObserved:'2026-10-24T00:00:00.000Z'};
const jsonl=JSON.stringify(quirk)+'\n',sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
beforeEach(async()=>{root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-quirks-read-')));await fs.mkdir(path.join(root,'.opencode/rag_db'),{recursive:true});await fs.writeFile(path.join(root,'.opencode/rag_db/quirks.jsonl'),jsonl);});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
describe('Read-only exact project RAG source',()=>{
    it('reads exact raw bytes and never changes JSONL/config or creates a LanceDB connection',async()=>{
        const file=path.join(root,'.opencode/rag_db/quirks.jsonl'),before=await fs.stat(file);
        const snapshot=await readQuirksSource(root,async()=>{});await snapshot.assertCurrent();
        expect(snapshot.fileSha256).toBe(sha(jsonl));expect(snapshot.records[0].quirk.id).toBe(quirk.id);
        expect(sha(await fs.readFile(file))).toBe(sha(jsonl));expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
        expect(await fs.readdir(path.join(root,'.opencode/rag_db'))).toEqual(['quirks.jsonl']);
    });
    it('uses only configured store inside the project and rejects outside paths',async()=>{
        await fs.mkdir(path.join(root,'notes'));await fs.writeFile(path.join(root,'notes/quirks.jsonl'),jsonl);
        const config=path.join(root,'opencode-rag.json');await fs.writeFile(config,JSON.stringify({vectorStore:{path:'notes'}}));
        expect((await readQuirksSource(root,async()=>{})).records).toHaveLength(1);
        await fs.writeFile(config,JSON.stringify({vectorStore:{path:'../foreign'}}));await expect(readQuirksSource(root,async()=>{})).rejects.toThrow('внутри');
    });
    it.each(['leaf','parent','config'])('rejects %s symlink without reading it as valid source',async part=>{
        const original=path.join(root,'.opencode/rag_db/quirks.jsonl');
        if(part==='leaf'){await fs.rename(original,path.join(root,'original.jsonl'));await fs.symlink(path.join(root,'original.jsonl'),original);}
        if(part==='parent'){await fs.rename(path.join(root,'.opencode/rag_db'),path.join(root,'original'));await fs.symlink(path.join(root,'original'),path.join(root,'.opencode/rag_db'));}
        if(part==='config'){await fs.writeFile(path.join(root,'original.json'),'{}');await fs.symlink(path.join(root,'original.json'),path.join(root,'opencode-rag.json'));}
        await expect(readQuirksSource(root,async()=>{})).rejects.toThrow();
    });
    it.each(['missing','corrupt','torn','duplicate','oversize'])('refuses %s with no empty fallback',async problem=>{
        const file=path.join(root,'.opencode/rag_db/quirks.jsonl');
        if(problem==='missing')await fs.unlink(file);
        else await fs.writeFile(file,problem==='corrupt'?jsonl+'{bad}\n':problem==='torn'?jsonl.slice(0,-1):problem==='duplicate'?jsonl+jsonl:' '.repeat(1024*1024+1));
        await expect(readQuirksSource(root,async()=>{})).rejects.toThrow();
    });
    it.each(['source','config','binding'])('checks %s again immediately before transfer',async problem=>{
        let allowed=true;const snapshot=await readQuirksSource(root,async()=>{if(!allowed)throw new Error('binding replaced');});
        if(problem==='source')await fs.writeFile(path.join(root,'.opencode/rag_db/quirks.jsonl'),JSON.stringify({...quirk,content:'changed'})+'\n');
        if(problem==='config')await fs.writeFile(path.join(root,'opencode-rag.json'),'{}');
        if(problem==='binding')allowed=false;
        await expect(snapshot.assertCurrent()).rejects.toThrow();
    });
});
