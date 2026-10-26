import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { normalizeIndexProfile, rowFingerprint, indexSnapshotHash, type IIndexProfile } from '../../../shared/rag-index-contract.cjs';
import { RAG_WRITE_LOCK } from './quota/rag-quota-schema';
import { readIndexManifest, requireUsableVectors, sealIndex } from './rag-index-state';
import { buildUpsert, type IUpsertRow } from './rag-rows';
import {reserveCapacity} from '../../../shared/capacity.cjs';
import {mapRagQuotaError} from './quota/rag-quota';

export interface IRagGeneration {
    id: string; projectId: string; profile: IIndexProfile; state: 'building'|'ready'|'cancelled'|'failed';
    sourceGeneration: string; sourceSnapshot: string; rowCount: number; processedRows: number;
    snapshotHash: string|null; receiptHash: string|null; error: string|null;
    search: 'hnsw-cosine'|'exact-cosine';
}
const generationId=(value:unknown):value is string=>typeof value==='string'&&/^(?:initial-[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.test(value);
const columns='id,file_path,content,description,start_line,end_line,language,kind,role,quirk_type,tags,content_hash,embedding';
type Queryable=Pick<PoolClient,'query'>;
/** pgvector HNSW vector index ограничен 2000 значениями; большая размерность использует точный cosine. */
export async function ensureGenerationSearchIndex(db:Queryable,id:string,dimension:number,concurrently=false):Promise<void>{
    if(!generationId(id)||!Number.isSafeInteger(dimension)||dimension<1||dimension>16000)throw new BadRequestException('Некорректный профиль поискового индекса.');
    if(dimension>2000)return;
    const index='rag_gen_'+createHash('sha256').update(id).digest('hex').slice(0,24);
    if(concurrently){
        const existing=await db.query('SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=$1',[index]);
        if(existing.rows[0]?.indisvalid===false)await db.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index}`);
    }
    await db.query(`CREATE INDEX ${concurrently?'CONCURRENTLY ':''}IF NOT EXISTS ${index} ON rag_chunks USING hnsw ((embedding::vector(${dimension})) vector_cosine_ops) WHERE generation_id='${id}' AND embedding IS NOT NULL`);
}
function row(value:Record<string,unknown>):IUpsertRow {
    return {id:String(value.id),filePath:String(value.file_path),content:String(value.content),description:value.description as string|null,
        startLine:value.start_line as number|null,endLine:value.end_line as number|null,language:value.language as string|null,kind:String(value.kind),
        role:value.role as string|null,quirkType:value.quirk_type as string|null,tags:value.tags as string|null,contentHash:String(value.content_hash),
        embedding:typeof value.embedding==='string'?JSON.parse(value.embedding):value.embedding as number[]|null};
}
function map(value:Record<string,unknown>):IRagGeneration {
    const profile=normalizeIndexProfile(value.index_profile);
    if(!profile)throw new ConflictException('Поколению не назначен проверенный профиль модели.');
    return {id:String(value.id),projectId:String(value.project_key),profile,state:value.state as IRagGeneration['state'],
        sourceGeneration:String(value.source_generation),sourceSnapshot:String(value.source_snapshot),rowCount:Number(value.source_rows),processedRows:Number(value.processed_rows),
        snapshotHash:value.snapshot_hash as string|null,receiptHash:value.receipt_hash as string|null,error:value.error as string|null,
        search:profile.dimension<=2000?'hnsw-cosine':'exact-cosine'};
}

/** Все поля исходных строк входят в SHA; чтение страниц ограничено и не собирает тексты целиком в памяти. */
export async function generationSourceHash(db:Queryable,project:string,generation:string):Promise<{hash:string;rows:number;bytes:number}> {
    let last='',count=0,bytes=0;const hash=createHash('sha256');
    while(true){
        const page=await db.query(`SELECT ${columns} FROM rag_chunks WHERE project_key=$1 AND generation_id=$2 AND id>$3 ORDER BY id LIMIT 500`,[project,generation,last]);
        if(!page.rows.length)break;
        for(const raw of page.rows){const value=row(raw);hash.update(JSON.stringify([value.id,rowFingerprint(value)])+'\n');last=value.id;count++;bytes+=Buffer.byteLength(JSON.stringify(value));}
    }
    return {hash:hash.digest('hex'),rows:count,bytes};
}

/** Кандидаты содержат замороженные тексты. Единственный active pointer принадлежит каталогу. */
export class RagGenerations {
    constructor(private readonly pool:Pool){}
    async get(project:string,id:string,db:Queryable=this.pool):Promise<IRagGeneration>{
        if(!generationId(id))throw new BadRequestException('Некорректное поколение индекса.');
        const result=await db.query('SELECT * FROM rag_generations WHERE id=$1 AND project_key=$2',[id,project]);
        if(!result.rows[0])throw new NotFoundException('Поколение индекса не найдено.');return map(result.rows[0]);
    }
    async source(project:string,generation:string):Promise<{hash:string;rows:number;bytes:number}>{
        const client=await this.pool.connect();
        try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[RAG_WRITE_LOCK]);const source=await generationSourceHash(client,project,generation);await client.query('COMMIT');return source;}
        catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
    }
    async create(project:string,id:string,sourceGeneration:string,profile:unknown,expectedSource:string):Promise<IRagGeneration>{
        if(!generationId(id)||!generationId(sourceGeneration)||id===sourceGeneration)throw new BadRequestException('Нужны разные проверенные поколения индекса.');
        const target=normalizeIndexProfile(profile);if(!target||target.dimension>16000)throw new BadRequestException('Выберите профиль модели размерности до 16000.');
        const client=await this.pool.connect();
        let releaseCapacity=()=>{};
        try{
            await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[RAG_WRITE_LOCK]);
            const previous=await client.query('SELECT * FROM rag_generations WHERE id=$1 FOR UPDATE',[id]);
            if(previous.rows.length){
                const found=map(previous.rows[0]);
                if(found.projectId!==project||found.sourceGeneration!==sourceGeneration||found.sourceSnapshot!==expectedSource||JSON.stringify(found.profile)!==JSON.stringify(target))throw new ConflictException('План уже закреплён за другим снимком.');
                await client.query('COMMIT');return found;
            }
            const source=await generationSourceHash(client,project,sourceGeneration);
            if(source.hash!==expectedSource)throw new ConflictException('Исходный индекс изменился. Подготовьте новый план переиндексации.');
            releaseCapacity=await reserveCapacity({resource:'postgres',bytes:Math.max(16*1024**2,source.bytes*6)});
            await client.query(`INSERT INTO rag_generations(id,project_key,index_profile,state,source_generation,source_snapshot,source_rows)
                VALUES($1,$2,$3::jsonb,'building',$4,$5,$6)`,[id,project,JSON.stringify(target),sourceGeneration,source.hash,source.rows]);
            await client.query('INSERT INTO rag_index_state(project_key,generation_id,index_profile) VALUES($1,$2,$3::jsonb)',[project,id,JSON.stringify(target)]);
            await client.query(`INSERT INTO rag_chunks(id,project_key,generation_id,file_path,content,description,start_line,end_line,language,kind,role,quirk_type,tags,content_hash)
                SELECT id,project_key,$3,file_path,content,description,start_line,end_line,language,kind,role,quirk_type,tags,content_hash
                FROM rag_chunks WHERE project_key=$1 AND generation_id=$2`,[project,sourceGeneration,id]);
            await client.query('COMMIT');return this.get(project,id);
        }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw mapRagQuotaError(error);}finally{releaseCapacity();client.release();}
    }
    /** Переиспользует уже подтверждённые батчи после restart; блокировка и все записи остаются на одной сессии PostgreSQL. */
    async build(project:string,id:string,embed:(texts:string[],profile:IIndexProfile)=>Promise<number[][]>):Promise<IRagGeneration>{
        const owner=await this.pool.connect();let locked=false,discard=true;
        try{
            const lock=await owner.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',['rag-reindex:'+id]);
            locked=lock.rows[0].locked;discard=false;if(!locked)return await this.get(project,id,owner);
            while(true){
                const state=await this.get(project,id,owner);if(state.state!=='building')return state;
                const page=await owner.query(`SELECT ${columns} FROM rag_chunks WHERE project_key=$1 AND generation_id=$2 AND embedding IS NULL ORDER BY id LIMIT 32`,[project,id]);
                if(!page.rows.length)return await this.finish(project,id,owner);
                const rows=page.rows.map(row),vectors=await embed(rows.map(item=>item.content),state.profile);
                if(!Array.isArray(vectors)||vectors.length!==rows.length)throw new BadRequestException('Модель вернула неполный батч.');
                const values=rows.map((item,index)=>({...item,embedding:vectors[index]}));requireUsableVectors(values,state.profile.dimension);
                const releaseCapacity=await reserveCapacity({resource:'postgres',bytes:Math.max(16*1024**2,Buffer.byteLength(JSON.stringify(values))*6)});
                // The lock-owning session also writes: a disconnected worker cannot publish a late batch.
                const client=owner;
                try{
                    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[RAG_WRITE_LOCK]);
                    const current=await client.query('SELECT state FROM rag_generations WHERE id=$1 AND project_key=$2 FOR UPDATE',[id,project]);
                    if(current.rows[0]?.state!=='building'){await client.query('ROLLBACK');return await this.get(project,id,owner);}
                    const prepared=values.map(value=>({...value,syncHash:rowFingerprint(value)})),write=buildUpsert(project,id,prepared);await client.query(write.sql,write.params);
                    await client.query(`UPDATE rag_generations SET processed_rows=processed_rows+$2,updated_at=now() WHERE id=$1`,[id,values.length]);
                    await client.query('COMMIT');
                }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{releaseCapacity();}
            }
        }catch(error){
            // A lost owner cannot mark a replacement worker failed; preserve the original failure.
            if(locked)await owner.query("UPDATE rag_generations SET state='failed',error=$2,updated_at=now() WHERE id=$1 AND state='building'",[id,'Переиндексация прервана. Действующий индекс сохранён.']).catch(()=>{discard=true;});
            throw mapRagQuotaError(error);
        }finally{if(locked)await owner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['rag-reindex:'+id]).catch(()=>{discard=true;});owner.release(discard);}
    }
    private async finish(project:string,id:string,owner:PoolClient):Promise<IRagGeneration>{
        const candidate=await this.get(project,id,owner);
        if(candidate.state!=='building')return candidate;
        // Candidate is never a write target before promotion; concurrent build leaves active ingest unlocked.
        await ensureGenerationSearchIndex(owner,id,candidate.profile.dimension,true);
        const client=owner;
        try{
            await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[RAG_WRITE_LOCK]);
            const found=await client.query('SELECT * FROM rag_generations WHERE id=$1 AND project_key=$2 FOR UPDATE',[id,project]);const value=map(found.rows[0]);
            if(value.state!=='building'){
                if(value.state==='cancelled')await client.query(`DROP INDEX IF EXISTS rag_gen_${createHash('sha256').update(id).digest('hex').slice(0,24)}`);
                await client.query('COMMIT');return value;
            }
            const manifest=await readIndexManifest(client,project,id),snapshot=indexSnapshotHash(value.profile,manifest.fingerprints);
            await sealIndex(client,project,id,{indexProfile:value.profile,snapshot:{hash:snapshot,rowCount:value.rowCount,complete:true}});
            const receipt=createHash('sha256').update(JSON.stringify({id,project,profile:value.profile,sourceGeneration:value.sourceGeneration,sourceSnapshot:value.sourceSnapshot,rowCount:value.rowCount,snapshot})).digest('hex');
            await client.query("UPDATE rag_generations SET state='ready',snapshot_hash=$2,receipt_hash=$3,updated_at=now() WHERE id=$1",[id,snapshot,receipt]);
            await client.query('COMMIT');return await this.get(project,id,owner);
        }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
    }
    /** Неизвестный откат не оставляет удаление кандидата для COMMIT следующего запроса. */
    async cancel(project:string,id:string,tombstone:{profile:unknown;sourceGeneration:string;sourceSnapshot:string|null}):Promise<IRagGeneration>{
        if(!generationId(id)||!generationId(tombstone.sourceGeneration))throw new BadRequestException('Некорректное поколение отмены.');
        const profile=normalizeIndexProfile(tombstone.profile);if(!profile)throw new BadRequestException('Отмена требует профиль сохранённого плана.');
        const client=await this.pool.connect();let discard=false;
        try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[RAG_WRITE_LOCK]);
            await client.query(`INSERT INTO rag_generations(id,project_key,index_profile,state,source_generation,source_snapshot)
                VALUES($1,$2,$3::jsonb,'cancelled',$4,$5) ON CONFLICT(id) DO NOTHING`,[id,project,JSON.stringify(profile),tombstone.sourceGeneration,tombstone.sourceSnapshot]);
            const result=await client.query("UPDATE rag_generations SET state='cancelled',updated_at=now() WHERE id=$1 AND project_key=$2 AND state IN ('building','failed','ready') RETURNING *",[id,project]);
            if(result.rows.length){await client.query('DELETE FROM rag_chunks WHERE project_key=$1 AND generation_id=$2',[project,id]);}
            const index='rag_gen_'+createHash('sha256').update(id).digest('hex').slice(0,24);await client.query(`DROP INDEX IF EXISTS ${index}`);
            await client.query('COMMIT');return this.get(project,id);
        }catch(error){await client.query('ROLLBACK').catch(()=>{discard=true;});throw error;}finally{client.release(discard);}
    }
    async retry(project:string,id:string):Promise<IRagGeneration>{
        await this.pool.query("UPDATE rag_generations SET state='building',error=NULL,updated_at=now() WHERE id=$1 AND project_key=$2 AND state='failed'",[id,project]);return this.get(project,id);
    }
}
