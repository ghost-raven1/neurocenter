import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {Client,Pool} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {RagDb,type IUpsertRow} from '../src/rag/rag-db';
import {setupRagQuota,ragQuotaPolicy} from '../src/rag/quota/rag-quota';
import {rowFingerprint,indexSnapshotHash} from '../../shared/rag-index-contract.cjs';
import {generation} from './rag-write.fixture';
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:async()=>()=>{}}));

const connection=process.env.RAG_CONTRACT_TEST_PG_URL;
const profile={provider:'openai',model:'neurocenter/model-fixture/sha256/'+'a'.repeat(64),dimension:3};
const target={...profile,model:'neurocenter/model-next/sha256/'+'b'.repeat(64),dimension:5};
const makeRow=(id:string):IUpsertRow=>({id,filePath:`src/${id}.ts`,content:'text-'+id,description:null,startLine:1,endLine:1,
    language:'typescript',kind:'code',role:null,quirkType:null,tags:null,contentHash:createHash('sha256').update('text-'+id).digest('hex'),embedding:[1,0,0]});
const seal=(rows:IUpsertRow[],complete=false)=>({indexProfile:profile,snapshot:{hash:indexSnapshotHash(profile,Object.fromEntries(rows.map(row=>[row.id,rowFingerprint(row)]))),rowCount:rows.length,complete}});
const fake=vi.fn(async(texts:string[])=>texts.map((_text,index)=>[index+1,1,0,0,0]));

describe.skipIf(!connection)('Поколения RAG: отдельная временная PostgreSQL DB, реальные транзакции и pgvector',()=>{
    let admin:Client,sql:Client,db:RagDb,other:RagDb,created=false;
    const name='nc_rag_generations_test_'+randomUUID().replaceAll('-','');
    beforeAll(async()=>{
        const url=new URL(connection!);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Разрешён только локальный тестовый PostgreSQL.');
        admin=new Client({connectionString:url.toString()});await admin.connect();await admin.query(`CREATE DATABASE "${name}"`);created=true;url.pathname='/'+name;
        sql=new Client({connectionString:url.toString()});await sql.connect();
        await sql.query(`CREATE EXTENSION vector;CREATE TABLE rag_chunks(id TEXT NOT NULL,project_key TEXT NOT NULL,file_path TEXT NOT NULL DEFAULT '',content TEXT NOT NULL,
            description TEXT,start_line INTEGER,end_line INTEGER,language TEXT,kind TEXT NOT NULL DEFAULT '',role TEXT,quirk_type TEXT,tags TEXT,content_hash TEXT NOT NULL,
            embedding vector(3),sync_hash TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(id,project_key));
            CREATE TABLE rag_index_state(project_key TEXT PRIMARY KEY,index_profile JSONB,complete BOOLEAN NOT NULL DEFAULT false,snapshot_hash TEXT,snapshot_rows BIGINT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        const seed=makeRow('preserved'),snapshot=seal([seed],true).snapshot;
        await sql.query(`INSERT INTO rag_chunks(id,project_key,file_path,content,start_line,end_line,language,kind,content_hash,embedding,sync_hash)
            VALUES($1,'migration',$2,$3,1,1,'typescript','code',$4,'[1,0,0]',$5)`,[seed.id,seed.filePath,seed.content,seed.contentHash,rowFingerprint(seed)]);
        await sql.query('INSERT INTO rag_index_state(project_key,index_profile,complete,snapshot_hash,snapshot_rows) VALUES($1,$2::jsonb,true,$3,1)',['migration',JSON.stringify(profile),snapshot.hash]);
        const oldPool=new Pool({connectionString:url.toString()});try{await setupRagQuota(oldPool,ragQuotaPolicy());}finally{await oldPool.end();}
        db=new RagDb({url:url.toString()});other=new RagDb({url:url.toString()});await db.setup();await other.setup();
    },30000);
    afterAll(async()=>{await Promise.all([db?.close(),other?.close()]);await sql?.end();if(created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin?.end();});
    async function source(key:string,count=2){
        const rows=Array.from({length:count},(_value,index)=>makeRow(key+'-'+index));
        if(rows.length)await db.applyDelta(key,generation(key),rows,[],seal(rows));
        await db.applyDelta(key,generation(key),[],[],seal(rows,true));
        const snapshot=await db.generations.source(key,generation(key));return {key,rows,snapshot,before:await db.manifest(key,generation(key))};
    }
    async function candidate(key:string,count=2){const value=await source(key,count),id=randomUUID();await db.generations.create(key,id,generation(key),target,value.snapshot.hash);return {...value,id};}

    it('Миграция vector(3) сохраняет значения, подтверждённый seal и прежний quota ledger',async()=>{
        const manifest=await db.manifest('migration',generation('migration'));expect(manifest).toMatchObject({rowCount:1,dimension:3,complete:true,indexProfile:profile});
        expect(manifest.fingerprints.preserved).toBe(rowFingerprint(makeRow('preserved')));
        const type=await sql.query("SELECT format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='rag_chunks'::regclass AND attname='embedding'");expect(type.rows[0].type).toBe('vector');
        expect((await db.quota('migration')).usedBytes).toBeGreaterThan(0);
    });
    it('Кандидат с другой размерностью содержит полную frozen source; активный индекс не меняется',async()=>{
        const value=await candidate('frozen');expect(await db.generations.get(value.key,value.id)).toMatchObject({state:'building',profile:target,rowCount:2,sourceSnapshot:value.snapshot.hash});
        expect((await db.rowsPage(value.key,value.id,10,0)).every(row=>row.embedding===null)).toBe(true);expect(await db.manifest(value.key,generation(value.key))).toEqual(value.before);
    });
    it('Проверенный receipt появляется только после всех векторов и native dimension-specific HNSW',async()=>{
        const value=await candidate('ready'),result=await db.generations.build(value.key,value.id,fake);
        expect(result).toMatchObject({state:'ready',profile:target,processedRows:2,search:'hnsw-cosine',receiptHash:expect.stringMatching(/^[a-f0-9]{64}$/)});
        expect(await db.summary(value.key,value.id)).toMatchObject({complete:true,dimension:5,rowCount:2});
        const definition=await sql.query("SELECT indexdef FROM pg_indexes WHERE tablename='rag_chunks' AND indexname=$1",['rag_gen_'+createHash('sha256').update(value.id).digest('hex').slice(0,24)]);
        expect(definition.rows[0].indexdef).toContain('vector(5)');
        await sql.query('SET enable_seqscan=off');try{
            const nearest=await sql.query('SELECT id FROM rag_chunks WHERE generation_id=$1 AND embedding IS NOT NULL ORDER BY embedding::vector(5)<=>$2::vector(5) LIMIT 1',[value.id,'[1,1,0,0,0]']);expect(nearest.rows[0].id).toBe(value.rows[0].id);
            const plan=await sql.query('EXPLAIN SELECT id FROM rag_chunks WHERE generation_id=$1 AND embedding IS NOT NULL ORDER BY embedding::vector(5)<=>$2::vector(5) LIMIT 1',[value.id,'[1,1,0,0,0]']);expect(JSON.stringify(plan.rows)).toContain('rag_gen_');
        }finally{await sql.query('RESET enable_seqscan');}
        expect(await db.manifest(value.key,generation(value.key))).toEqual(value.before);
    });
    it('Размерность 2560 сохраняется без downcast и честно использует exact cosine',async()=>{
        const value=await source('large-dimension',1),id=randomUUID(),large={...target,dimension:2560};await db.generations.create(value.key,id,generation(value.key),large,value.snapshot.hash);
        const result=await db.generations.build(value.key,id,async texts=>texts.map(()=>Array(2560).fill(0.1)));expect(result.search).toBe('exact-cosine');expect((await db.rowsPage(value.key,id,10,0))[0].embedding).toHaveLength(2560);
        const index=await sql.query('SELECT 1 FROM pg_indexes WHERE indexname=$1',['rag_gen_'+createHash('sha256').update(id).digest('hex').slice(0,24)]);expect(index.rows).toHaveLength(0);
    });
    it('Нулевой источник создаёт готовое пустое поколение без вызова модели',async()=>{
        const value=await candidate('empty',0),embed=vi.fn();const result=await db.generations.build(value.key,value.id,embed);expect(result).toMatchObject({state:'ready',rowCount:0,processedRows:0});expect(embed).not.toHaveBeenCalled();expect(await db.summary(value.key,value.id)).toMatchObject({complete:true,rowCount:0});
    });
    it.each(['wrong-dimension','zero','overflow','missing-batch'])('Негативный ответ %s сохраняет действующий индекс',async failure=>{
        const value=await candidate('bad-'+failure),embedding=failure==='wrong-dimension'?[1,0,0]:failure==='zero'?[0,0,0,0,0]:[1e100,1,0,0,0];
        await expect(db.generations.build(value.key,value.id,async texts=>failure==='missing-batch'?[]:texts.map(()=>embedding))).rejects.toMatchObject({status:400});
        expect((await db.generations.get(value.key,value.id)).state).toBe('failed');expect(await db.manifest(value.key,generation(value.key))).toEqual(value.before);
    });
    it('Изменение source между prepare и clone отвергается до появления кандидата',async()=>{
        const value=await source('source-race'),id=randomUUID(),changed={...value.rows[0],content:'changed'};
        await db.applyDelta(value.key,generation(value.key),[changed],[],seal([changed,...value.rows.slice(1)]));
        await expect(db.generations.create(value.key,id,generation(value.key),target,value.snapshot.hash)).rejects.toMatchObject({status:409});await expect(db.generations.get(value.key,id)).rejects.toMatchObject({status:404});
    });
    it('Изменение source во время build обнаруживается по реальному hash; frozen candidate полон',async()=>{
        const value=await candidate('source-during-build'),changed={...value.rows[0],content:'changed'};
        await db.applyDelta(value.key,generation(value.key),[changed],[],seal([changed,...value.rows.slice(1)]));
        const ready=await db.generations.build(value.key,value.id,fake);expect(ready.sourceSnapshot).toBe(value.snapshot.hash);expect((await db.generations.source(value.key,generation(value.key))).hash).not.toBe(ready.sourceSnapshot);
        expect((await db.rowsPage(value.key,value.id,10,0))[0].content).toBe(value.rows[0].content);
    });
    it('Повтор после сбоя продолжает только неподтверждённые батчи',async()=>{
        const value=await candidate('restart',65);let calls=0;
        await expect(db.generations.build(value.key,value.id,async texts=>{calls++;if(calls===2)throw Error('network');return texts.map(()=>[1,1,0,0,0]);})).rejects.toThrow('network');
        expect((await db.generations.get(value.key,value.id)).processedRows).toBe(32);await db.generations.retry(value.key,value.id);
        const batches:number[]=[];expect((await db.generations.build(value.key,value.id,async texts=>{batches.push(texts.length);return texts.map(()=>[1,1,0,0,0]);})).state).toBe('ready');expect(batches).toEqual([32,1]);
    });
    it('Cancel во время inference не пишет поздние векторы и возвращает quota',async()=>{
        const value=await candidate('cancel'),quota=(await db.quota(value.key)).usedBytes;let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),embed=vi.fn(async(texts:string[])=>{await gate;return texts.map(()=>[1,1,0,0,0]);});
        const work=db.generations.build(value.key,value.id,embed);await vi.waitFor(()=>expect(embed).toHaveBeenCalledOnce());
        await db.generations.cancel(value.key,value.id,{profile:target,sourceGeneration:generation(value.key),sourceSnapshot:value.snapshot.hash});release();expect((await work).state).toBe('cancelled');expect(await db.count(value.key,value.id)).toBe(0);expect((await db.quota(value.key)).usedBytes).toBeLessThan(quota);expect(await db.manifest(value.key,generation(value.key))).toEqual(value.before);
    });
    it('Cancel перед поздним create оставляет tombstone и не позволяет оживить кандидат',async()=>{
        const value=await source('cancel-before-create'),id=randomUUID();await db.generations.cancel(value.key,id,{profile:target,sourceGeneration:generation(value.key),sourceSnapshot:value.snapshot.hash});
        expect((await db.generations.create(value.key,id,generation(value.key),target,value.snapshot.hash)).state).toBe('cancelled');expect(await db.count(value.key,id)).toBe(0);
    });
    it('Параллельный create и build не дублируют строки, батчи и receipt',async()=>{
        const value=await source('concurrent'),id=randomUUID();await Promise.all([db,other].map(store=>store.generations.create(value.key,id,generation(value.key),target,value.snapshot.hash)));
        let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),embed=vi.fn(async(texts:string[])=>{await gate;return texts.map(()=>[1,1,0,0,0]);});
        const first=db.generations.build(value.key,id,embed);await vi.waitFor(()=>expect(embed).toHaveBeenCalledOnce());const second=await other.generations.build(value.key,id,embed);expect(second.state).toBe('building');release();expect((await first).state).toBe('ready');expect(embed).toHaveBeenCalledOnce();expect(await db.count(value.key,id)).toBe(2);
    });
    it('Превышение quota откатывает clone, active snapshot и ledger остаются целыми',async()=>{
        const value=await source('quota'),quota=await db.quota(value.key),id=randomUUID();await db.quota(value.key,{expectedRevision:quota.revision,limitBytes:quota.usedBytes+1},'fixture');
        await expect(db.generations.create(value.key,id,generation(value.key),target,value.snapshot.hash)).rejects.toMatchObject({status:413});expect(await db.manifest(value.key,generation(value.key))).toEqual(value.before);expect((await db.quota(value.key)).usedBytes).toBe(quota.usedBytes);await expect(db.generations.get(value.key,id)).rejects.toMatchObject({status:404});
    });
    it('Ошибка COMMIT батча откатывает векторы, progress и quota вместе',async()=>{
        const value=await candidate('commit-failure'),before=await db.quota(value.key);
        await sql.query(`CREATE FUNCTION fixture_fail_generation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.generation_id='${value.id}' THEN RAISE EXCEPTION 'fixture deferred failure'; END IF;RETURN NEW;END $$;
            CREATE CONSTRAINT TRIGGER fixture_generation_failure AFTER INSERT OR UPDATE ON rag_chunks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_fail_generation()`);
        try{await expect(db.generations.build(value.key,value.id,fake)).rejects.toThrow('fixture deferred failure');expect((await db.generations.get(value.key,value.id)).processedRows).toBe(0);expect((await db.rowsPage(value.key,value.id,10,0)).every(row=>row.embedding===null)).toBe(true);expect((await db.quota(value.key)).usedBytes).toBe(before.usedBytes);}
        finally{await sql.query('DROP TRIGGER fixture_generation_failure ON rag_chunks;DROP FUNCTION fixture_fail_generation()');}
        expect(await db.manifest(value.key,generation(value.key))).toEqual(value.before);
    });
    it('Потерянный ACK и параллельный retry одного write intent дают один результат',async()=>{
        const value=await source('write-receipt'),changed={...value.rows[0],content:'changed'},rows=[changed,value.rows[1]],intent={id:randomUUID(),payloadHash:'c'.repeat(64)};
        const results=await Promise.all([db,other].map(store=>store.applyDelta(value.key,generation(value.key),[changed],[],seal(rows),intent)));expect(results[0]).toEqual(results[1]);
        await expect(db.applyDelta(value.key,generation(value.key),[changed],[],seal(rows),{...intent,payloadHash:'d'.repeat(64)})).rejects.toMatchObject({status:400});expect((await db.rowsPage(value.key,generation(value.key),10,0))[0].content).toBe('changed');
    });
    it('Чужой проект, unsupported dimension и произвольная generation не дают читать или писать чужой индекс',async()=>{
        const value=await candidate('scope');await expect(db.generations.get('foreign',value.id)).rejects.toMatchObject({status:404});
        await expect(db.generations.create(value.key,randomUUID(),generation(value.key),{...target,dimension:16001},value.snapshot.hash)).rejects.toMatchObject({status:400});
        await expect(db.applyDelta(value.key,'../../foreign',[],[],seal([],true))).rejects.toMatchObject({status:400});expect(await db.manifest(value.key,generation(value.key))).toEqual(value.before);
    });
});
