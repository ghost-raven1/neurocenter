import {
    BadRequestException,
    ConflictException,
    HttpException,
    Injectable,
    ServiceUnavailableException,
    type OnModuleInit,
    type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { ModelsService } from './models.service';
import { initialGeneration } from './project-embedding.repository';
import type { IProjectRagContext } from './project-embedding.types';
import { ProjectRagClient } from './project-rag-client';
import { ragRequestHash } from '../../../shared/rag-index-contract.cjs';
import {
    RAG_WRITE_AUTHORIZATION_PROTOCOL,
    RAG_WRITE_POLICY,
    ragWriteAdmissionUncertain,
    type IRagWriteGrant,
    type RagWriteAuthorizationPhase,
} from '../../../shared/rag-write-authorization.cjs';
import { authorizeRagIntentAuthor, type IRagIntentAuthor } from './project-rag-authorization';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';

interface ISyncIntent extends IRagIntentAuthor {
    id: string;
    project_id: string;
    request_key: string;
    payload_hash: string;
    payload: Record<string, unknown>;
    context: IProjectRagContext;
    state: string;
    result: Record<string, unknown> | null;
}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Durable barrier сохраняется до HTTP: неопределённый ответ нельзя обойти новым sync или promotion. */
@Injectable()
export class ProjectRagCoordinator implements OnModuleInit, OnModuleDestroy {
    readonly client = new ProjectRagClient();
    private timer: ReturnType<typeof setInterval> | undefined;
    private recovering = false;
    private readonly tasks = new Set<Promise<void>>();
    constructor(private readonly models: ModelsService) {}
    async onModuleInit(): Promise<void> {
        await this.models.ready();
        this.timer = setInterval(() => {
            const task = this.recover().catch(() => undefined);
            this.tasks.add(task);
            void task.finally(() => this.tasks.delete(task));
        }, 3000);
        this.timer.unref();
    }
    async onModuleDestroy(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        await Promise.allSettled([...this.tasks]);
    }
    private async recover(): Promise<void> {
        if (this.recovering) return;
        this.recovering = true;
        try {
            const pending = await this.models.pool.query<ISyncIntent>(
                "SELECT * FROM project_rag_sync_intents WHERE state IN ('pending','uncertain') ORDER BY updated_at,created_at,id LIMIT 10",
            );
            for (const row of pending.rows) {
                await this.finish(row).catch(() => undefined);
            }
        } finally {
            this.recovering = false;
        }
    }
    async context(projectId: string, db: Pick<PoolClient, 'query'> = this.models.pool): Promise<IProjectRagContext> {
        const found = await db.query('SELECT * FROM project_embedding_settings WHERE project_id=$1', [projectId]),
            row = found.rows[0];
        return {
            projectId,
            revision: Number(row?.revision ?? 0),
            dataRevision: Number(row?.data_revision ?? 0),
            generation: row?.active_generation ?? initialGeneration(projectId),
            profile:
                row?.model_id && row.model_pin
                    ? {
                          provider: 'openai',
                          model: `neurocenter/${row.model_id}/sha256/${row.model_pin}`,
                          dimension: Number(row.dimension),
                      }
                    : null,
            snapshot: row?.active_snapshot ?? null,
        };
    }
    async requireIdle(db: Pick<PoolClient, 'query'>, projectId: string): Promise<void> {
        const pending = await db.query(
            "SELECT id FROM project_rag_sync_intents WHERE project_id=$1 AND state IN ('pending','uncertain')",
            [projectId],
        );
        if (pending.rows.length)
            throw new ConflictException({
                code: 'RAG_SYNC_UNCERTAIN',
                message:
                    'Подтверждение синхронизации ещё проверяется. Завершите повтор синхронизации перед сменой модели.',
            });
    }
    /** Exact receipt recovery is distinct from a fresh admission immediately before RAG's first mutation. */
    async authorizeWrite(value: {
        id: string;
        payloadHash: string;
        context: IProjectRagContext;
        phase: RagWriteAuthorizationPhase;
    }): Promise<IRagWriteGrant> {
        if (typeof value?.id !== 'string' || !sha(value.payloadHash) || !['receipt', 'write'].includes(value.phase))
            throw new BadRequestException('Некорректная фаза разрешения записи. Обновите RAG и Catalog.');
        const db = await this.models.pool.connect();
        let discard = false;
        try {
            await db.query('BEGIN');
            await db.query("SET LOCAL lock_timeout='3s'");
            await db.query("SET LOCAL statement_timeout='7s'");
            const intent = (
                await db.query<ISyncIntent>('SELECT * FROM project_rag_sync_intents WHERE id=$1', [value.id])
            ).rows[0];
            if (
                !intent ||
                intent.state === 'failed' ||
                intent.payload_hash !== value.payloadHash ||
                ragRequestHash(intent.context) !== ragRequestHash(value.context)
            )
                throw new ConflictException('Intent записи не подтверждён каталогом.');
            if (value.phase === 'write') {
                await authorizeRagIntentAuthor(db, intent.project_id, intent);
                await requireFeaturesEnabled(['rag_sync']);
                const current = await this.context(intent.project_id, db);
                if (intent.state === 'succeeded' || ragRequestHash(current) !== ragRequestHash(intent.context))
                    throw new ConflictException('Контекст intent изменился или запись уже подтверждена.');
            }
            await db.query('COMMIT');
            return { ok: true, protocol: RAG_WRITE_AUTHORIZATION_PROTOCOL, phase: value.phase };
        } catch (error) {
            await db.query('ROLLBACK').catch(() => {
                discard = true;
            });
            throw error;
        } finally {
            db.release(discard);
        }
    }
    async sync(request: Request, value: unknown): Promise<Record<string, unknown>> {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new BadRequestException('Некорректный пакет синхронизации.');
        const body = value as Record<string, unknown>;
        if (
            typeof body.projectKey !== 'string' ||
            !sha(body.requestKey) ||
            !integer(body.expectedDataRevision) ||
            !integer(body.expectedSelectionRevision) ||
            typeof body.expectedGeneration !== 'string' ||
            Object.keys(body).some(
                (key) =>
                    ![
                        'projectKey',
                        'requestKey',
                        'expectedDataRevision',
                        'expectedSelectionRevision',
                        'expectedGeneration',
                        'fingerprintVersion',
                        'indexProfile',
                        'snapshot',
                        'chunks',
                        'deletes',
                    ].includes(key),
            )
        ) {
            throw new BadRequestException(
                'Обновите мост: синхронизации нужны зафиксированный контекст проекта и ключ повтора.',
            );
        }
        const actor = await this.models.actor(request),
            project = await this.models.resolveProject(request, body.projectKey, 2, actor);
        body.projectKey = project.id;
        const payloadHash = ragRequestHash(body),
            client = await this.models.pool.connect();
        let intent: ISyncIntent;
        try {
            await client.query('BEGIN');
            await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [project.id]);
            await this.models.resolveProject(request, project.id, 2);
            const previous = await client.query<ISyncIntent>(
                'SELECT * FROM project_rag_sync_intents WHERE project_id=$1 AND request_key=$2',
                [project.id, body.requestKey],
            );
            if (previous.rows.length) {
                intent = previous.rows[0];
                if (intent.payload_hash !== payloadHash)
                    throw new ConflictException('Ключ повтора уже закреплён за другим пакетом.');
                if (intent.state === 'succeeded') {
                    await client.query('COMMIT');
                    return intent.result!;
                }
                if (intent.state === 'failed')
                    throw new ConflictException(
                        'Предыдущий пакет отклонён без изменения данных. Перечитайте состояние индекса.',
                    );
            } else {
                await this.requireIdle(client, project.id);
                const context = await this.context(project.id, client);
                if (!context.profile)
                    throw new ConflictException('Сначала выберите проверенную embedding-модель проекта.');
                const pinned = /^neurocenter\/(model-[a-z0-9-]+)\/sha256\/([a-f0-9]{64})$/.exec(context.profile.model);
                if (
                    !pinned ||
                    !(await this.models.isAssigned(project.id, pinned[1])) ||
                    !(await this.models.getPinned(pinned[1], pinned[2]))
                )
                    throw new ConflictException('Закреплённая модель больше не назначена проекту.');
                if (
                    context.revision !== body.expectedSelectionRevision ||
                    context.dataRevision !== body.expectedDataRevision ||
                    context.generation !== body.expectedGeneration ||
                    ragRequestHash(context.profile) !== ragRequestHash(body.indexProfile)
                )
                    throw new ConflictException(
                        'Состояние индекса или модель изменились. Перечитайте серверный снимок.',
                    );
                const inserted = await client.query<ISyncIntent>(
                    `INSERT INTO project_rag_sync_intents(id,project_id,request_key,payload_hash,payload,context,state,author_email,author_role,write_policy)
                    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'pending',$7,$8,$9) RETURNING *`,
                    [
                        randomUUID(),
                        project.id,
                        body.requestKey,
                        payloadHash,
                        JSON.stringify(body),
                        JSON.stringify(context),
                        actor.email,
                        actor.activeRole,
                        RAG_WRITE_POLICY,
                    ],
                );
                intent = inserted.rows[0];
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
        return this.finish(intent);
    }
    /** Replay всегда использует сохранённые байты и intent ID; 404 receipt не доказывает отсутствие позднего COMMIT. */
    async finish(intent: ISyncIntent): Promise<Record<string, unknown>> {
        let result: Record<string, unknown>;
        try {
            result = await this.client.call<Record<string, unknown>>('write', {
                id: intent.id,
                payloadHash: intent.payload_hash,
                context: intent.context,
                payload: intent.payload,
            });
            if (
                !result ||
                !integer(result.upserted) ||
                !integer(result.deleted) ||
                !integer(result.rowCount) ||
                typeof result.complete !== 'boolean' ||
                result.dimension !== intent.context.profile?.dimension ||
                ragRequestHash(result.indexProfile) !== ragRequestHash(intent.context.profile) ||
                (result.complete && !sha(result.snapshotHash))
            )
                throw new ServiceUnavailableException('Результат записи не подтверждён.');
        } catch (error) {
            const response = error instanceof HttpException ? error.getResponse() : null;
            // A disabled replay may race a previously admitted COMMIT; only its exact receipt resolves that uncertainty.
            const admissionDenied =
                error instanceof HttpException && error.getStatus() === 403 && ragWriteAdmissionUncertain(response);
            const definitive =
                !admissionDenied && error instanceof HttpException && [400, 403, 409, 413].includes(error.getStatus());
            await this.models.pool.query(
                "UPDATE project_rag_sync_intents SET state=$2,error=$3::jsonb,updated_at=now() WHERE id=$1 AND state IN ('pending','uncertain')",
                [
                    intent.id,
                    definitive ? 'failed' : 'uncertain',
                    JSON.stringify({
                        message: definitive
                            ? 'Пакет отклонён без изменения индекса.'
                            : 'Результат синхронизации ещё не подтверждён.',
                    }),
                ],
            );
            throw error;
        }
        const db = await this.models.pool.connect();
        try {
            await db.query('BEGIN');
            await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [intent.project_id]);
            const saved = await db.query<ISyncIntent>('SELECT * FROM project_rag_sync_intents WHERE id=$1 FOR UPDATE', [
                intent.id,
            ]);
            if (saved.rows[0].state === 'succeeded') {
                await db.query('COMMIT');
                return saved.rows[0].result!;
            }
            const context = await this.context(intent.project_id, db);
            if (
                context.generation !== intent.context.generation ||
                context.revision !== intent.context.revision ||
                context.dataRevision !== intent.context.dataRevision
            )
                throw new ConflictException('Контекст записанного пакета изменён. Требуется проверка проекта.');
            const next = context.dataRevision + 1;
            if (!Number.isSafeInteger(next))
                throw new ConflictException('Ревизия индекса превышает допустимый диапазон.');
            const output = {
                ...result,
                generation: context.generation,
                selectionRevision: context.revision,
                dataRevision: next,
            };
            await db.query(
                'UPDATE project_embedding_settings SET data_revision=$2,active_snapshot=$3 WHERE project_id=$1',
                [intent.project_id, next, result.complete === true ? result.snapshotHash : null],
            );
            await db.query(
                "UPDATE project_rag_sync_intents SET state='succeeded',result=$2::jsonb,error=NULL,updated_at=now() WHERE id=$1",
                [intent.id, JSON.stringify(output)],
            );
            await db.query('COMMIT');
            return output;
        } catch (error) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            db.release();
        }
    }
}
