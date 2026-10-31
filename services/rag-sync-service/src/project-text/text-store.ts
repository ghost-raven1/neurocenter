import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import {
    normalizeTextUpload,
    normalizeTextSearch,
    textUploadCanonical,
    textBytes,
    TEXT_KNOWLEDGE_CEILINGS,
    textKnowledgeAdmission,
} from '../../../shared/project-text-knowledge.cjs';
import type {
    TextCorpusState,
    TextUploadReceipt,
    TextSearchResult,
    TextAdmission,
} from '../../../shared/project-text-knowledge.cjs';
import { mapRagQuotaError } from '../rag/quota/rag-quota';
import { requireRagFeatures } from '../rag/rag-features';
import { PROJECT_TEXT_WRITE_LOCK } from './text-schema';
import { authorizeTextUpload } from './text-authorization';
import {
    textActor,
    textProject,
    textRequestKey,
    textInput,
    textState,
    textHash,
    textExcerpt,
    type TextActor,
} from './text-values';
import { readTextAdmission } from './text-policy';

/** Atomic text owner. No operation reads or writes semantic profiles, generations, seals or vectors. */
export class ProjectTextStore {
    constructor(
        private readonly pool: Pool,
        private readonly policy: () => Promise<TextAdmission> = readTextAdmission,
    ) {}

    async state(project: string): Promise<TextCorpusState> {
        const projectId = textProject(project);
        return textState(
            projectId,
            (await this.pool.query('SELECT * FROM project_text_state WHERE project_key=$1', [projectId])).rows[0],
        );
    }

    async receipt(project: string, key: string, who: TextActor): Promise<TextUploadReceipt | null> {
        const projectId = textProject(project),
            requestKey = textRequestKey(key),
            actor = textActor(who);
        return this.saved(this.pool, projectId, requestKey, actor.email);
    }

    private async saved(
        db: Pick<PoolClient, 'query'>,
        project: string,
        key: string,
        email: string,
        hash?: string,
    ): Promise<TextUploadReceipt | null> {
        const row = (
            await db.query(
                'SELECT request_hash,result FROM project_text_receipts WHERE project_key=$1 AND actor_email=$2 AND request_key=$3',
                [project, email, key],
            )
        ).rows[0];
        if (!row) return null;
        if (hash !== undefined && row.request_hash !== hash)
            throw new ConflictException('Ключ повтора уже закреплён за другим содержимым.');
        return row.result as TextUploadReceipt;
    }

    /** Exact committed recovery precedes flags and authorization for admission of a new write. */
    async upload(project: string, raw: unknown, requestHash: string, who: TextActor): Promise<TextUploadReceipt> {
        const projectId = textProject(project),
            actor = textActor(who),
            input = textInput((value) => normalizeTextUpload(value, TEXT_KNOWLEDGE_CEILINGS), raw);
        if (textHash(textUploadCanonical(input)) !== requestHash)
            throw new BadRequestException('Хеш загрузки не соответствует переданным текстам.');
        const client = await this.pool.connect();
        let discard = false;
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL lock_timeout='10s'");
            await client.query("SET LOCAL statement_timeout='10s'");
            await client.query(
                'LOCK TABLE rag_chunks,project_text_documents,project_text_state,project_text_receipts IN ROW EXCLUSIVE MODE',
            );
            await client.query('SELECT pg_advisory_xact_lock($1)', [PROJECT_TEXT_WRITE_LOCK]);
            const saved = await this.saved(client, projectId, input.requestKey, actor.email, requestHash);
            if (saved) {
                await client.query('COMMIT');
                return saved;
            }
            await requireRagFeatures(['project_text_knowledge']);
            const admission = textKnowledgeAdmission(await this.policy());
            textInput((value) => normalizeTextUpload(value, admission.limits), input);
            const previous = textState(
                projectId,
                (await client.query('SELECT * FROM project_text_state WHERE project_key=$1 FOR UPDATE', [projectId]))
                    .rows[0],
            );
            if (previous.revision !== input.expectedRevision)
                throw new ConflictException('Текстовая база изменилась. Обновите ревизию и повторите загрузку.');
            await authorizeTextUpload({ projectId, actor, requestKey: input.requestKey, requestHash, admission });
            // The authorization callback immediately precedes the first mutation, including quota triggers.
            for (const document of input.documents) {
                await client.query(
                    `INSERT INTO project_text_documents(project_key,path,id,content,content_hash,bytes)
                    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_key,path) DO UPDATE SET
                    content=EXCLUDED.content,content_hash=EXCLUDED.content_hash,bytes=EXCLUDED.bytes`,
                    [
                        projectId,
                        document.path,
                        textHash(projectId + '\0' + document.path),
                        document.content,
                        textHash(document.content),
                        textBytes(document.path) + textBytes(document.content),
                    ],
                );
            }
            const metadata = (
                await client.query<{ path: string; content_hash: string; bytes: number }>(
                    'SELECT path,content_hash,bytes FROM project_text_documents WHERE project_key=$1 ORDER BY path COLLATE "C"',
                    [projectId],
                )
            ).rows;
            const documents = metadata.map((row) => ({
                path: row.path,
                contentHash: row.content_hash,
                bytes: Number(row.bytes),
            }));
            const corpusHash = textHash(JSON.stringify(documents));
            const state = (
                await client.query(
                    `INSERT INTO project_text_state(project_key,revision,corpus_hash,document_count,bytes,updated_at)
                VALUES($1,$2,$3,$4,$5,clock_timestamp()) ON CONFLICT(project_key) DO UPDATE SET revision=EXCLUDED.revision,
                corpus_hash=EXCLUDED.corpus_hash,document_count=EXCLUDED.document_count,bytes=EXCLUDED.bytes,updated_at=EXCLUDED.updated_at RETURNING *`,
                    [
                        projectId,
                        previous.revision + 1,
                        corpusHash,
                        documents.length,
                        documents.reduce((sum, row) => sum + row.bytes, 0),
                    ],
                )
            ).rows[0];
            const result: TextUploadReceipt = {
                ...textState(projectId, state),
                requestKey: input.requestKey,
                requestHash,
                acceptedAt: new Date(state.updated_at).toISOString(),
                admission,
            };
            await client.query(
                `INSERT INTO project_text_receipts(project_key,actor_email,request_key,request_hash,result,accepted_at)
                VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
                [projectId, actor.email, input.requestKey, requestHash, JSON.stringify(result), result.acceptedAt],
            );
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {
                discard = true;
            });
            throw mapRagQuotaError(error) ?? error;
        } finally {
            client.release(discard);
        }
    }

    /** One repeatable-read snapshot binds citations to a complete old or new corpus revision. */
    async search(project: string, raw: unknown, retained?: TextAdmission): Promise<TextSearchResult> {
        const projectId = textProject(project),
            input = textInput((value) => normalizeTextSearch(value, TEXT_KNOWLEDGE_CEILINGS), raw);
        await requireRagFeatures(['project_text_knowledge']);
        const admission = textKnowledgeAdmission(retained ?? (await this.policy()));
        textInput((value) => normalizeTextSearch(value, admission.limits), input);
        const client = await this.pool.connect();
        let discard = false;
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            await client.query("SET LOCAL statement_timeout='10s'");
            const state = textState(
                projectId,
                (await client.query('SELECT * FROM project_text_state WHERE project_key=$1', [projectId])).rows[0],
            );
            if (input.revision !== undefined && state.revision !== input.revision)
                throw new ConflictException('Текстовая база изменилась. Выберите актуальную ревизию.');
            const { rows } = await client.query<{
                id: string;
                path: string;
                content: string;
                score: number;
                query_lexemes: string[];
            }>(
                `SELECT d.id,d.path,d.content,
                ts_rank_cd(d.search_vector,plainto_tsquery('simple',$2),32) AS score,
                tsvector_to_array(to_tsvector('simple',$2)) AS query_lexemes
                FROM project_text_documents d WHERE d.project_key=$1 AND d.search_vector @@ plainto_tsquery('simple',$2)
                ORDER BY score DESC,d.path COLLATE "C",d.id LIMIT $3`,
                [projectId, input.query, admission.limits.sources],
            );
            await client.query('COMMIT');
            return {
                mode: 'text',
                projectId,
                revision: state.revision,
                corpusHash: state.corpusHash,
                sources: rows
                    .map((row) => textExcerpt(row, admission.limits))
                    .filter((source) => source.excerpt.trim()),
                admission,
            };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {
                discard = true;
            });
            throw error;
        } finally {
            client.release(discard);
        }
    }
}
