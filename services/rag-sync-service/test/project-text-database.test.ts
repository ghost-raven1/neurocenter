import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ProjectTextStore} from '../src/project-text/text-store';
import {textHash,emptyTextHash} from '../src/project-text/text-values';
import {textUploadCanonical,type TextDocument} from '../../shared/project-text-knowledge.cjs';
import {requireRagFeatures} from '../src/rag/rag-features';
import {authorizeTextUpload} from '../src/project-text/text-authorization';
import {checkRagQuotaMigration,checkRagMigrations} from '../src/database/migrations';
import {PROJECT_TEXT_MIGRATION} from '../src/database/migration-definitions';
import {lostTextAck,pausedTextSearch,semanticSeed,textDatabaseFixture,textDatabaseState} from './project-text-database.fixture';
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:async()=>()=>{}}));
vi.mock('../src/rag/rag-features',()=>({requireRagFeatures:vi.fn(async()=>{})}));
vi.mock('../src/project-text/text-authorization',()=>({authorizeTextUpload:vi.fn(async()=>{})}));

const connection=process.env.RAG_TEXT_TEST_PG_URL,actor={email:'owner@test',activeRole:'developer'};
const fixtures:Array<Awaited<ReturnType<typeof textDatabaseFixture>>>=[],cleanup:unknown[]=[];
const upload=(documents:TextDocument[],expectedRevision=0)=>({requestKey:randomUUID(),expectedRevision,documents});
const hash=(value:unknown)=>textHash(textUploadCanonical(value));
const put=(f:Awaited<ReturnType<typeof textDatabaseFixture>>,value:ReturnType<typeof upload>)=>f.text.upload(f.project,value,hash(value),actor);
async function fixture(){const f=await textDatabaseFixture(connection!);fixtures.push(f);return f;}
beforeEach(()=>{vi.resetAllMocks();vi.mocked(requireRagFeatures).mockResolvedValue();vi.mocked(authorizeTextUpload).mockResolvedValue();});
afterEach(async()=>{for(const f of fixtures.splice(0))cleanup.push(await f.dispose());});
afterAll(async()=>{if(process.env.RAG_TEXT_EVIDENCE_FILE)await writeFile(process.env.RAG_TEXT_EVIDENCE_FILE,JSON.stringify({cleanup},null,2)+'\n');});

describe.skipIf(!connection).sequential('Text corpus on real owned PostgreSQL and pgvector',()=>{
    it('empty reads do not create a revision, receipt or project budget',async()=>{
        const f=await fixture(),before=await textDatabaseState(f);
        expect(await f.text.state(f.project)).toMatchObject({revision:0,corpusHash:emptyTextHash,documentCount:0,bytes:0,updatedAt:null});
        expect(await f.text.search(f.project,{query:'кот'})).toMatchObject({revision:0,corpusHash:emptyTextHash,sources:[]});
        expect(await textDatabaseState(f)).toEqual(before);
    });
    it('fresh migration is strictly verified beside the frozen semantic quota schema',async()=>{
        const f=await fixture();expect(await checkRagQuotaMigration(f.pool)).toBe(true);
        expect(await checkRagMigrations(f.pool,[PROJECT_TEXT_MIGRATION])).toEqual({applied:[PROJECT_TEXT_MIGRATION.version],pending:[]});
        await f.pool.query('DROP INDEX project_text_search_idx');
        await expect(checkRagMigrations(f.pool,[PROJECT_TEXT_MIGRATION])).rejects.toThrow(/Структура схемы/);
    });
    it('uploads Russian/code documents, returns bounded literal citations and isolates other projects',async()=>{
        const f=await fixture(),value=upload([{path:'docs/русский.md',content:'Заголовок\r\nКвантовый кот хранит знание.\r\n'},
            {path:'src/worker.ts',content:'export function cancelJob() { return "cancelled"; }\n'}]);
        const saved=await put(f,value);expect(saved).toMatchObject({revision:1,documentCount:2,requestKey:value.requestKey,requestHash:hash(value)});
        const result=await f.text.search(f.project,{query:'квантовый кот',revision:1});expect(result.sources).toHaveLength(1);
        expect(result.sources[0]).toMatchObject({path:'docs/русский.md',startLine:2,endLine:2,excerpt:'Квантовый кот хранит знание.\r\n'});
        expect(await f.text.search(f.project,{query:'квантовый absent'})).toMatchObject({sources:[]});
        expect(await f.text.search(f.project,{query:'cancelJob'})).toMatchObject({sources:[{path:'src/worker.ts'}]});
        expect(await f.text.search('prj-other',{query:'кот'})).toMatchObject({revision:0,sources:[]});
    });
    it('upserts exact paths without deleting prior documents and hashes actual sorted metadata',async()=>{
        const f=await fixture();await put(f,upload([{path:'z.md',content:'old'},{path:'a.md',content:'preserved'}]));
        const before=await f.text.search(f.project,{query:'old'}),updated=await put(f,upload([{path:'z.md',content:'new'}],1));
        const rows=(await f.pool.query('SELECT path,content_hash,bytes FROM project_text_documents WHERE project_key=$1 ORDER BY path COLLATE "C"',[f.project])).rows;
        expect(updated).toMatchObject({revision:2,documentCount:2,corpusHash:textHash(JSON.stringify(rows.map(r=>({path:r.path,contentHash:r.content_hash,bytes:r.bytes}))))});
        expect((await f.text.search(f.project,{query:'new'})).sources[0].id).toBe(before.sources[0].id);
        expect(await f.text.search(f.project,{query:'preserved'})).toMatchObject({sources:[{path:'a.md'}]});
        await expect(f.text.search(f.project,{query:'new',revision:1})).rejects.toMatchObject({status:409});
    });
    it('returns at most six deterministic UTF8 bounded excerpts from the actual source lines',async()=>{
        const f=await fixture(),content='Заголовок\nкот '+'界 '.repeat(2000);
        await put(f,upload(Array.from({length:8},(_,index)=>({path:`docs/${index}.md`,content}))));
        const first=await f.text.search(f.project,{query:'кот'}),again=await f.text.search(f.project,{query:'кот'});
        expect(first).toEqual(again);expect(first.sources).toHaveLength(6);expect(first.sources.map(source=>source.path)).toEqual(Array.from({length:6},(_,index)=>`docs/${index}.md`));
        for(const source of first.sources){expect(source.startLine).toBe(2);expect(source.endLine).toBe(2);expect(Buffer.byteLength(source.excerpt)).toBeLessThanOrEqual(3072);
            expect(content.includes(source.excerpt)).toBe(true);expect(source.excerpt).not.toContain('\ufffd');expect(source.score).toBeGreaterThanOrEqual(0);expect(source.score).toBeLessThanOrEqual(1);}
    });
    it('a lost COMMIT ACK recovers the exact receipt with flags off and no duplicate quota charge',async()=>{
        const f=await fixture(),value=upload([{path:'one.md',content:'accepted'}]),fault=lostTextAck(f.pool);
        await expect(new ProjectTextStore(fault.pool).upload(f.project,value,hash(value),actor)).rejects.toBe(fault.failure);
        const committed=await textDatabaseState(f),saved=await f.text.receipt(f.project,value.requestKey,actor);
        vi.mocked(requireRagFeatures).mockRejectedValue(Error('OFF'));vi.mocked(authorizeTextUpload).mockRejectedValue(Error('revoked'));
        expect(await put(f,value)).toEqual(saved);expect(await textDatabaseState(f)).toEqual(committed);
        const changed={...value,documents:[{path:'one.md',content:'changed'}]};await expect(put(f,changed)).rejects.toMatchObject({status:409});
        expect(await f.text.receipt(f.project,value.requestKey,{...actor,email:'other@test'})).toBeNull();
    });
    it('quota failure rolls back the complete batch, state, receipt and shared budget',async()=>{
        const f=await fixture();await semanticSeed(f);await put(f,upload([{path:'kept.md',content:'old document'}]));
        const quota=await f.db.quota(f.project);await f.db.quota(f.project,{limitBytes:quota.usedBytes+50,expectedRevision:quota.revision},actor.email);
        const before=await textDatabaseState(f),value=upload([{path:'kept.md',content:'x'.repeat(2000)},{path:'new.md',content:'new text'}],1);
        await expect(put(f,value)).rejects.toMatchObject({status:413});expect(await textDatabaseState(f)).toEqual(before);
        expect(await f.text.receipt(f.project,value.requestKey,actor)).toBeNull();
    });
    it('charges documents, state and durable receipts in the same deferred semantic budget',async()=>{
        const f=await fixture();await semanticSeed(f);await put(f,upload([{path:'text.md',content:'shared budget'}]));
        const used=(await f.db.quota(f.project)).usedBytes;
        const {rows}=await f.pool.query(`SELECT
            (SELECT sum(public.neurocenter_rag_row_bytes(c)) FROM rag_chunks c WHERE project_key=$1)+
            (SELECT sum(public.neurocenter_text_row_bytes(to_jsonb(d))) FROM project_text_documents d WHERE project_key=$1)+
            (SELECT sum(public.neurocenter_text_row_bytes(to_jsonb(s))) FROM project_text_state s WHERE project_key=$1)+
            (SELECT sum(public.neurocenter_text_row_bytes(to_jsonb(r))) FROM project_text_receipts r WHERE project_key=$1) AS bytes`,[f.project]);
        expect(used).toBe(Number(rows[0].bytes));
        await f.pool.query('TRUNCATE rag_chunks');const after=await f.db.quota(f.project);expect(after.usedBytes).toBeGreaterThan(0);expect(after.usedBytes).toBeLessThan(used);
        const before=await textDatabaseState(f),value=upload([{path:'second.md',content:'x'.repeat(2000)}],1);
        await f.db.quota(f.project,{limitBytes:after.usedBytes+50,expectedRevision:after.revision});
        await expect(put(f,value)).rejects.toMatchObject({status:413});expect((await textDatabaseState(f)).project_text_documents).toEqual(before.project_text_documents);
    });
    it('two writers with one expected revision commit one complete batch',async()=>{
        const f=await fixture(),a=upload([{path:'a.md',content:'alpha'}]),b=upload([{path:'b.md',content:'beta'}]);
        const results=await Promise.allSettled([put(f,a),put(f,b)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
        expect(results.filter(r=>r.status==='rejected')).toMatchObject([{reason:{status:409}}]);
        expect(await f.text.state(f.project)).toMatchObject({revision:1,documentCount:1});expect((await f.pool.query('SELECT * FROM project_text_receipts')).rowCount).toBe(1);
    });
    it('concurrent identical retries share one committed receipt and one revision',async()=>{
        const f=await fixture(),value=upload([{path:'one.md',content:'one'}]);
        const results=await Promise.all([put(f,value),put(f,value)]);expect(results[0]).toEqual(results[1]);
        expect(await f.text.state(f.project)).toMatchObject({revision:1,documentCount:1});expect((await f.pool.query('SELECT * FROM project_text_receipts')).rowCount).toBe(1);
    });
    it('search keeps the whole old snapshot while another connection commits the new corpus',async()=>{
        const f=await fixture();const first=await put(f,upload([{path:'readme.md',content:'old token'}]));
        const gate=pausedTextSearch(f.pool),reading=new ProjectTextStore(gate.pool).search(f.project,{query:'old',revision:1});
        await gate.paused;
        try{await put(f,upload([{path:'readme.md',content:'new token'}],1));}finally{gate.resume();}
        const old=await reading;expect(old).toMatchObject({revision:1,corpusHash:first.corpusHash,sources:[{excerpt:'old token'}]});
        expect(await f.text.search(f.project,{query:'old'})).toMatchObject({revision:2,sources:[]});
    });
    it('revoked authority and disabled flag preserve accepted data and history',async()=>{
        const f=await fixture();const original=await put(f,upload([{path:'old.md',content:'keep'}])),before=await textDatabaseState(f);
        vi.mocked(authorizeTextUpload).mockRejectedValueOnce(Object.assign(Error('revoked'),{status:403}));
        await expect(put(f,upload([{path:'new.md',content:'denied'}],1))).rejects.toMatchObject({status:403});expect(await textDatabaseState(f)).toEqual(before);
        vi.mocked(requireRagFeatures).mockRejectedValue(Error('OFF'));
        await expect(put(f,upload([{path:'new.md',content:'off'}],1))).rejects.toThrow('OFF');await expect(f.text.search(f.project,{query:'keep'})).rejects.toThrow('OFF');
        expect(await f.text.receipt(f.project,original.requestKey,actor)).toEqual(original);expect(await f.text.state(f.project)).toMatchObject({revision:1});
        expect(await textDatabaseState(f)).toEqual(before);
    });
    it('text uploads and reads preserve the exact real semantic generation, profile, seal and vectors',async()=>{
        const f=await fixture();await semanticSeed(f);const before=await textDatabaseState(f);
        await put(f,upload([{path:'text.md',content:'unrelated corpus'}]));await f.text.search(f.project,{query:'corpus'});
        const after=await textDatabaseState(f);for(const table of ['rag_chunks','rag_generations','rag_index_state','rag_write_receipts'])expect(after[table]).toEqual(before[table]);
    });
});
