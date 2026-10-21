import {BadRequestException,ConflictException,Injectable,NotFoundException,OnModuleInit} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {LEGACY_DEMO_POLICY,LEGACY_DEMO_SKILLS,LEGACY_DEMO_REFS} from '../../../shared/legacy-demo-retirement.cjs';
import {AssetSourcesService} from './asset-sources.service';
import {SkillAssetClient} from './skill-adapter';
import {authorizeImportActor} from './import-worker';
import {publicationHash} from '../publication/publication-validation';
import {securityEvent} from '../access/security-events';

interface ISource {version:number;sha256:string;bytes:number;resources:Array<{path:string;sha256:string;bytes:number}>;}
interface ISkill {id:string;version:number;hash:string;name:string;archivedAt?:string;archive?:{requestKey:string;previousHash:string};source:ISource;missingVersions:number[];preservedSource?:ISource;}
interface IItem {id:string;eligible:boolean;reason:string;skill?:ISkill;refs:Record<string,unknown>[];}
interface IPreview {policy:string;skills:IItem[];refs:Record<string,unknown>[];}
interface IPreviewRow {id:string;actor:string;digest:string;payload:IPreview;expires_at:Date|string;}
interface IReceipt {id:string;actor:string;request_key:string;state:string;result:unknown;}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const same=(a:unknown,b:unknown)=>publicationHash(a)===publicationHash(b);
const jsonRows=(rows:Record<string,unknown>[]):Record<string,unknown>[]=>JSON.parse(JSON.stringify(rows));

/** Explicit fixed-scope migration. Every original file/version and unresolved assignment remains recoverable. */
@Injectable()
export class LegacyRetirementService implements OnModuleInit {
    private readonly skills=new SkillAssetClient();
    constructor(private readonly source:AssetSourcesService){}
    async onModuleInit():Promise<void>{
        await this.source.catalogReady();await this.source.pool.query(`
            CREATE TABLE IF NOT EXISTS legacy_retirement_previews(id UUID PRIMARY KEY,actor TEXT NOT NULL,digest TEXT NOT NULL,payload JSONB NOT NULL,expires_at TIMESTAMPTZ NOT NULL);
            CREATE TABLE IF NOT EXISTS legacy_retirement_operations(id UUID PRIMARY KEY REFERENCES legacy_retirement_previews(id),actor TEXT NOT NULL,request_key UUID NOT NULL,state TEXT NOT NULL,result JSONB,UNIQUE(actor,request_key));
            CREATE TABLE IF NOT EXISTS legacy_retired_project_assets(migration_id UUID NOT NULL REFERENCES legacy_retirement_operations(id),project_id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_kind TEXT NOT NULL,
                original_record JSONB NOT NULL,record_sha256 TEXT NOT NULL,retired_by TEXT NOT NULL,retired_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(migration_id,project_id,asset_id,asset_kind))`);
    }
    private async refs(db:Pick<PoolClient,'query'>):Promise<Record<string,unknown>[]>{
        const result:Record<string,unknown>[]=[];
        for(const ref of LEGACY_DEMO_REFS){
            const row=(await db.query('SELECT * FROM project_assets WHERE project_id=$1 AND asset_id=$2 AND asset_kind=$3',[ref.projectId,ref.id,ref.kind])).rows[0];
            if(row&&row.pin_origin==='unresolved'&&row.asset_version===null&&row.asset_manifest===null&&row.pin_snapshot===null)result.push(...jsonRows([row]));
        }
        return result;
    }
    private async snapshot(db:Pick<PoolClient,'query'>):Promise<IPreview>{
        const skills:IItem[]=[];
        for(const entry of LEGACY_DEMO_SKILLS){
            let skill:ISkill;try{skill=await this.skills.call('legacy-inspect',{id:entry.id});}
            catch(error){if((error as {getStatus?:()=>number}).getStatus?.()!==404)throw error;skills.push({id:entry.id,eligible:false,reason:'Исходная запись отсутствует; ничего не создаётся.',refs:[]});continue;}
            const refs=jsonRows((await db.query('SELECT * FROM project_assets WHERE asset_id=$1 AND asset_kind=\'skill\' ORDER BY project_id',[entry.id])).rows);
            const exists=entry.projectId&&!!(await db.query('SELECT 1 FROM projects WHERE id=$1',[entry.projectId])).rowCount;
            const eligible=!skill.archivedAt&&!exists&&skill.version===entry.version&&skill.source.sha256===entry.sha256;
            skills.push({id:entry.id,skill,refs,eligible,reason:skill.archivedAt?'Запись уже в архиве.':exists?'Проект существует; автоматический карантин запрещён.':!eligible?'Исходная версия или байты отличаются от проверенного legacy. Требуется отдельное решение.':entry.reason});
        }
        return {policy:LEGACY_DEMO_POLICY,skills,refs:await this.refs(db)};
    }
    async preview(actor:string,raw:unknown){
        if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length)throw new BadRequestException('Эта миграция не принимает произвольные пути, проекты или действия.');
        const db=await this.source.pool.connect();try{
            await db.query('BEGIN');await authorizeImportActor(db,actor,true);
            const payload=await this.snapshot(db),id=randomUUID(),digest=publicationHash(payload);
            await db.query("INSERT INTO legacy_retirement_previews VALUES($1,$2,$3,$4::jsonb,now()+interval '10 minutes')",[id,actor,digest,JSON.stringify(payload)]);
            await db.query('COMMIT');return {previewId:id,digest,...payload,preserved:['original-file-bytes','resources','available-historical-versions','unresolved-assignment-records','project-records']};
        }catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{db.release();}
    }
    async apply(actor:string,raw:unknown){
        const input=raw as {previewId?:unknown;expectedDigest?:unknown;requestKey?:unknown};
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['previewId','expectedDigest','requestKey'].includes(k))||!uuid(input.previewId)||!uuid(input.requestKey)||typeof input.expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedDigest))throw new BadRequestException('Нужны просмотренные последствия, digest и UUID ключа запроса.');
        const pool=this.source.pool,preview=(await pool.query<IPreviewRow>('SELECT * FROM legacy_retirement_previews WHERE id=$1 AND actor=$2',[input.previewId,actor])).rows[0];
        if(!preview)throw new NotFoundException('Проверка миграции недоступна этому администратору.');
        if(preview.digest!==input.expectedDigest||preview.payload.policy!==LEGACY_DEMO_POLICY)throw new ConflictException('Подтверждение миграции не совпадает с просмотренным.');
        const db=await pool.connect();let changedFile=false;
        try{
            await db.query('BEGIN');await authorizeImportActor(db,actor,true);
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[LEGACY_DEMO_POLICY]);
            const previous=(await db.query<IReceipt>('SELECT * FROM legacy_retirement_operations WHERE id=$1 OR (actor=$2 AND request_key=$3) FOR UPDATE',[preview.id,actor,input.requestKey])).rows[0];
            if(previous&&(previous.id!==preview.id||previous.actor!==actor||previous.request_key!==input.requestKey))throw new ConflictException('Ключ запроса уже закреплён за другой миграцией.');
            if(previous?.state==='SUCCEEDED'){await db.query('COMMIT');return previous.result;}
            if(!previous&&new Date(preview.expires_at).getTime()<Date.now())throw new ConflictException('Проверка устарела. Просмотрите актуальные последствия.');
            if(!previous){
                await db.query('ROLLBACK');await pool.query("INSERT INTO legacy_retirement_operations VALUES($1,$2,$3,'PREPARED',NULL) ON CONFLICT(id) DO NOTHING",[preview.id,actor,input.requestKey]);
                await db.query('BEGIN');await authorizeImportActor(db,actor,true);await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[LEGACY_DEMO_POLICY]);
            }
            const saved=(await db.query<IReceipt>('SELECT * FROM legacy_retirement_operations WHERE id=$1 FOR UPDATE',[preview.id])).rows[0];
            if(saved.actor!==actor||saved.request_key!==input.requestKey)throw new ConflictException('Миграция уже подтверждена другим запросом.');
            if(saved.state==='SUCCEEDED'){await db.query('COMMIT');return saved.result;}
            const lockIds=[...preview.payload.skills.filter(i=>i.eligible).map(i=>'asset-management:skill:'+i.id),...LEGACY_DEMO_REFS.map(r=>'asset-management:'+r.kind+':'+r.id)].sort();
            for(const key of lockIds)await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
            if(!same(await this.refs(db),preview.payload.refs))throw new ConflictException('Назначения изменились после проверки. Новые или исправленные pins не затрагиваются.');
            const planned=preview.payload.skills.filter(i=>i.eligible),receipts:ISkill[]=[];
            // Check every SQL/FS boundary before the first irreversible cross-service commit.
            for(const item of planned){
                const entry=LEGACY_DEMO_SKILLS.find(e=>e.id===item.id)!;
                if(entry.projectId&&(await db.query('SELECT 1 FROM projects WHERE id=$1',[entry.projectId])).rowCount)throw new ConflictException('Проект с исходным ID существует. Карантин запрещён.');
                const refs=jsonRows((await db.query('SELECT * FROM project_assets WHERE asset_id=$1 AND asset_kind=\'skill\' ORDER BY project_id',[item.id])).rows);
                if(!same(refs,item.refs))throw new ConflictException('Подключения скилла изменились после проверки.');
                const expected=item.skill!,current=await this.skills.call<ISkill>('legacy-inspect',{id:item.id});
                const recovered=!!current.archivedAt&&current.archive?.requestKey===preview.id&&current.archive.previousHash===expected.hash;
                if(!recovered&&(!same(current.source,expected.source)||current.hash!==expected.hash))throw new ConflictException('Скилл изменился после проверки.');
            }
            for(const item of planned){
                const expected=item.skill!;
                const receipt=await this.skills.call<ISkill>('legacy-retire',{id:item.id,expected:{id:item.id,version:expected.version,hash:expected.hash,source:expected.source},actor,requestKey:preview.id});
                changedFile=true;if(!same(receipt.preservedSource,expected.source))throw new ConflictException('Сервис не подтвердил исходные байты архива.');receipts.push(receipt);
            }
            for(const row of preview.payload.refs){
                await db.query('INSERT INTO legacy_retired_project_assets(migration_id,project_id,asset_id,asset_kind,original_record,record_sha256,retired_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)',[preview.id,row.project_id,row.asset_id,row.asset_kind,JSON.stringify(row),publicationHash(row),actor]);
                const removed=await db.query("DELETE FROM project_assets WHERE project_id=$1 AND asset_id=$2 AND asset_kind=$3 AND pin_origin='unresolved' AND asset_version IS NULL AND asset_manifest IS NULL AND pin_snapshot IS NULL",[row.project_id,row.asset_id,row.asset_kind]);
                if(removed.rowCount!==1)throw new ConflictException('Назначение уже изменено; миграция остановлена.');
            }
            const result={id:preview.id,policy:LEGACY_DEMO_POLICY,state:'SUCCEEDED',skills:receipts,quarantinedRefs:preview.payload.refs.length,projectsDeleted:0,historyPurged:false};
            await securityEvent(db,{actor,action:'asset.legacy.retire',resourceId:LEGACY_DEMO_POLICY,before:{skills:preview.payload.skills.filter(i=>i.eligible).map(i=>({id:i.id,source:i.skill!.source,missingVersions:i.skill!.missingVersions})),refs:preview.payload.refs},after:result});
            await db.query("UPDATE legacy_retirement_operations SET state='SUCCEEDED',result=$2::jsonb WHERE id=$1",[preview.id,JSON.stringify(result)]);await db.query('COMMIT');return result;
        }catch(error){
            await db.query('ROLLBACK').catch(()=>undefined);
            const completed=await pool.query<IReceipt>('SELECT * FROM legacy_retirement_operations WHERE id=$1 AND actor=$2 AND request_key=$3',[preview.id,actor,input.requestKey]);
            if(completed.rows[0]?.state==='SUCCEEDED')return completed.rows[0].result;
            if(changedFile){
                const result={id:preview.id,state:'PARTIAL',message:'Исходные файлы сохранены в архиве. Повторите тот же запрос для завершения квитанции и назначений.'};
                const saved=await pool.query("UPDATE legacy_retirement_operations SET state='PARTIAL',result=$2::jsonb WHERE id=$1 AND state<>'SUCCEEDED' RETURNING id",[preview.id,JSON.stringify(result)]);
                if(!saved.rowCount){const durable=await pool.query<IReceipt>('SELECT * FROM legacy_retirement_operations WHERE id=$1 AND actor=$2 AND request_key=$3',[preview.id,actor,input.requestKey]);if(durable.rows[0]?.state==='SUCCEEDED')return durable.rows[0].result;}
                return result;
            }
            throw error;
        }finally{db.release();}
    }
}
