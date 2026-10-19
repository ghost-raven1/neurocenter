import {ConflictException,NotFoundException} from '@nestjs/common';
import type {Pool,PoolClient} from 'pg';
import {securityEvent} from '../access/security-events';
import type {IModel,IModelDescriptor} from './model.types';
import type {IProjectEmbeddingSelection,IProjectEmbeddingUpdate} from './project-embedding.types';
import {assertProjectEmbeddingModel,projectEmbeddingPin} from './project-embedding.validation';

interface Row {project_id:string;revision:number|string;model_id:string|null;model_pin:string|null;dimension:number|null}
interface ModelRow {id:string;name:string;descriptor:IModelDescriptor;revision:number;created_at:Date|string;updated_at:Date|string}
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
            await client.query('COMMIT');
        }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
    }
    private async model(db:Queryable,id:string,lock=false):Promise<IModel|null>{
        const {rows}=await db.query<ModelRow>('SELECT * FROM model_catalog WHERE id=$1'+(lock?' FOR SHARE':''),[id]);const row=rows[0];
        return row?{id:row.id,name:row.name,...row.descriptor,revision:Number(row.revision),
            createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()}:null;
    }
    private async selection(db:Queryable,projectId:string,dimension:number,row?:Row):Promise<IProjectEmbeddingSelection>{
        const current=row?.model_id?await this.model(db,row.model_id):null;
        const modelPin=row?.model_pin??null;
        const profile=row?.model_id&&modelPin?{provider:'openai' as const,model:`neurocenter/${row.model_id}/sha256/${modelPin}`,dimension:Number(row.dimension)}:null;
        const result:IProjectEmbeddingSelection={projectId,revision:Number(row?.revision??0),expectedDimension:dimension,model:current,modelPin,profile};
        if(!row?.model_id)return {...result,blocker:'Выберите embedding-модель проекта.'};
        if(!current)return {...result,blocker:'Выбранная модель удалена из каталога. Выберите модель заново.'};
        const assigned=await db.query('SELECT 1 FROM project_models WHERE project_id=$1 AND model_id=$2',[projectId,current.id]);
        if(!assigned.rows.length)return {...result,blocker:'Выбранная модель больше не назначена этому проекту.'};
        try{assertProjectEmbeddingModel(current,dimension);}catch(error){return {...result,blocker:(error as Error).message};}
        if(projectEmbeddingPin(current)!==modelPin||row.dimension!==dimension)return {...result,blocker:'Закреплённая модель изменилась. Выберите её заново; прежний индекс требует отдельной проверки совместимости.'};
        return result;
    }
    async read(projectId:string,dimension:number):Promise<IProjectEmbeddingSelection>{
        const {rows}=await this.pool.query<Row>('SELECT * FROM project_embedding_settings WHERE project_id=$1',[projectId]);
        return this.selection(this.pool,projectId,dimension,rows[0]);
    }
    async update(projectId:string,input:IProjectEmbeddingUpdate,actor:string,dimension:number,authorize:()=>Promise<unknown>):Promise<IProjectEmbeddingSelection>{
        const client=await this.pool.connect();
        try{
            await client.query('BEGIN');
            if(!(await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[projectId])).rows.length)throw new NotFoundException('Проект удалён.');
            await authorize();
            const {rows}=await client.query<Row>('SELECT * FROM project_embedding_settings WHERE project_id=$1 FOR UPDATE',[projectId]);
            const previous=rows[0];const revision=Number(previous?.revision??0);
            let pin:string|null=null;
            if(input.modelId){
                const model=await this.model(client,input.modelId,true);if(!model)throw new NotFoundException('Модель удалена из каталога.');
                assertProjectEmbeddingModel(model,dimension);
                const assigned=await client.query('SELECT 1 FROM project_models WHERE project_id=$1 AND model_id=$2 FOR KEY SHARE',[projectId,model.id]);
                if(!assigned.rows.length)throw new ConflictException('Сначала добавьте эту модель в каталог проекта.');
                pin=projectEmbeddingPin(model);
            }
            const same=(previous?.model_id??null)===input.modelId&&(previous?.model_pin??null)===pin;
            if(same){const result=await this.selection(client,projectId,dimension,previous);await client.query('COMMIT');return result;}
            if(revision!==input.expectedRevision)throw new ConflictException('Выбор embedding-модели уже изменён. Обновите настройки проекта.');
            const next=revision+1;if(!Number.isSafeInteger(next))throw new ConflictException('Ревизия настроек превышает допустимый диапазон.');
            const saved=await client.query<Row>(`INSERT INTO project_embedding_settings(project_id,revision,model_id,model_pin,dimension,updated_by)
                VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id) DO UPDATE SET revision=EXCLUDED.revision,
                model_id=EXCLUDED.model_id,model_pin=EXCLUDED.model_pin,dimension=EXCLUDED.dimension,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
            [projectId,next,input.modelId,pin,input.modelId?dimension:null,actor]);
            const summary=(row?:Row)=>({revision:Number(row?.revision??0),modelId:row?.model_id??null,modelPin:row?.model_pin??null,dimension:row?.dimension??null});
            await securityEvent(client,{actor,action:'project.embedding.update',resourceId:projectId,before:summary(previous),after:summary(saved.rows[0])});
            const result=await this.selection(client,projectId,dimension,saved.rows[0]);await client.query('COMMIT');return result;
        }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
    }
}
