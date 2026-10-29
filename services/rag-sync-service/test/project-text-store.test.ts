import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ProjectTextStore} from '../src/project-text/text-store';
import {textExcerpt,textHash,emptyTextHash} from '../src/project-text/text-values';
import {textUploadCanonical} from '../../shared/project-text-knowledge.cjs';
import {requireRagFeatures} from '../src/rag/rag-features';
import {authorizeTextUpload} from '../src/project-text/text-authorization';
vi.mock('../src/rag/rag-features',()=>({requireRagFeatures:vi.fn(async()=>{})}));
vi.mock('../src/project-text/text-authorization',()=>({authorizeTextUpload:vi.fn(async()=>{})}));
const actor={email:'owner@test',activeRole:'developer'},project='prj-text';
const input=()=>({requestKey:randomUUID(),expectedRevision:0,documents:[{path:'docs/readme.md',content:'Русский текст про кота.'}]});
const hash=(value:unknown)=>textHash(textUploadCanonical(value));

function fixture(rows:(sql:string)=>unknown[]=()=>[]){
    const calls:string[]=[],release=vi.fn(),query=vi.fn(async(sql:string)=>{calls.push(sql);return {rows:rows(sql)};});
    const pool={query,connect:vi.fn(async()=>({query,release}))}as unknown as Pool;
    return {store:new ProjectTextStore(pool),pool,calls,query,release};
}
beforeEach(()=>{vi.resetAllMocks();vi.mocked(requireRagFeatures).mockResolvedValue();vi.mocked(authorizeTextUpload).mockResolvedValue();});

describe('Text upload transaction boundaries',()=>{
    it('validates exact canonical payload bytes before opening a transaction',async()=>{
        const f=fixture(),value=input();
        await expect(f.store.upload(project,value,'a'.repeat(64),actor)).rejects.toMatchObject({status:400});
        expect(f.pool.connect).not.toHaveBeenCalled();
        await expect(f.store.upload(project,{...value,documents:[{path:'../secret',content:'x'}]},hash(value),actor)).rejects.toMatchObject({status:400});
        expect(f.pool.connect).not.toHaveBeenCalled();
    });
    it('recovers the exact owner receipt while new flags and write authorization are unavailable',async()=>{
        const value=input(),saved={mode:'text',projectId:project,revision:1,requestKey:value.requestKey,requestHash:hash(value)};
        const f=fixture(sql=>sql.startsWith('SELECT request_hash')?[{request_hash:hash(value),result:saved}]:[]);
        vi.mocked(requireRagFeatures).mockRejectedValueOnce(Error('OFF'));
        expect(await f.store.upload(project,value,hash(value),actor)).toEqual(saved);
        expect(requireRagFeatures).not.toHaveBeenCalled();expect(authorizeTextUpload).not.toHaveBeenCalled();
        expect(f.calls.at(-1)).toBe('COMMIT');expect(f.calls.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
    });
    it('conflicts on an already committed key with different content before any new admission',async()=>{
        const value=input(),f=fixture(sql=>sql.startsWith('SELECT request_hash')?[{request_hash:'b'.repeat(64),result:{}}]:[]);
        await expect(f.store.upload(project,value,hash(value),actor)).rejects.toMatchObject({status:409});
        expect(requireRagFeatures).not.toHaveBeenCalled();expect(authorizeTextUpload).not.toHaveBeenCalled();expect(f.calls.at(-1)).toBe('ROLLBACK');
    });
    it('rejects stale CAS before callback or any text mutation',async()=>{
        const value=input(),f=fixture(sql=>sql.startsWith('SELECT * FROM project_text_state')?[{revision:2}]:[]);
        vi.mocked(requireRagFeatures).mockResolvedValueOnce();
        await expect(f.store.upload(project,value,hash(value),actor)).rejects.toMatchObject({status:409});
        expect(authorizeTextUpload).not.toHaveBeenCalled();expect(f.calls.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
    });
    it('fresh denial leaves every text row and quota untouched',async()=>{
        const value=input(),f=fixture(),denied=Error('permission revoked');
        vi.mocked(requireRagFeatures).mockResolvedValueOnce();vi.mocked(authorizeTextUpload).mockRejectedValueOnce(denied);
        await expect(f.store.upload(project,value,hash(value),actor)).rejects.toBe(denied);
        expect(authorizeTextUpload).toHaveBeenCalledWith({projectId:project,actor,requestKey:value.requestKey,requestHash:hash(value)});
        expect(f.calls.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);expect(f.calls.at(-1)).toBe('ROLLBACK');
    });
    it('fresh authorization immediately precedes the first mutation and one receipt commits with the corpus',async()=>{
        const value=input(),now=new Date('2026-10-29T00:00:00.123Z');
        const f=fixture(sql=>sql.startsWith('SELECT path,content_hash')?[{path:value.documents[0].path,content_hash:textHash(value.documents[0].content),bytes:50}]
            :sql.startsWith('INSERT INTO project_text_state')?[{revision:1,corpus_hash:'c'.repeat(64),document_count:1,bytes:50,updated_at:now}]:[]);
        vi.mocked(authorizeTextUpload).mockImplementationOnce(async()=>{f.calls.push('AUTHORIZE');});
        expect(await f.store.upload(project,value,hash(value),actor)).toMatchObject({revision:1,requestKey:value.requestKey,updatedAt:now.toISOString(),acceptedAt:now.toISOString()});
        const first=f.calls.findIndex(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql));expect(f.calls[first-1]).toBe('AUTHORIZE');
        expect(f.calls.filter(sql=>sql.startsWith('INSERT INTO project_text_receipts'))).toHaveLength(1);expect(f.calls.at(-1)).toBe('COMMIT');
    });
    it('discarding an uncertain rollback preserves the primary authorization failure',async()=>{
        const value=input(),f=fixture(),failure=Error('fresh authority unavailable');
        vi.mocked(requireRagFeatures).mockResolvedValueOnce();vi.mocked(authorizeTextUpload).mockRejectedValueOnce(failure);
        const real=f.query.getMockImplementation()!;f.query.mockImplementation(async(sql:string)=>{if(sql==='ROLLBACK')throw Error('ACK lost');return real(sql);});
        await expect(f.store.upload(project,value,hash(value),actor)).rejects.toBe(failure);expect(f.release).toHaveBeenCalledWith(true);
    });
    it('empty state and owner receipt reads remain available without flags or write admission',async()=>{
        const f=fixture();expect(await f.store.state(project)).toEqual({mode:'text',projectId:project,revision:0,corpusHash:emptyTextHash,documentCount:0,bytes:0,updatedAt:null});
        expect(await f.store.receipt(project,randomUUID(),actor)).toBeNull();expect(requireRagFeatures).not.toHaveBeenCalled();
        expect(authorizeTextUpload).not.toHaveBeenCalled();expect(f.pool.connect).not.toHaveBeenCalled();
    });
});

describe('Literal bounded source excerpts',()=>{
    const source=(content:string,query_lexemes:string[])=>textExcerpt({id:'stable',path:'docs/file.md',content,score:0.5,query_lexemes});
    it('uses exact CRLF/CR/LF source line boundaries and skips a distant preamble',()=>{
        const content='first\r\nsecond\rthird\n'+'x\n'.repeat(2000)+'Русский кот.\r\n';
        const result=source(content,['кот']);expect(result).toMatchObject({id:'stable',startLine:2004,endLine:2004,excerpt:'Русский кот.\r\n'});
    });
    it('never splits a UTF8 code point or invents ellipsis text in a long single line',()=>{
        const content='界'.repeat(4000)+' кот '+'🙂'.repeat(3000),result=source(content,['кот']);
        expect(result.startLine).toBe(1);expect(result.endLine).toBe(1);expect(result.excerpt).toContain('кот');
        expect(content.includes(result.excerpt)).toBe(true);expect(Buffer.byteLength(result.excerpt)).toBeLessThanOrEqual(3072);expect(result.excerpt).not.toContain('\ufffd');
    });
    it('matches escaped punctuation lexemes and does not confuse a substring with a whole word',()=>{
        const content='caterpillar\n'+'padding\n'.repeat(500)+'cat and config.ts';
        expect(source(content,['cat','config.ts'])).toMatchObject({startLine:502,endLine:502,excerpt:'cat and config.ts'});
    });
});
