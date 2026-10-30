import {ConflictException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {normalizeEmail} from '../access/access.model';

/** A successor may recover one original import key, never admit it again under another owner. */
export async function fenceRebuildInlineAdmission(client:PoolClient,actor:string,key:string,assertCurrent:()=>void):Promise<void>{
    assertCurrent();
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['catalog-rebuild-import:'+key]);
    assertCurrent();
    const owners=(await client.query<{actor:string}>('SELECT actor FROM asset_source_jobs WHERE request_key=$1',[key])).rows;
    if(owners.some(row=>normalizeEmail(row.actor)!==actor))throw new ConflictException('Владелец принятого импорта изменился. Начните новую пересборку.');
    assertCurrent();
}
