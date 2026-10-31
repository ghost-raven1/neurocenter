import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
    normalizeQuirksLimits,
    parseQuirksJsonl,
    preflightQuirkImport,
    quirkExperienceKey,
    quirkReportedExperience,
    type QuirkEntry,
} from '../../../shared/project-learning-quirks.cjs';
import { DeviceStore, type Device } from '../devices/device-store';
import { DeviceInstallations } from '../devices/device-installations';
import { InstallPlans } from '../devices/install-plans';
import type { Job } from '../devices/device-job.model';
import type { IPackage } from '../catalog/bundle-package';
import { LearningService } from '../learning/learning.service';
import {
    authorizeDeviceLearning,
    currentLearningDevice,
    deviceLearningEnvelope,
    type DeviceLearningEnvelope,
} from '../learning/device-learning-auth';
import { authorizeLearning } from '../learning/learning-access';
import { assertQuirksJob, LEARNING_QUIRKS_KIND } from './learning-quirks-jobs';
import { importQuirkSnapshot } from './learning-quirks-import';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
interface ImportEnvelope extends DeviceLearningEnvelope {
    jobId: string;
    lease: string;
    source: { jsonl: string; fileSha256: string; configurationRevision: string | null };
}
function envelope(value: unknown): ImportEnvelope {
    const body = value as ImportEnvelope,
        source = body?.source;
    if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'bindingId,instanceId,jobId,lease,projectId,source' ||
        typeof body.jobId !== 'string' ||
        !UUID.test(body.jobId) ||
        typeof body.lease !== 'string' ||
        !UUID.test(body.lease) ||
        !source ||
        typeof source !== 'object' ||
        Array.isArray(source) ||
        Object.keys(source).sort().join(',') !== 'configurationRevision,fileSha256,jsonl' ||
        typeof source.jsonl !== 'string' ||
        typeof source.fileSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(source.fileSha256) ||
        (source.configurationRevision !== null &&
            (typeof source.configurationRevision !== 'string' || !UUID.test(source.configurationRevision)))
    )
        throw new BadRequestException('Передайте проверенный источник и точное действующее задание сбора кварков.');
    deviceLearningEnvelope({ projectId: body.projectId, bindingId: body.bindingId, instanceId: body.instanceId });
    return body;
}
/** Private source ingestion is bound to the active lease and repeats ACL checks inside each learning transaction. */
@Injectable()
export class LearningQuirksService {
    constructor(
        private readonly devices: DeviceStore,
        private readonly installations: DeviceInstallations,
        private readonly plans: InstallPlans,
        private readonly learning: LearningService,
    ) {}
    async import(original: Device, value: unknown) {
        const target = envelope(value);
        let snapshot: ReturnType<typeof parseQuirksJsonl>;
        try {
            snapshot = parseQuirksJsonl(target.source.jsonl);
        } catch (error) {
            if ((error as { code?: string }).code === 'LEARNING_QUIRKS_QUOTA')
                throw new BadRequestException({ code: 'LEARNING_QUIRKS_QUOTA', message: (error as Error).message });
            throw new BadRequestException(
                'Файл кварков повреждён или неполон. Опыт не записан; исправьте источник и повторите сбор.',
            );
        }
        if (snapshot.fileSha256 !== target.source.fileSha256)
            throw new BadRequestException('SHA-256 источника кварков не совпадает. Повторите чтение.');
        const device = await currentLearningDevice(this.devices, original, target, 2),
            actor = { email: device.email, activeRole: device.role };
        const authorize = async (db: PoolClient): Promise<void> => {
            await this.currentJob(db, device, target);
        };
        const check = () =>
            this.learning.repository.read(actor, target.projectId, async (db) => {
                await this.currentJob(db, device, target);
            });
        const initial = await this.learning.repository.read(actor, target.projectId, (db) =>
            this.currentJob(db, device, target),
        );
        const pkg = initial.payload.package as IPackage;
        const limits = normalizeQuirksLimits(initial.payload.quirksLimits);
        try {
            snapshot = parseQuirksJsonl(target.source.jsonl, limits);
        } catch (error) {
            throw new BadRequestException({
                code: (error as { code?: string }).code ?? 'LEARNING_QUIRKS_INVALID',
                message: (error as Error).message,
            });
        }
        await this.learning.repository.read(actor, target.projectId, async (db) => {
            await this.currentJob(db, device, target);
            const ids = snapshot.records.map((entry) =>
                quirkExperienceKey(target.projectId, target.instanceId, entry.quirk.id, entry.recordSha256),
            );
            const existing = (
                await db.query<{ id: string }>(
                    'SELECT id FROM project_learning_experiences WHERE project_id=$1 AND id=ANY($2::uuid[])',
                    [target.projectId, ids],
                )
            ).rows.map((row) => row.id);
            try {
                preflightQuirkImport(snapshot, target, existing, limits.importedExperiences);
            } catch (error) {
                throw new BadRequestException({ code: 'LEARNING_QUIRKS_QUOTA', message: (error as Error).message });
            }
        });
        const append = async (entry: QuirkEntry) => {
            const id = quirkExperienceKey(target.projectId, target.instanceId, entry.quirk.id, entry.recordSha256);
            const exists = await this.learning.repository.read(actor, target.projectId, async (db) => {
                await this.currentJob(db, device, target);
                return !!(
                    await db.query('SELECT id FROM project_learning_experiences WHERE id=$1 AND project_id=$2', [
                        id,
                        target.projectId,
                    ])
                ).rows.length;
            });
            if (exists) return false;
            const input = quirkReportedExperience(target, entry, {
                fileSha256: snapshot.fileSha256,
                assetId: pkg.plugin.id,
                assetKind: pkg.plugin.kind as 'mcp' | 'plugin',
                version: pkg.plugin.version,
                manifest: pkg.manifest.sha256,
                configurationRevision: target.source.configurationRevision,
            });
            const result = await this.learning.repository
                .mutation<{ imported: boolean }>(
                    actor,
                    target.projectId,
                    { requestKey: input.requestKey },
                    'experience.quirk.import',
                    2,
                    async (db) => {
                        const { requestKey: _request, ...data } = input;
                        const inserted = await db.query(
                            'INSERT INTO project_learning_experiences(id,project_id,data,created_by) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(id) DO NOTHING RETURNING id',
                            [
                                id,
                                target.projectId,
                                JSON.stringify({
                                    ...data,
                                    origin: 'device',
                                    device: {
                                        deviceId: device.id,
                                        bindingId: target.bindingId,
                                        instanceId: target.instanceId,
                                    },
                                }),
                                actor.email,
                            ],
                        );
                        return {
                            result: { imported: !!inserted.rows.length },
                            resourceId: id,
                            details: {
                                origin: 'device',
                                source: 'rag_quirk',
                                trust: 'reported',
                                recordSha256: entry.recordSha256,
                                fileSha256: snapshot.fileSha256,
                            },
                        };
                    },
                    authorize,
                    true,
                )
                .catch((error) => {
                    throw Object.assign(
                        error instanceof Error ? error : new Error('Завершение записи не подтверждено.'),
                        { partialPossible: true },
                    );
                });
            return result.result.imported;
        };
        return importQuirkSnapshot(snapshot, append, check);
    }
    private async currentJob(db: PoolClient, device: Device, target: ImportEnvelope): Promise<Job> {
        await authorizeLearning(db, { email: device.email, activeRole: device.role }, target.projectId, 2);
        await authorizeDeviceLearning(db, device, target);
        const job = (
            await db.query<Job>(
                `SELECT * FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND email=$3 AND role=$4 AND project_id=$5
            AND kind=$6 AND state='running' AND lease=$7 AND lease_until>clock_timestamp() FOR SHARE`,
                [
                    target.jobId,
                    device.id,
                    device.email,
                    device.role,
                    target.projectId,
                    LEARNING_QUIRKS_KIND,
                    target.lease,
                ],
            )
        ).rows[0];
        if (!job || job.payload.bindingId !== target.bindingId || job.payload.instanceId !== target.instanceId)
            throw new ConflictException(
                'Сбор остановлен или папка изменилась. Сохранённый опыт остаётся; повторите сбор из текущей установки.',
            );
        await assertQuirksJob(
            { store: this.devices, installations: this.installations, plans: this.plans },
            device,
            job,
            db,
        );
        const pkg = job.payload.package as IPackage,
            revisions = job.payload.configurationRevisions as Array<{
                assetId: string;
                manifest: string;
                revision: string | null;
            }>;
        const revision =
            revisions.find((item) => item.assetId === pkg.plugin.id && item.manifest === pkg.manifest.sha256)
                ?.revision ?? null;
        if (revision !== target.source.configurationRevision)
            throw new ConflictException('Источник относится к другой настройке RAG. Повторите сбор.');
        return job;
    }
}
