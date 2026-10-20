import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { ProjectDatabases, projectDatabaseName } from './project-databases';
import { type IUpsertRow, type IRagProjectSummary } from './rag-db';
import type {ISyncChunk} from './dto';
import {validateDelta} from './rag-validation';
import {normalizeChunkRow,rowFingerprint} from '../../../shared/rag-index-contract.cjs';
import {validateIndexWrite,requireUsableVectors} from './rag-index-state';
import {validateRagQuotaUpdate,type IRagQuotaUpdate} from './quota/rag-quota';
import {projectRagContext,type IProjectRagContext} from './project-rag-context';
import type {RagDb} from './rag-db';
import {ragRequestHash} from '../../../shared/rag-index-contract.cjs';


@Injectable()
export class RagService implements OnModuleInit, OnModuleDestroy {
    constructor(private readonly databases: ProjectDatabases) {}
    async onModuleInit():Promise<void> {}
    async onModuleDestroy():Promise<void> {}
    private async read<T>(project:string,action:(db:RagDb,id:string,context:IProjectRagContext)=>Promise<T>):Promise<T>{
        return this.databases.withProject(project,async(db,id)=>{const context=await projectRagContext(id);return action(db,id,context);});
    }

    /**
     * Снимок `{ id -> content_hash }` по project.
     *
     * @param projectKey - ключ проекта.
     * @returns {Promise<Record<string, string>>}
     */
    async manifest(projectKey: string) {
        return this.read(projectKey,async(db,id,context)=>({...await db.manifest(id,context.generation),generation:context.generation,
            selectionRevision:context.revision,dataRevision:context.dataRevision,selectedProfile:context.profile}));
    }

    /**
     * Суммарная статистика по project.
     *
     * @param projectKey - ключ проекта.
     * @returns {Promise<{ rowCount: number; lastSyncedAt: string | null; dimension: number }>}
     */
    async summary(
        projectKey: string,
    ) {
        return this.read(projectKey,async(db,id,context)=>{
            const [summary,quota]=await Promise.all([db.summary(id,context.generation),db.quota(id)]);return {...summary,quota,generation:context.generation,
                selectionRevision:context.revision,dataRevision:context.dataRevision,selectedProfile:context.profile};
        });
    }

    /**
     * Оценка размера develop-индекса проекта (pgvector, байты) — «резервная
     * копия» локального rag_db.
     *
     * @param {string} projectKey - ключ проекта.
     * @returns {Promise<number>}
     */
    async retainedSizeBytes(projectKey: string): Promise<number> {
        return this.databases.withProject(projectKey,(db,id)=>db.retainedEstimateBytes(id));
    }

    /**
     * Список develop-индексов по всем projectKey.
     *
     * @returns {Promise<IRagProjectSummary[]>}
     */
    async listProjects(): Promise<IRagProjectSummary[]> {
        const projects=await this.databases.projects();
        const result:IRagProjectSummary[]=[];
        for (const project of projects) {
            const summary=await this.read(project.id,(db,id,context)=>db.summary(id,context.generation));
            result.push({projectKey:project.id,...summary});
        }
        return result;
    }

    /**
     * Dельта-apply: upsert + delete (идемпотентно).
     *
     * @param projectKey - ключ проекта.
     * @param chunks - строки для upsert.
     * @param deletes - id для удаления.
     * @returns {Promise<{ upserted: number; deleted: number }>}
     */
    async applyDelta(value:{id:string;payloadHash:string;context:IProjectRagContext;payload:Record<string,unknown>}) {
        if(!value||typeof value!=='object'||Array.isArray(value)||!value.payload||typeof value.payload!=='object'||Array.isArray(value.payload))throw new BadRequestException('Передайте сохранённый intent синхронизации.');
        const {context,payload}=value;
        if(typeof value.id!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.id)||ragRequestHash(payload)!==value.payloadHash
            ||!context?.profile||context.profile.dimension<1||context.profile.dimension>16000||payload.projectKey!==context.projectId
            ||payload.expectedGeneration!==context.generation||payload.expectedSelectionRevision!==context.revision||payload.expectedDataRevision!==context.dataRevision){throw new BadRequestException('Пакет не соответствует сохранённому intent и профилю проекта.');}
        const dimension=context.profile.dimension;
        const write=validateIndexWrite(payload.indexProfile,payload.snapshot,dimension);
        if(ragRequestHash(write.indexProfile)!==ragRequestHash(context.profile))throw new ConflictException('Профиль пакета не совпал с закреплённой моделью проекта.');
        const delta=validateDelta(payload.chunks??[],payload.deletes??[],dimension);
        if(write.snapshot?.complete&&(delta.chunks.length||delta.deletes.length)){throw new BadRequestException('Подтверждение снимка передаётся отдельным пустым пакетом после всех изменений.');}
        if(write.indexProfile){requireUsableVectors(delta.chunks.map(row=>({embedding:row.embedding??null})),dimension);}
        const upserts: IUpsertRow[] = delta.chunks.map(row=>toRow(row,!!write.indexProfile));
        const base=(process.env.CATALOG_SERVICE_URL||'http://localhost:4100').replace(/\/+$/,'');
        const authorization=await fetch(base+'/internal/project-rag/write-authorize',{method:'POST',
            headers:{'content-type':'application/json','x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''},
            body:JSON.stringify({id:value.id,payloadHash:value.payloadHash,context}),signal:AbortSignal.timeout(8000)});
        if(!authorization.ok)throw new ServiceUnavailableException('Каталог пока не подтвердил intent записи. Повтор использует тот же пакет.');
        return this.databases.withProject(context.projectId,(db,id)=>db.applyDelta(id,context.generation,upserts,delta.deletes,write,{id:value.id,payloadHash:value.payloadHash}));
    }

    /**
     * Количество строк develop-индекса по project.
     *
     * @param projectKey - ключ проекта.
     * @returns {Promise<number>}
     */
    async count(projectKey: string): Promise<number> {
        return this.read(projectKey,(db,id,context)=>db.count(id,context.generation));
    }

    /** Отдельный действующий лимит знаний: общие плановые квоты каталога не подменяют его. */
    async quota(projectKey:string,update?:IRagQuotaUpdate,actor?:string){
        if(update!==undefined){validateRagQuotaUpdate(update);}
        return this.databases.withProject(projectKey,(db,id)=>db.quota(id,update,actor));
    }

    /**
     * Страница строк develop-индекса (включая эмбеддинги) — потоковая
     * обратная синхронизация (OOM-защита).
     *
     * @param projectKey - ключ проекта.
     * @param limit - размер страницы.
     * @param offset - смещение.
     * @returns {Promise<IUpsertRow[]>}
     */
    async rowsPage(projectKey: string, limit: number, offset: number): Promise<IUpsertRow[]> {
        return this.read(projectKey,(db,id,context)=>db.rowsPage(id,context.generation,limit,offset));
    }

    /** Экспорт содержит подтверждённое состояние снимка; новый мост проверяет его до записи. */
    async exportPage(projectKey:string,limit:number,offset:number,generation?:string){
        return this.read(projectKey,async(db,id,context)=>{
            const selected=generation??context.generation;
            if(selected!==context.generation)await db.generations.get(id,selected);
            return {...await db.exportPage(id,selected,limit,offset),generation:selected,selectionRevision:context.revision,dataRevision:context.dataRevision};
        });
    }

    /** Имя серверной базы проекта без пароля и строки подключения. */
    async databaseInfo(projectKey:string):Promise<{databaseName:string;projectId:string}> {
        return this.databases.withProject(projectKey,async (_db,id)=>({databaseName:projectDatabaseName(id),projectId:id}));
    }
    async buildGeneration(projectId:string,generation:string){
        const base=(process.env.CATALOG_SERVICE_URL||'http://localhost:4100').replace(/\/+$/,'');
        return this.databases.withProject(projectId,(db,id)=>db.generations.build(id,generation,async(texts,profile)=>{
            const response=await fetch(base+'/internal/project-rag/reindex-embedding',{
                method:'POST',headers:{'content-type':'application/json','x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''},
                body:JSON.stringify({projectId:id,planId:generation,profile,input:texts}),signal:AbortSignal.timeout(110000)});
            if(!response.ok)throw new BadRequestException('Модель не выполнила батч переиндексации.');
            const result=await response.json() as {embeddings:number[][]};return result.embeddings;
        }));
    }
}

/**
 * Сохраняет отдельные SHA текста и полного фрагмента для безопасной дельта-синхронизации.
 */
function toRow(c: ISyncChunk,verified:boolean): IUpsertRow {
    const normalized=normalizeChunkRow(c);
    return {
        ...normalized,
        contentHash: createHash('sha256').update(normalized.content, 'utf8').digest('hex'),
        syncHash:verified?rowFingerprint(normalized):null,
    };
}
