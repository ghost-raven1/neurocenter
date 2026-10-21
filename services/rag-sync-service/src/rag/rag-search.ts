import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Pool } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { normalizeIndexProfile, type IIndexProfile } from '../../../shared/rag-index-contract.cjs';
import { requireUsableVectors } from './rag-index-state';

export interface ProjectSearchInput {
    projectId: string; generation: string; revision: number; dataRevision: number;
    profile: IIndexProfile; snapshot: string; embedding: number[];
}
export interface ProjectSearchSource {
    id: string; path: string; title?: string; startLine?: number; endLine?: number; score: number; excerpt: string;
}
export interface ProjectSearchResult { generation: string; snapshot: string; sources: ProjectSearchSource[] }

/** Search accepts an exact catalog context, never a caller-selected foreign generation. */
export function projectSearchInput(raw: unknown): ProjectSearchInput {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Нужен контекст поиска проекта.');
    const v = raw as Record<string, unknown>;
    if (Object.keys(v).sort().join(',') !== 'dataRevision,embedding,generation,profile,projectId,revision,snapshot'
        || typeof v.projectId !== 'string' || !/^prj-[a-zA-Z0-9-]{1,235}$/.test(v.projectId)
        || typeof v.generation !== 'string' || !/^(?:initial-[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.test(v.generation)
        || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || !Number.isSafeInteger(v.dataRevision) || Number(v.dataRevision) < 0
        || typeof v.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(v.snapshot)) throw new BadRequestException('Некорректный контекст поиска проекта.');
    let profile: IIndexProfile | null;
    try { profile = normalizeIndexProfile(v.profile); } catch { throw new BadRequestException('Некорректный профиль поиска.'); }
    if (!profile || profile.dimension > 16000) throw new BadRequestException('Выберите проверенный профиль поиска.');
    requireUsableVectors([{ embedding: v.embedding as number[] }], profile.dimension);
    return { ...v, profile } as unknown as ProjectSearchInput;
}

/** Bound UTF-8 bytes without splitting a code point; stored documents remain untouched. */
export function searchExcerpt(value: string, bytes = 3072): string {
    if (Buffer.byteLength(value) <= bytes) return value;
    let result = ''; let size = 0;
    for (const char of value) { const next = Buffer.byteLength(char); if (size + next > bytes - 3) break; result += char; size += next; }
    return result + '…';
}

/** Seal and rows share one repeatable-read snapshot. An incomplete index is never searched. */
export async function searchProjectIndex(pool: Pool, input: ProjectSearchInput): Promise<ProjectSearchResult> {
    const db = await pool.connect();
    try {
        await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await db.query("SET LOCAL statement_timeout='10s'");
        const state = (await db.query('SELECT * FROM rag_index_state WHERE project_key=$1 AND generation_id=$2', [input.projectId, input.generation])).rows[0];
        if (!state?.complete || state.snapshot_hash !== input.snapshot || !isDeepStrictEqual(normalizeIndexProfile(state.index_profile), input.profile)) {
            throw new ConflictException('Индекс проекта изменён или ещё не синхронизирован полностью.');
        }
        // Materialization makes mixed-dimension historical rows ineligible before cosine evaluation.
        const result = await db.query(`WITH eligible AS MATERIALIZED (
            SELECT id,file_path,description,start_line,end_line,left(content,3072) AS content,embedding FROM rag_chunks
            WHERE project_key=$1 AND generation_id=$2 AND embedding IS NOT NULL AND vector_dims(embedding)=$3 AND vector_norm(embedding)>0
        ) SELECT id,file_path,left(description,256) AS description,start_line,end_line,content,1-(embedding<=>$4::vector) AS score
          FROM eligible WHERE (embedding<=>$4::vector)<1 ORDER BY embedding<=>$4::vector,id LIMIT 6`,
        [input.projectId, input.generation, input.profile.dimension, JSON.stringify(input.embedding)]);
        await db.query('COMMIT');
        return { generation: input.generation, snapshot: input.snapshot, sources: result.rows.map(row => ({
            id: row.id, path: searchExcerpt(row.file_path, 1024), ...(row.description ? { title: row.description } : {}),
            ...(Number.isSafeInteger(row.start_line) && row.start_line > 0 ? { startLine: row.start_line } : {}),
            ...(Number.isSafeInteger(row.end_line) && row.end_line > 0 ? { endLine: row.end_line } : {}),
            score: Math.max(0, Math.min(1, Number(row.score))), excerpt: searchExcerpt(row.content),
        })) };
    } catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { db.release(); }
}
