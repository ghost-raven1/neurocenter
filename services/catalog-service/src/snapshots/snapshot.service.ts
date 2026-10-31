import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    ServiceUnavailableException,
    type OnModuleDestroy,
    type OnModuleInit,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { createPool } from '../database/pool';
import { CatalogService } from '../catalog/catalog.service';
import { DeviceStore } from '../devices/device-store';
import { DeviceJobs } from '../devices/device-jobs';
import { managedBinding } from '../devices/device-compatibility';
import { normalizeEmail, type IAccessActor } from '../access/access.model';
import { securityEvent } from '../access/security-events';
import { assertInternal } from '../access/access.controller';
import { SnapshotRepository, snapshotUuid, snapshotCreateInput } from './snapshot-repository';
import { SnapshotStorage } from './snapshot-storage';
import { SnapshotSigner } from './snapshot-signature';
import { SnapshotCommands } from './snapshot-commands';
import { SNAPSHOT_CHUNK_BYTES } from '../../../shared/project-snapshot.cjs';
import type { SnapshotCreate, SnapshotRow } from './snapshot-types';

/** The HTTP service schedules work; full LanceDB verification runs outside this process. */
@Injectable()
export class SnapshotService implements OnModuleInit, OnModuleDestroy {
    readonly pool = createPool(
        { connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 6 },
        'snapshots',
    );
    readonly repository = new SnapshotRepository(this.pool);
    readonly signer = new SnapshotSigner();
    readonly commands: SnapshotCommands;
    private store?: SnapshotStorage;
    private transfers = 0;
    constructor(
        private readonly catalog: CatalogService,
        private readonly devices: DeviceStore,
        private readonly jobs: DeviceJobs,
    ) {
        this.commands = new SnapshotCommands(this.repository, this.signer, this.catalog);
    }
    async onModuleInit(): Promise<void> {
        await this.catalog.ensureSchema();
        await this.devices.ready();
    }
    async onModuleDestroy(): Promise<void> {
        await this.pool.end();
    }
    storage(): SnapshotStorage {
        return (this.store ??= new SnapshotStorage(this.pool));
    }
    actor(req: Request): IAccessActor {
        assertInternal(req.headers['x-neurocenter-internal']);
        try {
            const actor = JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || ''))) as IAccessActor;
            if (typeof actor.activeRole !== 'string') throw new Error();
            return { email: normalizeEmail(actor.email), activeRole: actor.activeRole };
        } catch {
            throw new ForbiddenException('Не подтверждён пользователь снимка.');
        }
    }
    async capabilities() {
        if (process.env.SNAPSHOT_EXECUTOR_ENABLED !== undefined && process.env.SNAPSHOT_EXECUTOR_ENABLED !== '1')
            return {
                available: false,
                reason: 'Исполнитель проверки снимков не подготовлен. Подготовьте его для новых публикаций.',
                format: 'neurocenter.lancedb-snapshot/v1',
                chunkBytes: SNAPSHOT_CHUNK_BYTES,
                maxBytes: Number(process.env.SNAPSHOT_MAX_BYTES || 16 * 1024 ** 3),
            };
        let reason: string | null = null;
        try {
            this.storage();
            await this.signer.signature({ purpose: 'configuration-check' });
        } catch {
            reason = 'Настройте хранилище и приватный ключ подписи снимков.';
        }
        const live = (
            await this.pool.query(
                "SELECT 1 FROM project_snapshot_verifiers WHERE sdk_version='0.29.0' AND last_seen>now()-interval '60 seconds' AND ($1::text IS NULL OR image_digest=$1) LIMIT 1",
                [process.env.SNAPSHOT_VERIFIER_IMAGE_DIGEST ?? null],
            )
        ).rowCount;
        if (!reason && !live) reason = 'Исполнитель проверки снимков не на связи.';
        return {
            available: reason === null,
            reason,
            format: 'neurocenter.lancedb-snapshot/v1',
            chunkBytes: SNAPSHOT_CHUNK_BYTES,
            maxBytes: Number(process.env.SNAPSHOT_MAX_BYTES || 16 * 1024 ** 3),
        };
    }
    async create(req: Request, project: string, body: SnapshotCreate) {
        snapshotCreateInput(body);
        const actor = this.actor(req),
            capabilities = await this.capabilities();
        if (!capabilities.available) throw new ServiceUnavailableException(capabilities.reason!);
        const device = await this.devices.owned(actor, body?.deviceId);
        if (!Array.isArray(device.report.capabilities) || !device.report.capabilities.includes('project-snapshots-v1'))
            throw new ConflictException('Обновите мост для полной публикации снимков LanceDB.');
        if (managedBinding(device.report, project) !== body?.expectedBindingId)
            throw new ConflictException('Привязка компьютера изменилась.');
        const row = await this.repository.create(project, actor, body);
        if (!row.job_id && row.status === 'UPLOADING') {
            try {
                const job = await this.jobs.create(actor, {
                    kind: 'publish-project-snapshot',
                    deviceId: row.device_id,
                    projectId: project,
                    requestKey: body.requestKey,
                    expectedBindingId: row.binding_id,
                    snapshotId: row.id,
                });
                await this.pool.query(
                    'UPDATE project_snapshots SET job_id=$2 WHERE id=$1 AND (job_id IS NULL OR job_id=$2)',
                    [row.id, job.id],
                );
            } catch (error) {
                await this.repository.transaction(project, actor, 3, async (client) => {
                    const job = (
                        await client.query(
                            "SELECT id FROM bridge_jobs WHERE kind='publish-project-snapshot' AND email=$1 AND device_id=$2 AND project_id=$3 AND payload->>'snapshotId'=$4 ORDER BY created_at LIMIT 1",
                            [actor.email, row.device_id, project, row.id],
                        )
                    ).rows[0];
                    if (job)
                        await client.query('UPDATE project_snapshots SET job_id=$2 WHERE id=$1 AND job_id IS NULL', [
                            row.id,
                            job.id,
                        ]);
                    else {
                        const closed = await client.query(
                            "UPDATE project_snapshots SET status='REJECTED',error='Не удалось поставить передачу в очередь. Создайте снимок заново.' WHERE id=$1 AND status='UPLOADING' AND job_id IS NULL RETURNING id",
                            [row.id],
                        );
                        if (closed.rowCount)
                            await securityEvent(client, {
                                actor: actor.email,
                                action: 'snapshot.schedule.failed',
                                resourceId: row.id,
                                before: { status: 'UPLOADING' },
                                after: { status: 'REJECTED' },
                            });
                    }
                });
                throw error;
            }
        }
        return (await this.repository.list(project, actor)).find((item) => item.snapshotId === row.id)!;
    }
    /** Keep the memory slot until a slow receiver finishes or disconnects. */
    async binary(res: Response, read: () => Promise<Buffer>): Promise<void> {
        if (this.transfers >= 3)
            throw new ServiceUnavailableException('Сейчас передаются три блока снимков. Повторите позже.');
        this.transfers++;
        const timer = setTimeout(() => res.destroy(new Error('snapshot-download-timeout')), 120000);
        timer.unref();
        try {
            const bytes = await read();
            if (res.destroyed) return;
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Length', bytes.length);
            await new Promise<void>((resolve, reject) => {
                const clean = () => {
                    res.off('finish', done);
                    res.off('close', done);
                    res.off('error', failed);
                };
                const done = () => {
                    clean();
                    resolve();
                };
                const failed = (error: Error) => {
                    clean();
                    reject(error);
                };
                res.once('finish', done);
                res.once('close', done);
                res.once('error', failed);
                res.send(bytes);
            });
        } finally {
            clearTimeout(timer);
            this.transfers--;
        }
    }
    /** Every data-plane request revalidates the exact live device lease, role and folder binding. */
    async publication(
        req: Request,
        project: string,
        id: string,
        receipt = false,
    ): Promise<{ row: SnapshotRow; actor: IAccessActor }> {
        if (!snapshotUuid(id)) throw new BadRequestException('Неверный идентификатор публикации.');
        assertInternal(req.headers['x-neurocenter-internal']);
        const token = String(req.headers.authorization || '').replace(/^Bearer /, ''),
            device = await this.devices.identity(token);
        const jobId = String(req.headers['x-neurocenter-job-id'] || ''),
            lease = String(req.headers['x-neurocenter-job-lease'] || '');
        if (!snapshotUuid(jobId) || !snapshotUuid(lease))
            throw new ForbiddenException('Нужна действующая аренда публикации.');
        const job = (
            await this.pool.query(
                "SELECT * FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND lease=$3 AND state='running' AND lease_until>now()",
                [jobId, device.id, lease],
            )
        ).rows[0];
        if (
            !job ||
            job.kind !== 'publish-project-snapshot' ||
            job.project_id !== project ||
            job.payload.snapshotId !== id
        )
            throw new ForbiddenException('Задание не разрешает эту публикацию.');
        await this.jobs.authorize(device, jobId, lease, receipt ? { snapshotReceipt: true } : undefined);
        const actor = { email: device.email, activeRole: String(job.role) };
        const row = await this.repository.transaction(project, actor, 3, async (client) => {
            const value = await this.repository.row(client, project, id, true);
            if (
                value.email !== device.email ||
                value.device_id !== device.id ||
                value.binding_id !== job.payload.bindingId ||
                (value.job_id && value.job_id !== jobId) ||
                (!['UPLOADING', 'VERIFYING', 'VERIFIED'].includes(value.status) &&
                    !(receipt && value.upload_completed_at))
            )
                throw new ConflictException('Публикация закрыта или её привязка изменилась.');
            if (!value.job_id)
                await client.query('UPDATE project_snapshots SET job_id=$2 WHERE id=$1 AND job_id IS NULL', [
                    id,
                    jobId,
                ]);
            return value;
        });
        return { row, actor };
    }
    async upload(req: Request, project: string, id: string, sha: string): Promise<{ sha256: string; bytes: number }> {
        const { row } = await this.publication(req, project, id);
        if (row.status !== 'UPLOADING' || !row.manifest)
            throw new ConflictException('Сначала закрепите опись публикуемого снимка.');
        const part = row.manifest.files.flatMap((file) => file.chunks).find((chunk) => chunk.sha256 === sha);
        if (!part) throw new ForbiddenException('Блок не входит в закреплённую опись.');
        if (
            String(req.headers['content-type'] || '')
                .split(';')[0]
                .trim()
                .toLowerCase() !== 'application/octet-stream'
        )
            throw new BadRequestException('Передайте двоичный блок потоком.');
        const declared = req.headers['content-length'];
        if (declared !== undefined && String(part.size) !== declared)
            throw new BadRequestException('Размер блока отличается от описи.');
        if (this.transfers >= 3)
            throw new ServiceUnavailableException('Сейчас передаются три блока снимков. Повторите позже.');
        this.transfers++;
        const timer = setTimeout(() => req.destroy(new Error('snapshot-upload-timeout')), 120000);
        timer.unref();
        try {
            const chunks: Buffer[] = [];
            let received = 0;
            const hash = createHash('sha256');
            for await (const value of req) {
                const bytes = Buffer.from(value);
                received += bytes.length;
                if (received > part.size) throw new BadRequestException('Блок превышает подтверждённый размер.');
                hash.update(bytes);
                chunks.push(bytes);
            }
            if (received !== part.size || hash.digest('hex') !== sha)
                throw new ConflictException('Блок усечён или его SHA изменился.');
            await this.publication(req, project, id);
            await this.storage().put(project, sha, Buffer.concat(chunks));
            await this.publication(req, project, id);
            return { sha256: sha, bytes: received };
        } finally {
            clearTimeout(timer);
            this.transfers--;
        }
    }
    async download(req: Request, project: string, id: string, sha: string): Promise<Buffer> {
        const actor = this.actor(req);
        await this.repository.transaction(project, actor, 1, async (client) => {
            const row = await this.repository.row(client, project, id);
            if (
                row.status !== 'VERIFIED' ||
                !row.manifest?.files.some((file) => file.chunks.some((chunk) => chunk.sha256 === sha))
            )
                throw new ForbiddenException('Блок не принадлежит доступному проверенному снимку.');
        });
        return this.storage().read(project, sha);
    }
}
