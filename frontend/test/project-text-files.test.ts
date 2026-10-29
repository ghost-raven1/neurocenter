import {describe, expect, it} from 'vitest';
import {readTextFiles} from '../src/features/ProjectTextKnowledge/files';
import {defaultTextKnowledgeLimits as limits} from '../src/features/ProjectTextKnowledge/limits';
import {requireReceipt, requireSearch} from '../src/features/ProjectTextKnowledge/model';
import {requireTextLimitsDecision} from '../src/features/ProjectTextKnowledge/limits';

const file = (name:string, bytes:Uint8Array) => ({name,size:bytes.length,arrayBuffer:async () => bytes.buffer});
const text = (name:string, content:string) => file(name,new TextEncoder().encode(content));
describe('UTF-8 file boundary', () => {
    it('preserves Russian code, BOM, line endings, whitespace and file order', async () => {
        const documents=await readTextFiles([text('notes.md','\ufeff# Привет\r\n  мир\n'),text('code.ts','const ключ = "東京";\n')]);
        expect(documents).toEqual([{path:'notes.md',content:'\ufeff# Привет\r\n  мир\n'},{path:'code.ts',content:'const ключ = "東京";\n'}]);
    });
    it.each(['../secret','/absolute','folder//file','a\\b','control\u0001'])('rejects unsafe path %s', async path => {
        await expect(readTextFiles([text(path,'text')])).rejects.toThrow();
    });
    it('rejects binary controls, invalid UTF-8 and duplicate paths', async () => {
        await expect(readTextFiles([text('binary','a\0b')])).rejects.toThrow();
        await expect(readTextFiles([file('invalid',new Uint8Array([0xc3,0x28]))])).rejects.toThrow('UTF-8');
        await expect(readTextFiles([text('same','A'),text('same','B')])).rejects.toThrow();
    });
    it('counts UTF-8 bytes and path bytes, bounds the batch and honors stricter effective settings', async () => {
        await expect(readTextFiles([text('large','я'.repeat(limits.fileBytes/2+1))])).rejects.toThrow('превышает');
        await expect(readTextFiles(Array.from({length:limits.documents+1},(_,i)=>text(String(i),'A')))).rejects.toThrow();
        await expect(readTextFiles([text('a','1234'),text('b','5678')],{...limits,batchBytes:9})).rejects.toThrow();
        await expect(readTextFiles([text('a','A'),text('b','B')],{...limits,documents:1})).rejects.toThrow('до 1');
    });
});

describe('untrusted response guards', () => {
    const source={id:'one',path:'doc.md',startLine:1,endLine:2,excerpt:'real excerpt',score:0.5};
    const response={mode:'text',projectId:'prj-one',revision:1,corpusHash:'a'.repeat(64),sources:[source]};
    it.each([{projectId:'prj-other'},{sources:[{...source,endLine:0}]},{sources:[{...source,excerpt:' '}]},{sources:[source,source]},{sources:[{...source,score:Infinity}]}])('rejects a forged source result %j', change => {
        expect(()=>requireSearch({...response,...change},'prj-one')).toThrow();
    });
    it('does not treat an invalid receipt timestamp as an accepted upload', () => {
        expect(()=>requireReceipt({...response,documentCount:1,bytes:4,updatedAt:null,requestKey:'00000000-0000-0000-0000-000000000001',requestHash:'b'.repeat(64),acceptedAt:'yesterday'},'prj-one')).toThrow();
    });
    it.each([{revision:1},{revision:1,policy:{}},{revision:1,policy:{textKnowledge:undefined}}])('missing effective policy never silently becomes shared defaults: %j', value => {
        expect(()=>requireTextLimitsDecision(value)).toThrow();
    });
});
