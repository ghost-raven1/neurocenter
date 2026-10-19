import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { ProjectDatabases, projectDatabaseName } from './project-databases';
import { type IUpsertRow, type IRagProjectSummary } from './rag-db';
import { type ISyncChunk } from './dto';
import {validateDelta} from './rag-validation';
import {normalizeChunkRow,rowFingerprint} from '../../../shared/rag-index-contract.cjs';
import {validateIndexWrite,requireUsableVectors} from './rag-index-state';
import {validateRagQuotaUpdate,type IRagQuotaUpdate} from './quota/rag-quota';


@Injectable()
export class RagService implements OnModuleInit, OnModuleDestroy {
    constructor(private readonly databases: ProjectDatabases) {}
    async onModuleInit():Promise<void> {}
    async onModuleDestroy():Promise<void> {}

    /**
     * Снимок `{ id -> content_hash }` по project.
     *
     * @param projectKey - ключ проекта.
     * @returns {Promise<Record<string, string>>}
     */
    async manifest(projectKey: string) {
        return this.databases.withProject(projectKey,(db,id)=>db.manifest(id));
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
        return this.databases.withProject(projectKey,async(db,id)=>{
            const [summary,quota]=await Promise.all([db.summary(id),db.quota(id)]);return {...summary,quota};
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
            const summary=await this.databases.withProject(project.id,(db,id)=>db.summary(id));
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
    async applyDelta(
        projectKey: string,
        chunks: ISyncChunk[],
        deletes: string[],
        indexProfile?:unknown,
        snapshot?:unknown,
    ) {
        const dimension=Number(process.env.RAG_DIM||2560);
        const write=validateIndexWrite(indexProfile,snapshot,dimension);
        const delta=validateDelta(chunks,deletes,dimension);
        if(write.snapshot?.complete&&(delta.chunks.length||delta.deletes.length)){throw new BadRequestException('Подтверждение снимка передаётся отдельным пустым пакетом после всех изменений.');}
        if(write.indexProfile){requireUsableVectors(delta.chunks.map(row=>({embedding:row.embedding??null})),dimension);}
        const upserts: IUpsertRow[] = delta.chunks.map(row=>toRow(row,!!write.indexProfile));
        return this.databases.withProject(projectKey,(db,id)=>db.applyDelta(id,upserts,delta.deletes,write));
    }

    /**
     * Количество строк develop-индекса по project.
     *
     * @param projectKey - ключ проекта.
     * @returns {Promise<number>}
     */
    async count(projectKey: string): Promise<number> {
        return this.databases.withProject(projectKey,(db,id)=>db.count(id));
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
        return this.databases.withProject(projectKey,(db,id)=>db.rowsPage(id,limit,offset));
    }

    /** Экспорт содержит подтверждённое состояние снимка; новый мост проверяет его до записи. */
    async exportPage(projectKey:string,limit:number,offset:number){
        return this.databases.withProject(projectKey,async(db,id)=>{
            const [rows,summary]=await Promise.all([db.rowsPage(id,limit,offset),db.summary(id)]);
            return {chunks:rows,...summary};
        });
    }

    /** Имя серверной базы проекта без пароля и строки подключения. */
    async databaseInfo(projectKey:string):Promise<{databaseName:string;projectId:string}> {
        return this.databases.withProject(projectKey,async (_db,id)=>({databaseName:projectDatabaseName(id),projectId:id}));
    }
}

/**
 * Сохраняет legacy sha(content), добавляя независимый полный hash проверенного фрагмента.
 */
function toRow(c: ISyncChunk,verified:boolean): IUpsertRow {
    const normalized=normalizeChunkRow(c);
    return {
        ...normalized,
        // Legacy manifest остаётся совместимым; полный fingerprint учитывает векторы отдельно.
        contentHash: createHash('sha256').update(normalized.content, 'utf8').digest('hex'),
        syncHash:verified?rowFingerprint(normalized):null,
    };
}
