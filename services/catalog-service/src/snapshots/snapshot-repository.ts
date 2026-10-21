import {BadRequestException,ConflictException,NotFoundException} from '@nestjs/common';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {IAccessActor} from '../access/access.model';
import {securityEvent} from '../access/security-events';
import {snapshotProject} from './snapshot-auth';
import {normalizeSnapshotManifest,snapshotManifestHash,snapshotCanonicalJson,type SnapshotManifest} from '../../../shared/project-snapshot.cjs';
import type {SnapshotCreate,SnapshotHead,SnapshotRow,SnapshotSignature,SnapshotView} from './snapshot-types';

export const snapshotUuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const snapshotHash=(value:unknown):string=>createHash('sha256').update(snapshotCanonicalJson(value)).digest('hex');
export function snapshotInput(value:unknown,keys:string[]):asserts value is Record<string,unknown>{
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new BadRequestException('Некорректные параметры снимка.');
}
export function snapshotExpectedHead(value:SnapshotHead):void{
    if(value.expectedHeadId!==null&&!snapshotUuid(value.expectedHeadId)||!Number.isSafeInteger(value.expectedHeadRevision)||value.expectedHeadRevision<0)throw new BadRequestException('Передайте текущий head и его ревизию.');
}
export function assertSnapshotHead(project:Record<string,unknown>,expected:SnapshotHead):void{
    snapshotExpectedHead(expected);
    if((project.head_snapshot_id??null)!==expected.expectedHeadId||Number(project.head_revision)!==expected.expectedHeadRevision)throw new ConflictException('Текущую версию проекта уже изменили. Обновите список и подтвердите действие заново.');
}
export function snapshotCreateInput(input:SnapshotCreate):void{
    snapshotInput(input,['requestKey','deviceId','expectedBindingId','expectedHeadId','expectedHeadRevision']);
    if(!snapshotUuid(input.requestKey)||!snapshotUuid(input.deviceId)||!/^[a-f0-9]{64}$/.test(input.expectedBindingId))throw new BadRequestException('Выберите компьютер и актуальную привязку папки.');
    snapshotExpectedHead(input);
}

/** Metadata commands, actor grants, CAS, idempotency receipts and audit share one PG transaction. */
export class SnapshotRepository {
    constructor(readonly pool:Pool){}
    async transaction<T>(projectId:string,actor:IAccessActor,minimum:number,run:(client:PoolClient,project:Record<string,unknown>)=>Promise<T>):Promise<T>{
        const client=await this.pool.connect();
        try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('neurocenter:snapshot-signing-identity',0))");const project=await snapshotProject(client,projectId,actor,minimum);const result=await run(client,project);await client.query('COMMIT');return result;}
        catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
    }
    async command<T>(projectId:string,actor:IAccessActor,key:string,kind:string,input:unknown,run:(client:PoolClient,project:Record<string,unknown>)=>Promise<T>):Promise<T>{
        if(!snapshotUuid(key))throw new BadRequestException('Нужен сохранённый UUID действия.');
        const hash=snapshotHash({projectId,kind,input});
        return this.transaction(projectId,actor,3,async(client,project)=>{
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['snapshot-command:'+actor.email+':'+key]);
            if((await client.query('SELECT 1 FROM project_snapshot_cancelled_commands WHERE email=$1 AND request_key=$2',[actor.email,key])).rowCount)throw new ConflictException('Действие отменено. Для нового действия нужен новый UUID.');
            const previous=(await client.query('SELECT request_hash,result FROM project_snapshot_commands WHERE email=$1 AND request_key=$2',[actor.email,key])).rows[0];
            if(previous){if(previous.request_hash!==hash)throw new ConflictException('UUID уже использован для другого действия.');return previous.result as T;}
            const result=await run(client,project);
            await client.query('INSERT INTO project_snapshot_commands(project_id,email,request_key,request_hash,result) VALUES($1,$2,$3,$4,$5)',[projectId,actor.email,key,hash,JSON.stringify(result)]);
            return result;
        });
    }
    /** Resolve a lost response without executing the command again. */
    async lookupCommand(projectId:string,actor:IAccessActor,key:string):Promise<{result:unknown}|null>{
        if(!snapshotUuid(key))throw new BadRequestException('Нужен UUID сохранённого действия.');
        return this.transaction(projectId,actor,3,async client=>{
            const row=(await client.query('SELECT project_id,result FROM project_snapshot_commands WHERE email=$1 AND request_key=$2',[actor.email,key])).rows[0];
            if(row&&row.project_id!==projectId)throw new ConflictException('UUID относится к другому проекту.');
            return row?{result:row.result}:null;
        });
    }
    /** Lock ordering matches command(): a late POST cannot cross this durable cancellation fence. */
    async cancelCommand(projectId:string,actor:IAccessActor,key:string):Promise<{cancelled:true;requestKey:string}>{
        if(!snapshotUuid(key))throw new BadRequestException('Нужен UUID сохранённого действия.');
        return this.transaction(projectId,actor,3,async client=>{
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['snapshot-command:'+actor.email+':'+key]);
            if((await client.query('SELECT 1 FROM project_snapshot_commands WHERE email=$1 AND request_key=$2',[actor.email,key])).rowCount)throw new ConflictException('Действие уже выполнено. Восстановите его результат.');
            const previous=(await client.query('SELECT project_id FROM project_snapshot_cancelled_commands WHERE email=$1 AND request_key=$2',[actor.email,key])).rows[0];
            if(previous&&previous.project_id!==projectId)throw new ConflictException('UUID относится к другому проекту.');
            await client.query('INSERT INTO project_snapshot_cancelled_commands(email,request_key,project_id) VALUES($1,$2,$3) ON CONFLICT(email,request_key) DO NOTHING',[actor.email,key,projectId]);
            if(!previous)await securityEvent(client,{actor:actor.email,action:'snapshot.command.cancel',resourceId:key,before:null,after:{projectId,cancelled:true}});
            return {cancelled:true,requestKey:key};
        });
    }
    async row(client:PoolClient,project:string,id:string,lock=false):Promise<SnapshotRow>{
        if(!snapshotUuid(id))throw new NotFoundException('Снимок не найден.');
        const row=(await client.query<SnapshotRow>('SELECT * FROM project_snapshots WHERE project_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[project,id])).rows[0];
        if(!row)throw new NotFoundException('Снимок не найден.');return row;
    }
    async create(projectId:string,actor:IAccessActor,input:SnapshotCreate):Promise<SnapshotRow>{
        snapshotCreateInput(input);const hash=snapshotHash({projectId,input});
        return this.transaction(projectId,actor,3,async(client,project)=>{
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['snapshot-create:'+actor.email+':'+input.requestKey]);
            const cancelled=await client.query('SELECT 1 FROM project_snapshot_cancelled_requests WHERE email=$1 AND request_key=$2',[actor.email,input.requestKey]);
            if(cancelled.rowCount)throw new ConflictException('Этот запрос публикации отменён. Для нового снимка нужен новый UUID.');
            const previous=(await client.query<SnapshotRow&{request_hash:string}>('SELECT * FROM project_snapshots WHERE email=$1 AND request_key=$2',[actor.email,input.requestKey])).rows[0];
            if(previous){if(previous.request_hash!==hash)throw new ConflictException('Ключ публикации уже использован для другой папки или проекта.');return previous;}
            assertSnapshotHead(project,input);
            const pending=Number((await client.query("SELECT count(*) FROM project_snapshots WHERE project_id=$1 AND status IN ('UPLOADING','VERIFYING')",[projectId])).rows[0].count);
            if(pending>=2)throw new ConflictException('Для проекта уже готовятся два снимка. Дождитесь завершения или отмените публикацию.');
            const count=Number((await client.query("SELECT count(*) FROM project_snapshots WHERE project_id=$1 AND status<>'DELETED'",[projectId])).rows[0].count);
            if(count>=Math.min(100,Number(project.retention)))throw new ConflictException('Достигнут лимит сохранённых снимков проекта. Удалите ненужный незакреплённый снимок или измените retention.');
            const row=(await client.query<SnapshotRow>(`INSERT INTO project_snapshots(id,project_id,request_key,request_hash,email,role,device_id,binding_id,parent_id,
                expected_head_id,expected_head_revision,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::text::uuid,$9::text,$10,'UPLOADING') RETURNING *`,
            [randomUUID(),projectId,input.requestKey,hash,actor.email,actor.activeRole,input.deviceId,input.expectedBindingId,input.expectedHeadId,input.expectedHeadRevision])).rows[0];
            await securityEvent(client,{actor:actor.email,action:'snapshot.create',resourceId:row.id,before:null,after:{projectId,status:row.status,deviceId:row.device_id}});return row;
        });
    }
    async list(projectId:string,actor:IAccessActor):Promise<SnapshotView[]>{
        return this.transaction(projectId,actor,1,async(client,project)=>{
            const rows=(await client.query<SnapshotRow&{pinned:boolean}>(`SELECT s.*,EXISTS(SELECT 1 FROM project_snapshot_profiles p WHERE p.snapshot_id=s.id) AS pinned
                FROM project_snapshots s WHERE project_id=$1 ORDER BY created_at DESC LIMIT 200`,[projectId])).rows;
            return rows.map(row=>({snapshotId:row.id,storeId:projectId,parentId:row.parent_id,status:row.status,author:row.email,createdAt:row.created_at.toISOString(),bytes:Number(row.total_bytes),
                formatVersion:'neurocenter.lancedb-snapshot/v1',isHead:project.head_snapshot_id===row.id,pinned:row.pinned,manifestSha256:row.manifest_sha256,error:row.error,jobId:row.job_id}));
        });
    }
    async lookup(projectId:string,actor:IAccessActor,key:string):Promise<SnapshotView|null>{
        if(!snapshotUuid(key))throw new BadRequestException('Нужен UUID сохранённого запроса.');
        const id=await this.transaction(projectId,actor,3,async client=>(await client.query<{id:string}>('SELECT id FROM project_snapshots WHERE project_id=$1 AND email=$2 AND request_key=$3',[projectId,actor.email,key])).rows[0]?.id);
        return id?(await this.list(projectId,actor)).find(row=>row.snapshotId===id)??null:null;
    }
    /** A negative lookup is not a cancellation: this durable tombstone also blocks a delayed first POST. */
    async cancelRequest(projectId:string,actor:IAccessActor,input:SnapshotCreate):Promise<{cancelled:true;requestKey:string}>{
        snapshotCreateInput(input);const hash=snapshotHash({projectId,input});
        return this.transaction(projectId,actor,3,async client=>{
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['snapshot-create:'+actor.email+':'+input.requestKey]);
            const previous=(await client.query<SnapshotRow&{request_hash:string}>('SELECT * FROM project_snapshots WHERE email=$1 AND request_key=$2 FOR UPDATE',[actor.email,input.requestKey])).rows[0];
            const tombstone=(await client.query('SELECT request_hash FROM project_snapshot_cancelled_requests WHERE email=$1 AND request_key=$2',[actor.email,input.requestKey])).rows[0];
            if(previous&&(previous.request_hash!==hash||previous.project_id!==projectId)||tombstone&&tombstone.request_hash!==hash)throw new ConflictException('UUID относится к другому запросу публикации.');
            if(previous&&['VERIFIED','DELETING','DELETED'].includes(previous.status))throw new ConflictException('Публикация уже завершена. Восстановите её состояние из списка снимков.');
            if(previous&&['UPLOADING','VERIFYING'].includes(previous.status))await client.query("UPDATE project_snapshots SET status='REJECTED',error='Публикация отменена пользователем.',verifier_owner=NULL,verifier_lease_until=NULL WHERE id=$1",[previous.id]);
            await client.query('INSERT INTO project_snapshot_cancelled_requests(email,request_key,project_id,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT(email,request_key) DO NOTHING',[actor.email,input.requestKey,projectId,hash]);
            if(!tombstone)await securityEvent(client,{actor:actor.email,action:'snapshot.request.cancel',resourceId:input.requestKey,before:{snapshotId:previous?.id??null},after:{cancelled:true,projectId}});
            return {cancelled:true,requestKey:input.requestKey};
        });
    }
    async manifest(projectId:string,id:string,actor:IAccessActor){
        return this.transaction(projectId,actor,1,async client=>{
            const row=await this.row(client,projectId,id);if(row.status!=='VERIFIED'||!row.manifest||!row.signature)throw new ConflictException('Снимок ещё не проверен или уже удалён.');
            return {snapshotId:row.id,projectId,manifest:row.manifest,sha256:row.manifest_sha256,signature:row.signature};
        });
    }
    async beginManifest(projectId:string,id:string,actor:IAccessActor,input:unknown):Promise<{manifestSha256:string;missing:Array<{sha256:string;size:number}>}>{
        let manifest:SnapshotManifest;try{manifest=normalizeSnapshotManifest(input);}catch{throw new BadRequestException('Опись снимка повреждена или содержит непереносимые файлы.');}
        if(Buffer.byteLength(snapshotCanonicalJson(manifest))>32*1024**2)throw new BadRequestException('Опись снимка превышает 32 МиБ.');
        const hash=snapshotManifestHash(manifest),bytes=manifest.files.reduce((sum,file)=>sum+file.size,0),maximum=Number(process.env.SNAPSHOT_MAX_BYTES||16*1024**3);
        if(!Number.isSafeInteger(maximum)||maximum<1||bytes>maximum)throw new BadRequestException('Снимок превышает настроенный лимит размера.');
        return this.transaction(projectId,actor,3,async client=>{
            const row=await this.row(client,projectId,id,true);
            if(row.status!=='UPLOADING'||row.email!==actor.email)throw new ConflictException('Публикация закрыта или принадлежит другому пользователю.');
            if(row.manifest_sha256&&row.manifest_sha256!==hash)throw new ConflictException('Опись уже закреплена: изменившийся индекс нужно опубликовать новым снимком.');
            const retained=Number((await client.query("SELECT COALESCE(sum(total_bytes),0)::text AS bytes FROM project_snapshots WHERE project_id=$1 AND id<>$2 AND status<>'DELETED'",[projectId,id])).rows[0].bytes);
            const quota=Number(process.env.SNAPSHOT_PROJECT_MAX_BYTES||64*1024**3);
            if(!Number.isSafeInteger(quota)||retained+bytes>quota)throw new ConflictException('Лимит истории снимков проекта превышен.');
            await client.query('UPDATE project_snapshots SET manifest=$2,manifest_sha256=$3,total_bytes=$4 WHERE id=$1',[id,JSON.stringify(manifest),hash,bytes]);
            await client.query(`INSERT INTO project_snapshot_blob_refs(snapshot_id,project_id,sha256,bytes)
                SELECT $1,$2,c->>'sha256',(c->>'size')::bigint FROM jsonb_array_elements($3::jsonb->'files') f CROSS JOIN LATERAL jsonb_array_elements(f->'chunks') c
                ON CONFLICT(snapshot_id,sha256) DO NOTHING`,[id,projectId,JSON.stringify(manifest)]);
            const missing=(await client.query<{sha256:string;size:number}>(`SELECT r.sha256,r.bytes::float8 AS size FROM project_snapshot_blob_refs r
                LEFT JOIN project_snapshot_blobs b ON b.project_id=r.project_id AND b.sha256=r.sha256 AND b.bytes=r.bytes AND b.state='LIVE'
                WHERE r.snapshot_id=$1 AND b.sha256 IS NULL ORDER BY r.sha256`,[id])).rows;
            return {manifestSha256:hash,missing};
        });
    }
    async finishUpload(projectId:string,id:string,actor:IAccessActor,hash:string):Promise<{snapshotId:string;status:string}>{
        return this.transaction(projectId,actor,3,async client=>{
            const row=await this.row(client,projectId,id,true);
            if(row.email!==actor.email||row.manifest_sha256!==hash)throw new ConflictException('Опись или владелец публикации изменились.');
            if(row.status==='VERIFYING'||row.status==='VERIFIED')return {snapshotId:id,status:row.status};
            if(row.status!=='UPLOADING')throw new ConflictException('Публикация закрыта.');
            const missing=await client.query(`SELECT 1 FROM project_snapshot_blob_refs r LEFT JOIN project_snapshot_blobs b
                ON b.project_id=r.project_id AND b.sha256=r.sha256 AND b.bytes=r.bytes AND b.state='LIVE' WHERE r.snapshot_id=$1 AND b.sha256 IS NULL LIMIT 1`,[id]);
            if(!row.manifest||missing.rowCount)throw new ConflictException('Не все блоки снимка сохранены. Повторите загрузку недостающих файлов.');
            await client.query("UPDATE project_snapshots SET status='VERIFYING',error=NULL,upload_completed_at=now() WHERE id=$1",[id]);
            await securityEvent(client,{actor:actor.email,action:'snapshot.upload.complete',resourceId:id,before:{status:row.status},after:{status:'VERIFYING',sha256:hash}});
            return {snapshotId:id,status:'VERIFYING'};
        });
    }
    async verified(id:string,owner:string,signature:SnapshotSignature|(()=>Promise<SnapshotSignature>)):Promise<void>{
        const row=(await this.pool.query<SnapshotRow>('SELECT * FROM project_snapshots WHERE id=$1',[id])).rows[0];if(!row)throw new NotFoundException();
        await this.transaction(row.project_id,{email:row.email,activeRole:row.role},3,async client=>{
            const saved=await client.query("UPDATE project_snapshots SET status='VERIFIED',signature=$3,verified_at=now(),verifier_owner=NULL,verifier_lease_until=NULL WHERE id=$1 AND status='VERIFYING' AND verifier_owner=$2 AND verifier_lease_until>now() RETURNING id",[id,owner,JSON.stringify(typeof signature==='function'?await signature():signature)]);
            if(!saved.rowCount)throw new ConflictException('Проверку уже отменили или её аренда истекла.');
            await securityEvent(client,{actor:row.email,action:'snapshot.verified',resourceId:id,before:{status:'VERIFYING'},after:{status:'VERIFIED',sha256:row.manifest_sha256}});
        });
    }
}
