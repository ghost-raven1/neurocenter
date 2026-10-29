import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ownedQuotaRollbackUrl} from './platform-quota-rollback.fixture';
import {GENERATION_MIGRATION,IDENTITY_MIGRATION,PLATFORM_QUOTA_CACHE_MIGRATION,PROJECT_TEXT_MIGRATION,PROJECT_TEXT_LIMITS_MIGRATION} from '../src/database/migration-definitions';
import {migrateRag,checkRagMigrations,checkRagQuotaMigration} from '../src/database/migrations';
import {setupRagQuota} from '../src/rag/quota/rag-quota';
import {RagDb} from '../src/rag/rag-db';
import {ProjectTextStore} from '../src/project-text/text-store';
import {textHash} from '../src/project-text/text-values';
import {TEXT_KNOWLEDGE_LIMITS,TEXT_KNOWLEDGE_CEILINGS,textUploadCanonical} from '../../shared/project-text-knowledge.cjs';
vi.mock('../src/rag/rag-features',()=>({requireRagFeatures:vi.fn(async()=>{})}));
vi.mock('../src/project-text/text-authorization',()=>({authorizeTextUpload:vi.fn(async()=>{})}));
const connection=process.env.RUNTIME_LIMITS_RAG_TEST_ADMIN_URL,actor={email:'owner@runtime-limits.test',activeRole:'Разработчик'},project='prj-runtime-limits';

describe.skipIf(!connection).sequential('Explicit text physical successor — owned PostgreSQL',()=>{
    let admin:Pool,pool:Pool,name:string,url:URL;
    beforeEach(async()=>{
        url=ownedQuotaRollbackUrl(connection!);admin=new Pool({connectionString:url.href,max:1});name='nc_text_limits_'+randomUUID().replaceAll('-','');
        await admin.query('CREATE DATABASE '+name);url.pathname='/'+name;pool=new Pool({connectionString:url.href,max:4});
        await migrateRag(pool,[GENERATION_MIGRATION,IDENTITY_MIGRATION]);await setupRagQuota(pool,{defaultBytes:1024**3,maximumBytes:16*1024**3});
        await migrateRag(pool,[PLATFORM_QUOTA_CACHE_MIGRATION,PROJECT_TEXT_MIGRATION]);
    });
    afterEach(async()=>{
        await pool?.end();if(admin){await admin.query('DROP DATABASE IF EXISTS '+name);
            expect((await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[name])).rows).toEqual([]);
            expect((await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name])).rows).toEqual([]);await admin.end();}
    });
    const business=async()=>Promise.all(['project_text_documents','project_text_state','project_text_receipts','rag_storage_budget','rag_quota_events','rag_chunks'].map(async table=>(await pool.query('SELECT to_jsonb(t) AS row FROM '+table+' t ORDER BY to_jsonb(t)::text')).rows));
    const seed=async()=>{
        const value={requestKey:randomUUID(),expectedRevision:0,documents:[{path:'old.md',content:'original accepted source'}]};
        const store=new ProjectTextStore(pool,async()=>({revision:0,limits:TEXT_KNOWLEDGE_LIMITS}));
        await store.upload(project,value,textHash(textUploadCanonical(value)),actor);return value;
    };

    it('upgrades old text1, retains all business bytes, repeats startup and verifies the full successor for old inspections',async()=>{
        await seed();const before=await business(),history=(await pool.query('SELECT version,checksum,applied_at FROM neurocenter_rag_schema_versions ORDER BY version')).rows;
        await migrateRag(pool,[PROJECT_TEXT_MIGRATION,PROJECT_TEXT_LIMITS_MIGRATION]);
        const rag=new RagDb({url:url.href});try{await rag.setup();}finally{await rag.close();}
        expect(await business()).toEqual(before);
        expect((await pool.query('SELECT version,checksum,applied_at FROM neurocenter_rag_schema_versions WHERE version<>$1 ORDER BY version',[PROJECT_TEXT_LIMITS_MIGRATION.version])).rows).toEqual(history);
        expect(await checkRagMigrations(pool,[PROJECT_TEXT_MIGRATION,PROJECT_TEXT_LIMITS_MIGRATION])).toEqual({applied:[PROJECT_TEXT_MIGRATION.version,PROJECT_TEXT_LIMITS_MIGRATION.version],pending:[]});
        expect(await checkRagQuotaMigration(pool)).toBe(true);await pool.query('DROP INDEX project_text_search_idx');
        await expect(checkRagMigrations(pool,[PROJECT_TEXT_MIGRATION])).rejects.toThrow('Структура схемы');
    });
    it('rolls back a partial successor DDL failure and permits an explicit correct retry',async()=>{
        await seed();const before=await business();
        await expect(migrateRag(pool,[PROJECT_TEXT_MIGRATION,{...PROJECT_TEXT_LIMITS_MIGRATION,sql:PROJECT_TEXT_LIMITS_MIGRATION.sql+';SELECT intentionally_missing_text_limit_function()'}])).rejects.toThrow();
        expect(await business()).toEqual(before);
        expect(await checkRagMigrations(pool,[PROJECT_TEXT_MIGRATION])).toEqual({applied:[PROJECT_TEXT_MIGRATION.version],pending:[]});
        expect((await pool.query('SELECT version FROM neurocenter_rag_schema_versions WHERE version=$1',[PROJECT_TEXT_LIMITS_MIGRATION.version])).rows).toEqual([]);
        await migrateRag(pool,[PROJECT_TEXT_MIGRATION,PROJECT_TEXT_LIMITS_MIGRATION]);expect((await checkRagMigrations(pool,[PROJECT_TEXT_LIMITS_MIGRATION])).pending).toEqual([]);
    });
    it('does not bless a drifted historical object before applying the successor',async()=>{
        await seed();await pool.query('ALTER TABLE project_text_documents ALTER COLUMN content DROP NOT NULL');
        await expect(migrateRag(pool,[PROJECT_TEXT_MIGRATION,PROJECT_TEXT_LIMITS_MIGRATION])).rejects.toThrow('Структура схемы');
        expect((await pool.query('SELECT version FROM neurocenter_rag_schema_versions WHERE version=$1',[PROJECT_TEXT_LIMITS_MIGRATION.version])).rows).toEqual([]);
    });
    it('preserves both frozen SQL checksums and refuses unknown future or changed successor history',async()=>{
        await migrateRag(pool,[PROJECT_TEXT_MIGRATION,PROJECT_TEXT_LIMITS_MIGRATION]);
        await pool.query('UPDATE neurocenter_rag_schema_versions SET checksum=$2 WHERE version=$1',[PROJECT_TEXT_LIMITS_MIGRATION.version,'0'.repeat(64)]);
        await expect(checkRagMigrations(pool,[PROJECT_TEXT_MIGRATION])).rejects.toThrow('История миграций');
    });
    it('new policy really controls uploads, query, sources and excerpts; committed recovery and accepted grants keep their snapshot',async()=>{
        await migrateRag(pool,[PROJECT_TEXT_MIGRATION,PROJECT_TEXT_LIMITS_MIGRATION]);
        let admission={revision:7,limits:{...TEXT_KNOWLEDGE_LIMITS,documents:32,pathBytes:2048,batchBytes:1024**2,sources:2,excerptBytes:12}};
        const store=new ProjectTextStore(pool,async()=>admission),value={requestKey:randomUUID(),expectedRevision:0,
            documents:Array.from({length:17},(_,index)=>({path:index===0?'x'.repeat(2048):'doc-'+index,content:'кот '+'界'.repeat(20)}))};
        const saved=await store.upload(project,value,textHash(textUploadCanonical(value)),actor),accepted=saved.admission!;
        const result=await store.search(project,{query:'кот'});expect(result.sources).toHaveLength(2);expect(result.sources.every(source=>Buffer.byteLength(source.excerpt)<=12)).toBe(true);
        const before=await business();admission={revision:8,limits:{...TEXT_KNOWLEDGE_LIMITS,documents:1,fileBytes:2,pathBytes:1,queryBytes:2,sources:1,excerptBytes:4}};
        expect(await store.upload(project,value,textHash(textUploadCanonical(value)),actor)).toEqual(saved);expect(await business()).toEqual(before);
        const next={...value,requestKey:randomUUID(),expectedRevision:1};await expect(store.upload(project,next,textHash(textUploadCanonical(next)),actor)).rejects.toHaveProperty('status',400);
        await expect(store.search(project,{query:'кот'})).rejects.toHaveProperty('status',400);
        expect((await store.search(project,{query:'кот'},accepted)).sources).toHaveLength(2);expect(TEXT_KNOWLEDGE_CEILINGS.fileBytes).toBe(131072);
    });
});
