import {ConflictException} from '@nestjs/common';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {verifyPackage,type IPackage} from '../catalog/bundle-package';
import {assertProjectEmbeddingModel,projectEmbeddingPin} from '../models/project-embedding.validation';
import type {IConfiguredProjectEmbedding,IDeviceEmbeddingContext} from '../models/project-embedding.types';
import type {Device} from './device-store';
import type {Job} from './device-job.model';

export interface IHostedInstallationIdentity {kind:'mcp'|'plugin';id:string;version:number;manifest:string}
export interface IHostedRagGrant {id:string;device_id:string;project_id:string;email:string;role:string;binding_id:string;instance_id:string;asset_kind:string;asset_id:string;version:number;manifest:string;selection_revision:number|string;model_id:string;model_pin:string;payload:Record<string,unknown>;model_assignment_epoch:string;revoked_at:Date|null;job_id:string}
type Db=Pick<PoolClient,'query'>;
const invalid=()=>new ConflictException('Подключение RAG не разрешено или изменилось. Подключите модель заново из установленного OpenCodeRAG.');

/** Проверенный job — источник разрешения; произвольный device/context не создаёт grants. */
export function hostedGrantPayload(payload:Record<string,unknown>,projectId:string){
    const pkg=payload.package as IPackage|undefined,selection=payload.embedding as IConfiguredProjectEmbedding|undefined;
    try{
        if(!pkg||!verifyPackage(pkg)||!['mcp','plugin'].includes(pkg.plugin.kind)||!selection||selection.projectId!==projectId
            ||!Number.isSafeInteger(selection.revision)||selection.revision<1||!selection.model||projectEmbeddingPin(selection.model)!==selection.modelPin
            ||!/^[a-f0-9]{64}$/.test(String(payload.bindingId))||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(String(payload.instanceId))
            ||payload.assetId!==pkg.plugin.id||payload.assetKind!==pkg.plugin.kind||payload.version!==pkg.plugin.version
            ||selection.profile?.provider!=='openai'||selection.profile.model!==`neurocenter/${selection.model.id}/sha256/${selection.modelPin}`||selection.profile.dimension!==selection.expectedDimension)throw invalid();
        assertProjectEmbeddingModel(selection.model,selection.expectedDimension);
    }catch{throw invalid();}
    return {pkg:pkg!,selection:selection!};
}

/** До локального commit сохраняется кандидат; прежний grant нужен для честного rollback. */
export async function registerHostedRagGrant(pool:Pool,device:Device,expected:Job,lease:string,validate:()=>Promise<void>):Promise<void>{
    if(expected.kind!=='connect-rag-model'||!expected.project_id)return;
    const client=await pool.connect();
    try{
        await client.query('BEGIN');
        const found=await client.query<Job>("SELECT * FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND lease=$3 AND state='running' AND lease_until>now() FOR UPDATE",[expected.id,device.id,lease]);
        const job=found.rows[0];if(!job||job.email!==device.email||job.role!==device.role||!isDeepStrictEqual(job.payload,expected.payload))throw invalid();
        const live=(await client.query<Device>('SELECT * FROM bridge_devices WHERE id=$1 AND email=$2 AND NOT revoked AND expires_at>now() FOR SHARE',[device.id,device.email])).rows[0];
        if(!live||live.role!==device.role)throw invalid();
        const binding=(live.report.bindings as Array<{projectId:string;bindingId:string;instanceId:string;valid:boolean}>|undefined)?.find(value=>value.projectId===job.project_id);
        if(binding?.valid!==true||binding.bindingId!==job.payload.bindingId||binding.instanceId!==job.payload.instanceId)throw invalid();
        const {selection}=hostedGrantPayload(job.payload,job.project_id!);
        const current=await client.query('SELECT 1 FROM project_embedding_settings WHERE project_id=$1 AND revision=$2 AND model_pin=$3 AND model_id=$4 FOR SHARE',[job.project_id,selection.revision,selection.modelPin,selection.model.id]);
        if(!current.rows.length)throw invalid();
        const account=(await client.query<{enabled:boolean;is_main_admin:boolean}>('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',[device.email])).rows[0];
        const members=await client.query<{role:string}>('SELECT role FROM project_members WHERE project_id=$1 AND lower(principal_name)=lower($2) FOR SHARE',[job.project_id,device.email]);
        if(!account?.enabled||(device.role==='Главный админ'?!account.is_main_admin:!members.rows.some(row=>row.role===device.role)))throw invalid();
        const root=job.payload.approvalRoot as {kind:string;id:string;version:number}|undefined;
        if(!root)throw invalid();
        await client.query('SELECT id FROM device_install_plans WHERE id=$1 FOR SHARE',[job.payload.planId]);
        await client.query('SELECT asset_id FROM project_assets WHERE project_id=$1 AND asset_kind=$2 AND asset_id=$3 FOR SHARE',[job.project_id,root.kind,root.id]);
        await validate();
        await insertHostedRagGrant(client,job);
        await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
}

export async function insertHostedRagGrant(db:Db,job:Pick<Job,'id'|'device_id'|'project_id'|'email'|'role'|'payload'>):Promise<void>{
    const {pkg,selection}=hostedGrantPayload(job.payload,job.project_id!);
    const assignment=(await db.query<{assignment_epoch:string}>('SELECT assignment_epoch FROM project_models WHERE project_id=$1 AND model_id=$2 FOR SHARE',[job.project_id,selection.model.id])).rows[0];
    if(!assignment)throw invalid();
    const inserted=await db.query(`INSERT INTO bridge_hosted_rag_grants(id,device_id,project_id,email,role,binding_id,instance_id,asset_kind,asset_id,version,manifest,selection_revision,model_id,model_pin,model_assignment_epoch,payload,job_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17) ON CONFLICT(job_id) DO UPDATE SET job_id=EXCLUDED.job_id WHERE bridge_hosted_rag_grants.revoked_at IS NULL RETURNING id`,
    [randomUUID(),job.device_id,job.project_id,job.email,job.role,job.payload.bindingId,job.payload.instanceId,pkg.plugin.kind,pkg.plugin.id,pkg.plugin.version,pkg.manifest.sha256,selection.revision,selection.model.id,selection.modelPin,assignment.assignment_epoch,JSON.stringify(job.payload),job.id]);
    if(!inserted.rows.length)throw invalid();
}

/** Только подтверждённый успех заменяет старый grant той же установки; failed/timeout сохраняет исходный индекс. */
export async function completeHostedRagGrant(db:Db,jobId:string):Promise<void>{
    if(!(await db.query('SELECT 1 FROM bridge_hosted_rag_grants WHERE job_id=$1',[jobId])).rows.length)throw new ConflictException('Подключение не было авторизовано до локального изменения. Проверьте состояние на компьютере и создайте новый intent.');
    await db.query(`UPDATE bridge_hosted_rag_grants old SET revoked_at=now() FROM bridge_hosted_rag_grants fresh
        WHERE fresh.job_id=$1 AND fresh.revoked_at IS NULL AND old.id<>fresh.id AND old.revoked_at IS NULL
        AND old.device_id=fresh.device_id AND old.project_id=fresh.project_id AND old.binding_id=fresh.binding_id AND old.instance_id=fresh.instance_id
        AND old.asset_kind=fresh.asset_kind AND old.asset_id=fresh.asset_id AND old.version=fresh.version AND old.manifest=fresh.manifest
        AND old.authorization_order<fresh.authorization_order`,[jobId]);
}

/** Поиск использует только таблицу разрешений, никогда не ищет подходящий job во время inference. */
export async function readHostedRagGrant(db:Db,device:Device,input:IDeviceEmbeddingContext):Promise<IHostedRagGrant>{
    const install=input.installation;if(!install||!input.expectedRevision||!input.expectedModelPin)throw invalid();
    const result=await db.query<IHostedRagGrant>(`SELECT g.* FROM bridge_hosted_rag_grants g JOIN project_models pm
        ON pm.project_id=g.project_id AND pm.model_id=g.model_id AND pm.assignment_epoch=g.model_assignment_epoch
        JOIN project_embedding_settings e ON e.project_id=g.project_id AND e.model_id IS NOT NULL
        WHERE g.device_id=$1 AND g.project_id=$2 AND g.email=$3 AND g.role=$4 AND g.binding_id=$5 AND g.instance_id=$6
        AND g.asset_kind=$7 AND g.asset_id=$8 AND g.version=$9 AND g.manifest=$10 AND g.selection_revision=$11 AND g.model_pin=$12
        AND g.revoked_at IS NULL ORDER BY g.authorization_order DESC LIMIT 1`,
    [device.id,input.projectId,device.email,device.role,input.bindingId,input.instanceId,install.kind,install.id,install.version,install.manifest,input.expectedRevision,input.expectedModelPin]);
    if(!result.rows[0])throw invalid();return result.rows[0];
}
