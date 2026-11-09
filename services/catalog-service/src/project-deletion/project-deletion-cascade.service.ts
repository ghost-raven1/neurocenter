import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { createPool } from '../database/pool';
import { RetiredRagService } from '../retired-rag/retired-rag.service';
import { backupDirectory } from '../backups/backup-policy';
import { chatObjectDigest } from '../model-chat/chat-object-storage';
import { SnapshotStorage, type ISnapshotBlob } from '../snapshots/snapshot-storage';

/** Строка project_snapshot_blobs с адресом блока: GC-паттерн хранит sha256 отдельно от ISnapshotBlob. */
interface ISnapshotBlobRow extends ISnapshotBlob {
    sha256: string;
}

/** Entry 5.11 (AD-D3): домены физического удаления проекта. */
export const DELETION_DOMAINS = ['rag', 'chat', 'snapshots', 'skills', 'dumps'] as const;
export type TDeletionDomain = (typeof DELETION_DOMAINS)[number];
export type TDeletionDomainState = 'deleted' | 'absent' | 'pending' | 'failed';
export interface IDeletionDomainReceipt {
    state: TDeletionDomainState;
    at: string;
    detail?: string;
    [key: string]: unknown;
}
export type TDeletionReceipt = Partial<Record<TDeletionDomain, IDeletionDomainReceipt>>;

/** Терминальные состояния: повтор по recovery не нужен. */
export function isTerminalDeletion(state: TDeletionDomainState | undefined): boolean {
    return state === 'deleted' || state === 'absent';
}
/** Есть ли незакрытые домены (pending/failed), требующие повторной попытки. */
export function hasOpenDeletion(receipt: TDeletionReceipt): boolean {
    return DELETION_DOMAINS.some((domain) => {
        const state = receipt[domain]?.state;
        return state === 'pending' || state === 'failed';
    });
}
const now = () => new Date().toISOString();
const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

interface ICascadeOptions {
    pool?: Pool;
    snapshotStorage?: Pick<SnapshotStorage, 'remove'>;
    skillsUrl?: string;
    backupDir?: string;
    recoveryIntervalMs?: number;
}

/**
 * Entry 5.11 (AD-D3): полный каскад подтверждения удаления проекта.
 *
 * После того как `deleteProjectWithAudit` выполнил FK-cascade и зафиксировал
 * `project_retirements`, этот сервис физически удаляет ресурсы проекта в каждом
 * домене (RAG-база, S3-чаты, снимки, скиллы, дампы) и пишет по-доменную
 * квитанцию в `project_retirements.deleted_resources`. Удаление проекта никогда
 * не падает из-за битого подсистемы: сбой домена фиксируется как pending/failed,
 * а recovery-таймер повторяет незакрытые домены.
 */
@Injectable()
export class ProjectDeletionCascadeService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger('ProjectDeletionCascade');
    private readonly pool: Pool;
    private readonly snapshotStorage?: Pick<SnapshotStorage, 'remove'>;
    private readonly skillsUrl: string;
    private readonly backupDir: string;
    private readonly recoveryIntervalMs: number;
    private timer?: NodeJS.Timeout;
    private readonly tasks = new Set<Promise<void>>();
    private readonly running = new Set<string>();

    constructor(
        private readonly retiredRag: RetiredRagService,
        options: ICascadeOptions = {},
    ) {
        this.pool =
            options.pool ??
            createPool(
                {
                    connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog',
                    max: 2,
                },
                'project-deletion-cascade',
            );
        this.snapshotStorage = options.snapshotStorage;
        this.skillsUrl = (options.skillsUrl ?? process.env.SKILLS_SERVICE_URL ?? 'http://localhost:4200').replace(/\/$/, '');
        this.backupDir = options.backupDir ?? backupDirectory();
        this.recoveryIntervalMs = options.recoveryIntervalMs ?? 30_000;
    }

    async onModuleInit(): Promise<void> {
        this.timer = setInterval(() => {
            const work = this.recover().catch(() => undefined);
            this.tasks.add(work);
            void work.finally(() => this.tasks.delete(work));
        }, this.recoveryIntervalMs);
        this.timer.unref();
    }
    async onModuleDestroy(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        await Promise.allSettled([...this.tasks]);
        await this.pool.end();
    }

    /**
     * Запустить каскад для подтверждённо удалённого проекта. Не бросает: каждый
     * домен изолирован, результат пишется в квитанцию. Идемпотентен.
     */
    async run(projectId: string, actor: string): Promise<TDeletionReceipt> {
        if (this.running.has(projectId)) return await this.readReceipt(projectId);
        this.running.add(projectId);
        try {
            const mainAdmin = await this.mainAdminEmail(actor);
            for (const domain of DELETION_DOMAINS) {
                const current = await this.readReceipt(projectId);
                if (isTerminalDeletion(current[domain]?.state)) continue;
                let result: IDeletionDomainReceipt;
                try {
                    result = await this.runDomain(domain, projectId, actor, mainAdmin);
                } catch (error) {
                    result = { state: 'failed', at: now(), detail: message(error) };
                    this.logger.warn(`Каскад удаления ${projectId}: домен ${domain} не завершён: ${message(error)}`);
                }
                await this.mergeReceipt(projectId, { [domain]: result } as TDeletionReceipt);
            }
            return await this.readReceipt(projectId);
        } finally {
            this.running.delete(projectId);
        }
    }

    /** Recovery: повторить незакрытые домены для недавних подтверждённых удалений. */
    private async recover(): Promise<void> {
        const rows = (
            await this.pool.query<{ project_id: string; actor: string; deleted_resources: TDeletionReceipt | null }>(
                `SELECT project_id, actor, deleted_resources FROM project_retirements
                 WHERE origin='deletion' AND deleted_at > now() - interval '7 days'
                 ORDER BY deleted_at DESC LIMIT 20`,
            )
        ).rows;
        for (const row of rows) {
            if (!hasOpenDeletion(row.deleted_resources ?? {})) continue;
            if (this.running.has(row.project_id)) continue;
            const work = this.run(row.project_id, row.actor).then(
                () => undefined,
                () => undefined,
            );
            this.tasks.add(work);
            void work.finally(() => this.tasks.delete(work));
        }
    }

    private async runDomain(
        domain: TDeletionDomain,
        projectId: string,
        actor: string,
        mainAdmin: string,
    ): Promise<IDeletionDomainReceipt> {
        switch (domain) {
            case 'rag':
                return this.stepRag(projectId, mainAdmin);
            case 'chat':
                return this.stepChat(projectId);
            case 'snapshots':
                return this.stepSnapshots(projectId);
            case 'skills':
                return this.stepSkills(projectId, actor);
            case 'dumps':
                return this.stepDumps(projectId);
        }
    }

    /** RAG-база: идемпотентный авто-пург через существующий durable-механизм. */
    private async stepRag(projectId: string, mainAdmin: string): Promise<IDeletionDomainReceipt> {
        const result = await this.retiredRag.cascadePurge(projectId, mainAdmin).catch((error) => ({
            state: 'failed' as const,
            detail: message(error),
        }));
        return { ...result, at: now() };
    }

    /** S3-оригиналы чата: FK-cascade уже пометил объекты; outbox дотраивает. */
    private async stepChat(projectId: string): Promise<IDeletionDomainReceipt> {
        if (!(await this.tableExists('model_chat_objects'))) return { state: 'absent', at: now() };
        const prefix = 'projects/' + chatObjectDigest(projectId) + '/';
        const { rows } = await this.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM model_chat_objects WHERE object_key LIKE $1 AND state <> 'DELETED'",
            [prefix + '%'],
        );
        const remaining = rows[0].n;
        if (remaining === 0) return { state: 'absent', at: now() };
        return { state: 'pending', at: now(), remaining, detail: 'S3-объекты чата дотраиваются outbox-очередью' };
    }

    /** Снимки: строки не имеют FK на projects — удаляем метаданные и блоки. */
    private async stepSnapshots(projectId: string): Promise<IDeletionDomainReceipt> {
        if (!(await this.tableExists('project_snapshot_blobs'))) return { state: 'absent', at: now() };
        const blobs = (
            await this.pool.query<ISnapshotBlobRow>(
                'SELECT sha256,bytes,storage_id,version_id,state FROM project_snapshot_blobs WHERE project_id=$1',
                [projectId],
            )
        ).rows;
        const { rows: snapRows } = await this.pool.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM project_snapshots WHERE project_id=$1',
            [projectId],
        );
        const snapshots = snapRows[0].n;
        if (blobs.length === 0 && snapshots === 0) return { state: 'absent', at: now() };

        const client = await this.pool.connect();
        let fence = false;
        try {
            fence = (
                await client.query(
                    "SELECT pg_try_advisory_lock(hashtextextended('neurocenter:snapshot-storage',0)) AS locked",
                )
            ).rows[0].locked;
            if (!fence) return { state: 'pending', at: now(), detail: 'фенс хранилища снимков занят; повтор' };
            let storage: Pick<SnapshotStorage, 'remove'> | undefined = this.snapshotStorage;
            if (!storage) {
                try {
                    storage = new SnapshotStorage(this.pool);
                } catch (error) {
                    return { state: 'pending', at: now(), detail: 'хранилище снимков недоступно: ' + message(error) };
                }
            }
            let removed = 0;
            let failed = 0;
            for (const blob of blobs) {
                if (blob.state !== 'DELETING')
                    await this.pool.query(
                        "UPDATE project_snapshot_blobs SET state='DELETING' WHERE project_id=$1 AND sha256=$2",
                        [projectId, blob.sha256],
                    );
                const intent = (
                    await this.pool.query<ISnapshotBlob>(
                        "SELECT sha256,bytes,storage_id,version_id,state FROM project_snapshot_blobs WHERE project_id=$1 AND sha256=$2 AND state='DELETING'",
                        [projectId, blob.sha256],
                    )
                ).rows[0];
                if (!intent) continue;
                try {
                    await storage.remove(projectId, blob.sha256, intent);
                    await this.pool.query(
                        'DELETE FROM project_snapshot_blobs WHERE project_id=$1 AND sha256=$2 AND storage_id=$3 AND version_id IS NOT DISTINCT FROM $4',
                        [projectId, blob.sha256, intent.storage_id, intent.version_id],
                    );
                    removed++;
                } catch {
                    // Не подтверждённое удаление S3/FS: блок оставляем DELETING для recovery/GC.
                    failed++;
                }
            }
            const { rows: leftRows } = await this.pool.query<{ n: number }>(
                'SELECT count(*)::int AS n FROM project_snapshot_blobs WHERE project_id=$1',
                [projectId],
            );
            const left = leftRows[0].n;
            if (left === 0) {
                for (const table of [
                    'project_snapshot_blob_refs',
                    'project_snapshot_blob_writes',
                    'project_snapshot_profiles',
                    'project_snapshot_commands',
                    'project_snapshot_cancelled_requests',
                    'project_snapshot_cancelled_commands',
                    'project_snapshots',
                ]) {
                    if (await this.tableExists(table))
                        await this.pool.query(`DELETE FROM ${table} WHERE project_id=$1`, [projectId]);
                }
                return { state: 'deleted', at: now(), blobs: blobs.length, snapshots, removed };
            }
            return {
                state: 'pending',
                at: now(),
                blobs: blobs.length,
                snapshots,
                removed,
                remaining: left,
                detail: failed ? 'не все блоки снимков подтверждены; повтор' : 'часть блоков снимков осталась; повтор',
            };
        } finally {
            if (fence)
                await client
                    .query("SELECT pg_advisory_unlock(hashtextextended('neurocenter:snapshot-storage',0))")
                    .catch(() => undefined);
            client.release();
        }
    }

    /** Скиллы: каталог проекта живёт в хранилище skills-service — внутренний вызов. */
    private async stepSkills(projectId: string, actor: string): Promise<IDeletionDomainReceipt> {
        let response: Response;
        try {
            response = await fetch(this.skillsUrl + '/internal/project-skills/delete', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '',
                },
                body: JSON.stringify({ projectId, actor }),
                signal: AbortSignal.timeout(20_000),
            });
        } catch {
            return { state: 'pending', at: now(), detail: 'skills-service недоступен; повтор' };
        }
        if (response.status === 404) return { state: 'absent', at: now(), detail: 'каталог скиллов проекта отсутствует' };
        if (!response.ok)
            return { state: 'failed', at: now(), detail: 'skills-service ответил ' + String(response.status) };
        const body = (await response.json().catch(() => ({}))) as { deleted?: boolean; skills?: number };
        if (body.deleted && (body.skills ?? 0) > 0)
            return { state: 'deleted', at: now(), skills: body.skills };
        return { state: 'absent', at: now(), skills: body.skills ?? 0, detail: 'каталог скиллов проекта пуст' };
    }

    /** Дампы: пер-проектный каталог резервных копий + строки project_backups (схема maintenance опциональна). */
    private async stepDumps(projectId: string): Promise<IDeletionDomainReceipt> {
        const safe = createHash('sha256').update(projectId).digest('hex').slice(0, 32);
        const dir = path.join(this.backupDir, 'projects', safe);
        let removed = 0;
        if (await this.tableExists('project_backups'))
            removed = (await this.pool.query('DELETE FROM project_backups WHERE project_id=$1', [projectId]))
                .rowCount ?? 0;
        const dirExisted = await access(dir)
            .then(() => true)
            .catch(() => false);
        try {
            await rm(dir, { recursive: true, force: true });
        } catch (error) {
            return { state: 'failed', at: now(), files: removed, detail: 'каталог дампов: ' + message(error) };
        }
        if (removed === 0 && !dirExisted) return { state: 'absent', at: now() };
        return { state: 'deleted', at: now(), files: removed, directory: dirExisted };
    }

    private async readReceipt(projectId: string): Promise<TDeletionReceipt> {
        const { rows } = await this.pool.query<{ deleted_resources: TDeletionReceipt | null }>(
            'SELECT deleted_resources FROM project_retirements WHERE project_id=$1',
            [projectId],
        );
        return (rows[0]?.deleted_resources as TDeletionReceipt) ?? {};
    }

    /** Атомарное по-доменное слияние квитанции (jsonb ||): нет lost-update. */
    private async mergeReceipt(projectId: string, updates: TDeletionReceipt): Promise<void> {
        const keys = Object.keys(updates);
        if (!keys.length) return;
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            for (const key of keys) {
                await client.query(
                    'UPDATE project_retirements SET deleted_resources = deleted_resources || jsonb_build_object($1::text, $2::jsonb) WHERE project_id=$3',
                    [key, JSON.stringify(updates[key as TDeletionDomain]), projectId],
                );
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    private async tableExists(table: string): Promise<boolean> {
        const { rows } = await this.pool.query<{ name: string | null }>('SELECT to_regclass($1) AS name', [table]);
        return !!rows[0]?.name;
    }

    /** Пург RAG требует роль «Главный админ»; исполнитель удаления может быть админом проекта. */
    private async mainAdminEmail(fallback: string): Promise<string> {
        try {
            const { rows } = await this.pool.query<{ email: string }>(
                'SELECT email FROM platform_users WHERE is_main_admin AND enabled ORDER BY created_at LIMIT 1',
            );
            return rows[0]?.email ?? fallback;
        } catch {
            return fallback;
        }
    }
}
