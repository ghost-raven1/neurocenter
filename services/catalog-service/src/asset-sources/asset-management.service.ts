import {AgentRepository} from '../agents/agent.repository';
import {agentNativeHash} from '../agents/agent-validation';
import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { publicationHash } from '../publication/publication-validation';
import { PluginRepository, toPlugin } from '../publication/plugin-repository';
import { nativeCardHash } from '../publication/native-hash';
import { nextModelRevision, saveModelVersion } from '../models/model-history';
import { archiveModelWithClient } from '../models/model-archive';
import { modelAssetHash } from './asset-model-adapter';
import type { IModelRow } from '../models/model-history';
import { AssetSourcesService } from './asset-sources.service';
import { SkillAssetClient, type ISkillSnapshot } from './skill-adapter';
import { authorizeImportActor } from './import-worker';
import { securityEvent } from '../access/security-events';

type Kind='mcp'|'plugin'|'skill'|'model'|'agent';
interface ITarget {kind:Kind;id:string;name:string;version:number;hash:string;archived:boolean;payloadHash?:string;archive?:ISkillSnapshot['archive'];slug?:string}
interface IProjectRef {id:string;name:string;addedAt:string;addedBy:string;version?:number|null;manifest?:string|null;revision?:number}
interface IImpact {target:ITarget;projects:IProjectRef[];preserved:string[];removeBlockers?:Array<{id:string;name:string}>}
interface IImpactRow {id:string;actor:string;digest:string;payload:IImpact;expires_at:string|Date}
interface IOperation {id:string;actor:string;mode:string;state:string;message:string}
const validUUID=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

/** Архив — CAS над native card и конкретными project refs; immutable content и локальные установки не удаляются. */
@Injectable()
export class AssetManagementService implements OnModuleInit {
    private readonly skills=new SkillAssetClient();
    constructor(private readonly source:AssetSourcesService) {}
    async onModuleInit():Promise<void>{
        await this.source.catalogReady();
    }
    private target(raw:unknown):{kind:Kind;id:string}{
        const input=raw as Partial<ITarget>;
        if(!input||!['mcp','plugin','skill','model','agent'].includes(String(input.kind))||typeof input.id!=='string'||input.id.length>240
            ||!input.id||/[\x00-\x1f\x7f]/.test(input.id)||Object.keys(input).some(key=>!['kind','id'].includes(key))){throw new BadRequestException('Выберите карточку общего каталога.');}
        if(input.kind==='skill'&&!/^common\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id)){throw new BadRequestException('Выберите общий скилл.');}
        return input as {kind:Kind;id:string};
    }
    private async snapshot(client:PoolClient,input:{kind:Kind;id:string}):Promise<IImpact>{
        let target:ITarget;
        if(input.kind==='skill'){
            const card=await this.skills.inspect(input.id);target={kind:'skill',id:card.id,name:card.name??card.id,version:card.version,hash:card.hash,archived:!!card.archivedAt,payloadHash:card.payloadHash,archive:card.archive};
        }else if(input.kind==='agent'){
            const card=await new AgentRepository(this.source.pool).get(input.id,client);target={...input,name:card.name,slug:card.slug,version:card.version,hash:agentNativeHash(card),archived:!!card.archivedAt};
        }else if(input.kind==='model'){
            const row=(await client.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1',[input.id])).rows[0];
            if(!row){throw new NotFoundException('Модель отсутствует в каталоге.');}
            target={...input,name:row.name,version:Number(row.revision),hash:modelAssetHash(row),archived:!!row.archived_at};
        }else{
            const row=(await client.query('SELECT * FROM ai_plugins WHERE id=$1',[input.id])).rows[0];
            if(!row||row.kind!==input.kind){throw new NotFoundException('Инструмент отсутствует в каталоге.');}const card=toPlugin(row);
            target={...input,name:card.name,version:card.version,hash:nativeCardHash(card),archived:!!row.archived_at};
        }
        const refs=input.kind==='agent'?await client.query<IProjectRef>(`SELECT p.id,p.name,a.added_at::text AS "addedAt",a.added_by AS "addedBy",a.version,a.manifest,s.revision
            FROM project_agents a JOIN projects p ON p.id=a.project_id JOIN project_agent_sets s ON s.project_id=a.project_id WHERE a.agent_id=$1 AND NOT a.removed ORDER BY p.id`,[input.id])
            :input.kind==='model'?await client.query<IProjectRef>(`SELECT p.id,p.name,a.added_at::text AS "addedAt",a.added_by AS "addedBy"
            FROM project_models a JOIN projects p ON p.id=a.project_id WHERE a.model_id=$1 ORDER BY p.id`,[input.id])
            :await client.query<IProjectRef>(`SELECT p.id,p.name,a.added_at::text AS "addedAt",a.added_by AS "addedBy",a.asset_version AS version,a.asset_manifest AS manifest
            FROM project_assets a JOIN projects p ON p.id=a.project_id WHERE a.asset_id=$1 AND a.asset_kind=$2 ORDER BY p.id`,[input.id,input.kind]);
        const removeBlockers=input.kind==='model'?(await client.query<{id:string;name:string}>('SELECT p.id,p.name FROM project_embedding_settings e JOIN projects p ON p.id=e.project_id WHERE e.model_id=$1 ORDER BY p.id',[input.id])).rows:undefined;
        return {target,projects:refs.rows,...(removeBlockers?.length?{removeBlockers}:{}),preserved:['immutable-versions','source-provenance','artifact-bytes','installed-files']};
    }
    async impact(actor:string,raw:unknown){
        const target=this.target(raw),client=await this.source.pool.connect();
        try{
            await client.query('BEGIN');await authorizeImportActor(client,actor,true);
            const payload=await this.snapshot(client,target),id=randomUUID(),digest=publicationHash(payload);
            await client.query("INSERT INTO asset_management_impacts(id,actor,digest,payload,expires_at) VALUES($1,$2,$3,$4::jsonb,now()+interval '10 minutes')",[id,actor,digest,JSON.stringify(payload)]);
            await client.query('COMMIT');return {impactId:id,digest,target:payload.target,projects:payload.projects,preserved:payload.preserved,removeBlockers:payload.removeBlockers};
        }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
    }
    async archive(actor:string,raw:unknown){
        const input=raw as {impactId?:unknown;expectedDigest?:unknown;mode?:unknown};
        if(!input||!validUUID(input.impactId)||typeof input.expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedDigest)||!['catalog-only','catalog-and-projects','restore'].includes(String(input.mode))
            ||Object.keys(input).some(key=>!['impactId','expectedDigest','mode'].includes(key))){throw new BadRequestException('Передайте сохранённую проверку последствий и выбранный режим удаления.');}
        const pool=this.source.pool,row=(await pool.query<IImpactRow>('SELECT * FROM asset_management_impacts WHERE id=$1 AND actor=$2',[input.impactId,actor])).rows[0];
        if(!row){throw new NotFoundException('Проверка последствий недоступна текущему пользователю.');}
        if(row.digest!==input.expectedDigest){throw new ConflictException('Подтверждение не соответствует проверенным последствиям.');}
        const previous=(await pool.query<IOperation>('SELECT * FROM asset_management_operations WHERE id=$1',[row.id])).rows[0];
        if(previous&&previous.mode!==input.mode){throw new ConflictException('Этот запрос архивирования уже сохранён с другим режимом.');}
        if(previous?.state==='SUCCEEDED'){return previous;}
        if(!previous&&new Date(row.expires_at).getTime()<Date.now()){throw new ConflictException('Проверка последствий устарела. Откройте её заново.');}
        await pool.query("INSERT INTO asset_management_operations(id,actor,mode,state,message) VALUES($1,$2,$3,'PREPARED','Проверяем сохранённые последствия') ON CONFLICT(id) DO NOTHING",[row.id,actor,input.mode]);
        const client=await pool.connect();let skillCommitted=false;
        try{
            await client.query('BEGIN');await authorizeImportActor(client,actor,true);
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:'+row.payload.target.kind+':'+row.payload.target.id]);
            const operation=(await client.query<IOperation>('SELECT * FROM asset_management_operations WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
            if(operation.mode!==input.mode){throw new ConflictException('Режим уже сохранён другим запросом.');}
            if(operation.state==='SUCCEEDED'){await client.query('COMMIT');return operation;}
            const before=row.payload,current=await this.snapshot(client,before.target),restore=input.mode==='restore';
            if(restore&&!before.target.archived){throw new ConflictException('Карточка уже доступна в общем каталоге.');}
            const recoveredSkill=before.target.kind==='skill'&&current.target.archive?.requestKey===row.id&&current.target.archive.previousHash===before.target.hash
                &&current.target.archive.payloadHash===current.target.payloadHash&&current.target.archive.version===current.target.version&&current.target.archive.restore===restore&&current.target.archived!==restore;
            if(publicationHash(current.projects)!==publicationHash(before.projects)||!recoveredSkill&&publicationHash(current.target)!==publicationHash(before.target)){
                throw new ConflictException('Карточка или подключения проектов изменились. Проверьте последствия заново.');
            }
            if(before.target.kind==='mcp'||before.target.kind==='plugin'){
                await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['publication:dependency-graph']);
                await new PluginRepository(pool).archive(client,before.target.id,actor,{expectedHash:before.target.hash,removeProjectRefs:input.mode==='catalog-and-projects',restore});
            }else if(before.target.kind==='agent'){
                await new AgentRepository(pool).archive(client,before.target.id,before.target.hash,{restore,removeProjectRefs:input.mode==='catalog-and-projects'});
            }else if(before.target.kind==='model'){
                if(restore){
                    const next=await nextModelRevision(client,before.target.id,before.target.version);
                    const updated=await client.query<IModelRow>('UPDATE model_catalog SET archived_at=NULL,revision=$3,updated_at=now() WHERE id=$1 AND revision=$2 RETURNING *',[before.target.id,before.target.version,next]);
                    if(!updated.rows[0]){throw new ConflictException('Карточка модели изменилась перед восстановлением.');}await saveModelVersion(client,updated.rows[0]);
                }else{await archiveModelWithClient(client,before.target.id,before.target.version,actor,{removeProjectRefs:input.mode==='catalog-and-projects'});}
            }else{
                await this.skills.call('archive',{id:before.target.id,expected:{id:before.target.id,version:before.target.version,hash:before.target.hash},actor,requestKey:row.id,restore});
                skillCommitted=true;
                if(input.mode==='catalog-and-projects'){await client.query("DELETE FROM project_assets WHERE asset_id=$1 AND asset_kind='skill'",[before.target.id]);}
            }
            const after=await this.snapshot(client,before.target);
            await client.query('UPDATE asset_source_receipts SET native_version=$4,native_hash=$5,updated_at=now() WHERE asset_kind=$1 AND native_id=$2 AND native_hash=$3',
                [before.target.kind,before.target.id,before.target.hash,after.target.version,after.target.hash]);
            await securityEvent(client,{actor,action:restore?'asset.restore':'asset.archive',resourceId:before.target.id,before:{kind:before.target.kind,id:before.target.id,name:before.target.name,slug:before.target.slug,version:before.target.version,hash:before.target.hash,projects:before.projects},
                after:{kind:after.target.kind,id:after.target.id,name:after.target.name,slug:after.target.slug,version:after.target.version,mode:input.mode,archived:!restore,preserved:before.preserved}});
            const message=before.target.kind==='agent'&&input.mode==='catalog-and-projects'?'Агент удалён из каталога и настроек проектов. Примените изменения на каждом компьютере для удаления файлов OpenCode.':'Операция завершена; история и файлы сохранены';
            const {rows}=await client.query<IOperation>("UPDATE asset_management_operations SET state='SUCCEEDED',message=$2,updated_at=now() WHERE id=$1 RETURNING *",[row.id,message]);
            await client.query('COMMIT');return rows[0];
        }catch(error){
            await client.query('ROLLBACK').catch(()=>undefined);
            const durable=(await pool.query<IOperation>('SELECT * FROM asset_management_operations WHERE id=$1',[row.id])).rows[0];
            if(durable?.state==='SUCCEEDED'){return durable;}
            if(skillCommitted){
                const message='Скилл архивирован, но база не подтвердила изменение подключений. Повторите тот же запрос, чтобы завершить сохранённую операцию.';
                await pool.query("UPDATE asset_management_operations SET state='PARTIAL',message=$2,updated_at=now() WHERE id=$1",[row.id,message]);return {state:'PARTIAL',message};
            }
            throw error;
        }finally{client.release();}
    }
}
