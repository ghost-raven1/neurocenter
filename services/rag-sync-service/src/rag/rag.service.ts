import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { ProjectDatabases, projectDatabaseName } from './project-databases';
import { type IUpsertRow, type IRagProjectSummary } from './rag-db';
import { type ISyncChunk } from './dto';
import {validateDelta} from './rag-validation';
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
    async manifest(projectKey: string): Promise<Record<string, string>> {
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
    ): Promise<{ upserted: number; deleted: number }> {
        const delta=validateDelta(chunks,deletes,Number(process.env.RAG_DIM||2560));
        const upserts: IUpsertRow[] = delta.chunks.map(toRow);
        return this.databases.withProject(projectKey,(db,id)=>db.applyDelta(id,upserts,delta.deletes));
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

    /** Имя серверной базы проекта без пароля и строки подключения. */
    async databaseInfo(projectKey:string):Promise<{databaseName:string;projectId:string}> {
        return this.databases.withProject(projectKey,async (_db,id)=>({databaseName:projectDatabaseName(id),projectId:id}));
    }
}

/**
 * Убирает из текста байт, недопустимые для PG UTF8 (NUL и прочие control-символы),
 * кроме переноса строки/таба.
 */
function cleanText(v: string | null | undefined): string | null {
    if (v == null) {
        return v as null;
    }

    return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function toRow(c: ISyncChunk): IUpsertRow {
    const content = cleanText(c.content) ?? '';
    return {
        id: c.id,
        filePath: cleanText(c.filePath) ?? '',
        content,
        description: cleanText(c.description),
        startLine: c.startLine ?? null,
        endLine: c.endLine ?? null,
        language: cleanText(c.language),
        kind: cleanText(c.kind) ?? '',
        role: cleanText(c.role),
        quirkType: cleanText(c.quirkType),
        tags: cleanText(c.tags),
        // Хэш считается от ОЧИЩЕННОГО (как хранится) контента, а не от клиентского:
        // иначе cleanText меняет content, hash остаётся «от оригинала» → chunk
        // вечно помечается «изменённым» на каждой синхронизации.
        contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
        embedding: c.embedding ?? null,
    };
}
