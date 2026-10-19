import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { FINGERPRINT_VERSION, indexSnapshotHash, normalizeIndexProfile, type IIndexProfile } from '../../../shared/rag-index-contract.cjs';

export interface IRagIndexSnapshot {hash:string;rowCount:number;complete:boolean;}
export interface IRagIndexWrite {indexProfile:IIndexProfile|null;snapshot?:IRagIndexSnapshot;}
export interface IRagIndexSummary {
    rowCount:number;lastSyncedAt:string|null;dimension:number;usableVectorCount:number;incompleteRows:number;
    fingerprintVersion:1;indexProfile:IIndexProfile|null;indexState:'unverified'|'syncing'|'ready';complete:boolean;snapshotHash:string|null;
}
export interface IRagIndexManifest extends IRagIndexSummary {ids:Record<string,string>;fingerprints:Record<string,string>;}
type Queryable=Pick<Pool,'query'>|Pick<PoolClient,'query'>;

/** Миграция добавляет nullable hash: старые строки не объявляются проверенными задним числом. */
export const RAG_INDEX_SCHEMA=`
ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS sync_hash TEXT;
CREATE TABLE IF NOT EXISTS rag_index_state (
    project_key TEXT PRIMARY KEY,index_profile JSONB,
    complete BOOLEAN NOT NULL DEFAULT false,snapshot_hash TEXT,snapshot_rows BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

/** Профиль и seal проверяются до открытия транзакции и любых удалений. */
export function validateIndexWrite(profile:unknown,snapshot:unknown,dimension:number):IRagIndexWrite {
    let indexProfile:IIndexProfile|null;
    try {indexProfile=normalizeIndexProfile(profile);} catch(error) {throw new BadRequestException((error as Error).message);}
    if(indexProfile&&indexProfile.dimension!==dimension){throw new ConflictException(`Размерность локальной модели ${indexProfile.dimension} не совпадает с серверной ${dimension}. Выберите совместимую модель и перестройте индекс.`);}
    if(snapshot===undefined){
        if(indexProfile){throw new BadRequestException('Для проверяемого индекса передайте snapshot с hash, rowCount и complete.');}
        return {indexProfile};
    }
    if(!indexProfile||!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)){throw new BadRequestException('Снимку нужен профиль модели и объект snapshot.');}
    const value=snapshot as Record<string,unknown>;
    if(Object.keys(value).sort().join(',')!=='complete,hash,rowCount'||typeof value.hash!=='string'||!/^[a-f0-9]{64}$/.test(value.hash)
        ||!Number.isSafeInteger(value.rowCount)||(value.rowCount as number)<0||typeof value.complete!=='boolean'){
        throw new BadRequestException('Некорректный snapshot: нужны SHA-256 hash, целый rowCount и complete.');
    }
    return {indexProfile,snapshot:value as unknown as IRagIndexSnapshot};
}

/** Нулевые и отсутствующие векторы не подтверждают работоспособность поиска. */
export function requireUsableVectors(rows:Array<{embedding:number[]|null}>,dimension:number):void {
    if(rows.some(row=>!Array.isArray(row.embedding)||row.embedding.length!==dimension
        ||row.embedding.some(value=>typeof value!=='number'||!Number.isFinite(Math.fround(value)))
        ||!row.embedding.some(value=>Math.fround(value)!==0))){
        throw new BadRequestException(`Проверяемому индексу нужны непустые ненулевые векторы размерности ${dimension}. Повторите индексирование.`);
    }
}

interface IStatusRow {
    row_count:number;last_synced_at:string|null;usable:number;incomplete:number;index_profile:unknown;
    complete:boolean|null;snapshot_hash:string|null;snapshot_rows:number|string|null;ids?:Record<string,string>;fingerprints?:Record<string,string>;
}
const usable='embedding IS NOT NULL AND vector_norm(embedding)>0';

/** Данные и метаданные читаются одним SQL statement: summary не склеивает разные состояния. */
async function readStatus(db:Queryable,projectKey:string,dimension:number,manifest:boolean):Promise<IRagIndexManifest> {
    const hashes=manifest?`,COALESCE(jsonb_object_agg(id,content_hash),'{}'::jsonb) AS ids,
        COALESCE(jsonb_object_agg(id,sync_hash) FILTER(WHERE sync_hash IS NOT NULL),'{}'::jsonb) AS fingerprints`:'';
    const {rows}=await db.query(`WITH stats AS (
        SELECT count(*)::int AS row_count,max(updated_at) AS last_synced_at,
        count(*) FILTER(WHERE ${usable})::int AS usable,
        count(*) FILTER(WHERE sync_hash IS NULL OR NOT (${usable}))::int AS incomplete${hashes}
        FROM rag_chunks WHERE project_key=$1
    ) SELECT stats.*,state.index_profile,state.complete,state.snapshot_hash,state.snapshot_rows
      FROM stats LEFT JOIN rag_index_state state ON state.project_key=$1`,[projectKey]);
    const row=rows[0] as IStatusRow;
    const indexProfile=normalizeIndexProfile(row.index_profile);
    const complete=!!(row.complete&&indexProfile&&row.snapshot_hash&&row.row_count>0&&row.incomplete===0&&row.usable===row.row_count&&Number(row.snapshot_rows)===row.row_count);
    return {rowCount:row.row_count,lastSyncedAt:row.last_synced_at,dimension:indexProfile?.dimension??dimension,
        usableVectorCount:row.usable,incompleteRows:row.incomplete,fingerprintVersion:FINGERPRINT_VERSION,indexProfile,
        indexState:complete?'ready':indexProfile?'syncing':'unverified',complete,snapshotHash:complete?row.snapshot_hash:null,
        ids:row.ids??{},fingerprints:row.fingerprints??{}};
}
export function readIndexManifest(db:Queryable,projectKey:string,dimension:number):Promise<IRagIndexManifest>{return readStatus(db,projectKey,dimension,true);}
export async function readIndexSummary(db:Queryable,projectKey:string,dimension:number):Promise<IRagIndexSummary>{
    const {ids:_ids,fingerprints:_fingerprints,...summary}=await readStatus(db,projectKey,dimension,false);return summary;
}

/** Вызывается только под общим RAG_WRITE_LOCK, до изменения строк или состояния. */
export async function bindIndexProfile(db:Queryable,projectKey:string,write:IRagIndexWrite,upsertCount=0):Promise<void>{
    const profile=write.indexProfile;
    const {rows}=await db.query('SELECT index_profile FROM rag_index_state WHERE project_key=$1 FOR UPDATE',[projectKey]);
    const bound=normalizeIndexProfile(rows[0]?.index_profile);
    if(bound&&!profile){throw new ConflictException('Обновите мост: этот индекс уже привязан к проверенному профилю модели. Старая синхронизация без indexProfile запрещена.');}
    const different=!!bound&&JSON.stringify(bound)!==JSON.stringify(profile);
    if(different){
        const firstRows=upsertCount>0&&write.snapshot&&write.snapshot.rowCount>0&&!write.snapshot.complete;
        const empty=firstRows?await db.query('SELECT EXISTS(SELECT 1 FROM rag_chunks WHERE project_key=$1) AS has_rows',[projectKey]):null;
        if(empty?.rows[0]?.has_rows!==false){throw new ConflictException('Индекс привязан к другой модели, провайдеру или размерности. Изменение модели требует отдельной согласованной перестройки индекса.');}
    }
    if(profile&&(!bound||different)){
        await db.query(`INSERT INTO rag_index_state(project_key,index_profile) VALUES($1,$2::jsonb)
            ON CONFLICT(project_key) DO UPDATE SET index_profile=EXCLUDED.index_profile,
            complete=false,snapshot_hash=NULL,snapshot_rows=NULL,updated_at=now()`,[projectKey,JSON.stringify(profile)]);
    }
}

/** Любая дельта снимает готовность, даже если все уже полученные строки имеют hash. */
export async function invalidateIndexSeal(db:Queryable,projectKey:string):Promise<void>{
    await db.query(`INSERT INTO rag_index_state(project_key,complete) VALUES($1,false)
        ON CONFLICT(project_key) DO UPDATE SET complete=false,snapshot_hash=NULL,snapshot_rows=NULL,updated_at=now()`,[projectKey]);
}

/** Финальный короткий seal подтверждает весь снимок, а не только последнюю порцию. */
export async function sealIndex(db:Queryable,projectKey:string,dimension:number,write:IRagIndexWrite):Promise<void>{
    const state=await readIndexManifest(db,projectKey,dimension);
    const snapshot=write.snapshot!;
    if(!write.indexProfile||state.rowCount<1||state.rowCount!==snapshot.rowCount||state.incompleteRows!==0
        ||state.usableVectorCount!==state.rowCount||Object.keys(state.fingerprints).length!==state.rowCount
        ||indexSnapshotHash(write.indexProfile,state.fingerprints)!==snapshot.hash){
        throw new ConflictException('Снимок индекса ещё не получен полностью или изменился параллельно. Повторите синхронизацию до подтверждения всего снимка.');
    }
    await db.query(`UPDATE rag_index_state SET complete=true,snapshot_hash=$2,snapshot_rows=$3,updated_at=now() WHERE project_key=$1`,[projectKey,snapshot.hash,snapshot.rowCount]);
}
