import {BadRequestException,ConflictException,ServiceUnavailableException} from '@nestjs/common';
import type {Pool,PoolClient} from 'pg';
import type {IRagQuotaPolicy} from './rag-quota';
import {RAG_WRITE_LOCK} from './rag-quota-schema';

export interface IPlatformQuotaPolicy extends IRagQuotaPolicy {revision:number;updatedAt:string;updatedBy:string;}
export interface IPlatformQuotaUpdate extends IRagQuotaPolicy {expectedRevision:number;}
const safe=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;

/** Bytes are exact safe integers; a request cannot turn the guard off with zero or a hidden field. */
export function validatePlatformQuotaUpdate(value:unknown):asserts value is IPlatformQuotaUpdate {
    const input=value as Partial<IPlatformQuotaUpdate>|null;
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='defaultBytes,expectedRevision,maximumBytes'
        ||!safe(input.defaultBytes)||!safe(input.maximumBytes)||input.defaultBytes>input.maximumBytes
        ||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<0) {
        throw new BadRequestException('Укажите положительные целые лимиты, максимум не меньше начального лимита и актуальную ревизию.');
    }
}

function view(row:Record<string,unknown>|undefined):IPlatformQuotaPolicy {
    const defaultBytes=Number(row?.default_bytes),maximumBytes=Number(row?.maximum_bytes),revision=Number(row?.revision);
    const updatedAt=row?.updated_at instanceof Date?row.updated_at.toISOString():row?.updated_at,updatedBy=row?.updated_by;
    if(!safe(defaultBytes)||!safe(maximumBytes)||defaultBytes>maximumBytes||!Number.isSafeInteger(revision)||revision<0
        ||typeof updatedAt!=='string'||!Number.isFinite(Date.parse(updatedAt))||typeof updatedBy!=='string') {
        throw new ServiceUnavailableException('Не удалось подтвердить настройки квот.');
    }
    return {defaultBytes,maximumBytes,revision,updatedAt,updatedBy};
}

/** Seed once from the existing base settings; later environment changes cannot reset an admin's policy. */
export async function seedPlatformQuotaPolicy(pool:Pool):Promise<void> {
    await pool.query(`INSERT INTO rag_platform_quota_policy(singleton,default_bytes,maximum_bytes,updated_by)
        SELECT true,default_bytes,maximum_bytes,'system:initial-configuration' FROM rag_storage_settings WHERE singleton
        ON CONFLICT(singleton) DO NOTHING`);
}

async function read(db:Pick<PoolClient,'query'>,lock=false):Promise<IPlatformQuotaPolicy> {
    return view((await db.query(`SELECT * FROM rag_platform_quota_policy WHERE singleton${lock?' FOR UPDATE':''}`)).rows[0]);
}

/** CAS and audit share one transaction; lowering the maximum never edits existing project budgets. */
export async function platformQuotaPolicy(pool:Pool,update?:IPlatformQuotaUpdate,actor?:string):Promise<IPlatformQuotaPolicy> {
    if(!update)return read(pool);
    validatePlatformQuotaUpdate(update);
    if(typeof actor!=='string'||!actor.trim()||actor.length>254)throw new BadRequestException('Не подтверждён автор изменения настроек.');
    const db=await pool.connect();let discard=false;
    try {
        await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='10s'");
        const before=await read(db,true);
        if(before.defaultBytes===update.defaultBytes&&before.maximumBytes===update.maximumBytes){await db.query('COMMIT');return before;}
        if(before.revision!==update.expectedRevision)throw new ConflictException('Настройки квот уже изменены. Обновите сведения и проверьте черновик.');
        const after=view((await db.query(`UPDATE rag_platform_quota_policy SET default_bytes=$1,maximum_bytes=$2,
            revision=revision+1,updated_at=now(),updated_by=$3 WHERE singleton RETURNING *`,[update.defaultBytes,update.maximumBytes,actor])).rows[0]);
        await db.query('INSERT INTO rag_platform_quota_events(actor,before_policy,after_policy) VALUES($1,$2,$3)',[actor,JSON.stringify(before),JSON.stringify(after)]);
        await db.query('COMMIT');return after;
    }catch(error){await db.query('ROLLBACK').catch(()=>{discard=true;});throw error;}finally{db.release(discard);}
}

/** Refresh only defaults/cap under the existing write lock; established budgets are never rewritten. */
export async function applyPlatformQuotaPolicy(pool:Pool,input:IPlatformQuotaPolicy|(()=>Promise<IPlatformQuotaPolicy>)):Promise<void> {
    const db=await pool.connect();let discard=false;
    try {
        await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='10s'");
        await db.query('SELECT pg_advisory_xact_lock($1)',[RAG_WRITE_LOCK]);
        const policy=typeof input==='function'?await input():input;
        if(!safe(policy.defaultBytes)||!safe(policy.maximumBytes)||policy.defaultBytes>policy.maximumBytes||!Number.isSafeInteger(policy.revision)||policy.revision<0)throw new ServiceUnavailableException('Настройки квот требуют проверки.');
        const before=(await db.query('SELECT * FROM rag_platform_quota_applied WHERE singleton FOR UPDATE')).rows[0];
        if(before&&Number(before.revision)>policy.revision){await db.query('COMMIT');return;}
        if(before&&Number(before.revision)===policy.revision&&(Number(before.default_bytes)!==policy.defaultBytes||Number(before.maximum_bytes)!==policy.maximumBytes))throw new ServiceUnavailableException('Ревизия настроек квот противоречит сохранённой политике.');
        await db.query(`INSERT INTO rag_platform_quota_applied(singleton,revision,default_bytes,maximum_bytes) VALUES(true,$1,$2,$3)
            ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision,default_bytes=EXCLUDED.default_bytes,maximum_bytes=EXCLUDED.maximum_bytes`,[policy.revision,policy.defaultBytes,policy.maximumBytes]);
        await db.query(`UPDATE rag_storage_settings SET default_bytes=$1,maximum_bytes=$2 WHERE singleton
            AND (default_bytes IS DISTINCT FROM $1 OR maximum_bytes IS DISTINCT FROM $2)`,[policy.defaultBytes,policy.maximumBytes]);
        await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK').catch(()=>{discard=true;});throw error;}finally{db.release(discard);}
}
