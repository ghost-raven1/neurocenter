import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ConflictException } from '@nestjs/common';
import type { IOpenCodeModelCandidate } from '../../../shared/opencode-model-scan.cjs';
import { remoteModelBaseUrl } from './remote-model-validation';
import { remoteModelOptions } from './remote-model-options';
import {providerFence} from '../remote-providers/remote-provider.identity';
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
const digest=(value:unknown):string=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
type Db=Pick<PoolClient,'query'>;
const semantic=(candidate:IOpenCodeModelCandidate):string=>digest([candidate.provider,candidate.runtime,candidate.model,candidate.modelVersion,candidate.capability,remoteModelBaseUrl(candidate.baseUrl),remoteModelOptions(candidate.options)]);
/** Private credentials and transport timeout never change model identity. */
export const openCodeIdentity=(candidate:IOpenCodeModelCandidate):string=>'model-opencode-'+semantic(candidate).slice(0,40);
/** Every importer takes the same provider-before-model order as manual configuration and dispatch. */
async function protectedIdentity(db:Db,id:string):Promise<string>{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[providerFence(id)]);return id;
}

/** Reuse an earlier proven import once; a durable alias then preserves subsequent manual edits and historical IDs. */
export async function resolveOpenCodeIdentity(db:Db,candidate:IOpenCodeModelCandidate):Promise<string>{
    await db.query('SELECT pg_advisory_xact_lock_shared(72465381)');
    const identity=semantic(candidate);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:opencode-model-identity:'||$1,0))",[identity]);
    const mapped=(await db.query<{model_id:string}>('SELECT model_id FROM opencode_model_identities WHERE identity_sha=$1',[identity])).rows[0];
    if(mapped)return protectedIdentity(db,mapped.model_id);
    const oldId='model-opencode-'+digest([candidate.provider,candidate.runtime,candidate.model,candidate.modelVersion,remoteModelBaseUrl(candidate.baseUrl)]).slice(0,40);
    await protectedIdentity(db,oldId);
    const old=(await db.query<{id:string;descriptor:Record<string,unknown>}>('SELECT id,descriptor FROM model_catalog WHERE id=$1 AND archived_at IS NULL FOR UPDATE',[oldId])).rows[0];
    if(!old)return protectedIdentity(db,openCodeIdentity(candidate));
    const descriptor=old.descriptor;
    if(descriptor.source!=='custom'||descriptor.manifestSha256!==null||descriptor.dimension!==null||descriptor.runtime!==candidate.runtime||descriptor.model!==candidate.model||descriptor.modelVersion!==candidate.modelVersion||descriptor.capability!==candidate.capability)return protectedIdentity(db,openCodeIdentity(candidate));
    const proof=await db.query(`SELECT 1 FROM security_events WHERE action='model.import.opencode' AND resource_id=$1
        AND after_state->>'provider'=$2 AND after_state->>'model'=$3 AND after_state->>'runtime'=$4 LIMIT 1`,[oldId,candidate.provider,candidate.model,candidate.runtime]);
    if(!proof.rowCount||(await db.query('SELECT 1 FROM opencode_model_identities WHERE model_id=$1',[oldId])).rowCount)return protectedIdentity(db,openCodeIdentity(candidate));
    const head=(await db.query<{base_url:string;options:unknown;revoked_at:unknown}>('SELECT base_url,options,revoked_at FROM model_remote_connections WHERE model_id=$1 ORDER BY revision DESC LIMIT 1',[oldId])).rows[0];
    if(!head||head.revoked_at||remoteModelBaseUrl(head.base_url)!==remoteModelBaseUrl(candidate.baseUrl)||digest(remoteModelOptions(head.options))!==digest(remoteModelOptions(candidate.options)))return protectedIdentity(db,openCodeIdentity(candidate));
    await saveOpenCodeIdentity(db,candidate,oldId);return oldId;
}
/** Called in the same transaction as card creation; the FK prevents dangling identity aliases. */
export async function saveOpenCodeIdentity(db:Db,candidate:IOpenCodeModelCandidate,id:string):Promise<void>{
    const identity=semantic(candidate);
    await db.query('INSERT INTO opencode_model_identities(identity_sha,model_id) VALUES($1,$2) ON CONFLICT(identity_sha) DO NOTHING',[identity,id]);
    if((await db.query<{model_id:string}>('SELECT model_id FROM opencode_model_identities WHERE identity_sha=$1',[identity])).rows[0]?.model_id!==id)throw new ConflictException('Идентичность модели изменилась во время импорта. Обновите каталог.');
}
