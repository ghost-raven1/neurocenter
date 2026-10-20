import {ConflictException,NotFoundException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {securityEvent} from '../access/security-events';
import type {IProjectEmbeddingSelection} from './project-embedding.types';
import {assertProjectEmbeddingModel,projectEmbeddingPin} from './project-embedding.validation';
import {readPinnedModel} from './model-history';

interface Row {project_id:string;revision:number|string;model_id:string|null;model_pin:string|null;dimension:number|null;active_generation:string;active_snapshot:string|null;data_revision:number|string}
type Queryable=Pick<PoolClient,'query'>;

/** CAS-выбор и его аудит сохраняются одной транзакцией; очистка не сбрасывает ревизию. */
export class ProjectEmbeddingRepository {
    constructor(private readonly pool:Pool){}
    async setup():Promise<void>{
        const client=await this.pool.connect();
        try{
            await client.query('BEGIN');
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:project-embedding-schema',0))");
            await client.query(`CREATE TABLE IF NOT EXISTS project_embedding_settings (
            project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            revision BIGINT NOT NULL CHECK(revision>0),model_id TEXT,model_pin TEXT,dimension INTEGER,
            updated_by TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK((model_id IS NULL AND model_pin IS NULL AND dimension IS NULL)
                OR (model_id IS NOT NULL AND model_pin IS NOT NULL AND dimension IS NOT NULL AND model_pin ~ '^[a-f0-9]{64}$' AND dimension>0)))`);
            await client.query(`ALTER TABLE project_embedding_settings ADD COLUMN IF NOT EXISTS active_generation TEXT;
                ALTER TABLE project_embedding_settings ADD COLUMN IF NOT EXISTS active_snapshot TEXT;
                ALTER TABLE project_embedding_settings ADD COLUMN IF NOT EXISTS data_revision BIGINT NOT NULL DEFAULT 0;
                UPDATE project_embedding_settings SET active_generation='initial-'||md5(project_id) WHERE active_generation IS NULL;
                ALTER TABLE project_embedding_settings ALTER COLUMN active_generation SET NOT NULL`);
            await client.query('COMMIT');
        }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
    }
    private async selection(db:Queryable,projectId:string,row?:Row):Promise<IProjectEmbeddingSelection>{
        const current=row?.model_id&&row.model_pin?await readPinnedModel(db,row.model_id,row.model_pin):null;
        const modelPin=row?.model_pin??null;
        const dimension=Number(row?.dimension??0);
        const profile=row?.model_id&&modelPin?{provider:'openai' as const,model:`neurocenter/${row.model_id}/sha256/${modelPin}`,dimension:Number(row.dimension)}:null;
        const result:IProjectEmbeddingSelection={projectId,revision:Number(row?.revision??0),expectedDimension:dimension,model:current,modelPin,profile,
            activeGeneration:row?.active_generation??initialGeneration(projectId),activeSnapshot:row?.active_snapshot??null,dataRevision:Number(row?.data_revision??0)};
        if(!row?.model_id)return {...result,blocker:'Выберите embedding-модель проекта.'};
        if(!current)return {...result,blocker:'Выбранная модель удалена из каталога. Выберите модель заново.'};
        const assigned=await db.query('SELECT 1 FROM project_models WHERE project_id=$1 AND model_id=$2',[projectId,current.id]);
        if(!assigned.rows.length)return {...result,blocker:'Выбранная модель больше не назначена этому проекту.'};
        try{assertProjectEmbeddingModel(current,dimension);}catch(error){return {...result,blocker:(error as Error).message};}
        if(projectEmbeddingPin(current)!==modelPin)return {...result,blocker:'Снимок закреплённой модели повреждён. Выберите проверенную модель.'};
        return result;
    }
    async read(projectId:string):Promise<IProjectEmbeddingSelection>{
        const {rows}=await this.pool.query<Row>('SELECT * FROM project_embedding_settings WHERE project_id=$1',[projectId]);
        return this.selection(this.pool,projectId,rows[0]);
    }
    async clear(projectId:string,expectedRevision:number,actor:string,authorize:(db:Queryable)=>Promise<unknown>):Promise<IProjectEmbeddingSelection>{
        const client=await this.pool.connect();
        try{
            await client.query('BEGIN');
            if(!(await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[projectId])).rows.length)throw new NotFoundException('Проект удалён.');
            await authorize(client);
            const {rows}=await client.query<Row>('SELECT * FROM project_embedding_settings WHERE project_id=$1 FOR UPDATE',[projectId]);
            const previous=rows[0];const revision=Number(previous?.revision??0);
            const same=previous?.model_id==null;
            if(same){const result=await this.selection(client,projectId,previous);await client.query('COMMIT');return result;}
            if(revision!==expectedRevision)throw new ConflictException('Выбор embedding-модели уже изменён. Обновите настройки проекта.');
            const next=revision+1;if(!Number.isSafeInteger(next))throw new ConflictException('Ревизия настроек превышает допустимый диапазон.');
            const saved=await client.query<Row>(`INSERT INTO project_embedding_settings(project_id,revision,model_id,model_pin,dimension,updated_by,active_generation)
                VALUES($1,$2,NULL,NULL,NULL,$3,$4) ON CONFLICT(project_id) DO UPDATE SET revision=EXCLUDED.revision,
                model_id=EXCLUDED.model_id,model_pin=EXCLUDED.model_pin,dimension=EXCLUDED.dimension,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
            [projectId,next,actor,initialGeneration(projectId)]);
            const summary=(row?:Row)=>({revision:Number(row?.revision??0),modelId:row?.model_id??null,modelPin:row?.model_pin??null,dimension:row?.dimension??null});
            await securityEvent(client,{actor,action:'project.embedding.update',resourceId:projectId,before:summary(previous),after:summary(saved.rows[0])});
            const result=await this.selection(client,projectId,saved.rows[0]);await client.query('COMMIT');return result;
        }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
    }
}

/** Одноразовая миграция существующего индекса использует одинаковую идентичность в обеих БД. */
export function initialGeneration(projectId:string):string{return 'initial-'+createHash('md5').update(projectId).digest('hex');}
