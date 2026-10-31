import { containerObservation } from '../../../shared/container-observation.cjs';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { SnapshotRepository, snapshotUuid, snapshotInput, snapshotHash } from './snapshot-repository';
import type { SnapshotRow } from './snapshot-types';
import type { SnapshotService } from './snapshot.service';
import { snapshotSignedPayload } from './snapshot-commands';
import { securityEvent } from '../access/security-events';

/** A narrowly authenticated, external verifier owns only its currently leased readonly image. */
export class SnapshotVerifier {
    constructor(
        private readonly snapshots: SnapshotService,
        private readonly repository: SnapshotRepository = snapshots.repository,
    ) {}
    authenticate(req: Request): void {
        const expected = process.env.SNAPSHOT_VERIFIER_TOKEN,
            received = req.headers['x-neurocenter-snapshot-verifier'];
        if (!expected || expected.length < 32)
            throw new ServiceUnavailableException('Исполнитель снимков не настроен.');
        const hash = (value: string) => createHash('sha256').update(value).digest();
        if (typeof received !== 'string' || !timingSafeEqual(hash(expected), hash(received)))
            throw new ForbiddenException('Неверная авторизация исполнителя снимков.');
    }
    async claim(input: { workerId: string; sdkVersion: string; imageDigest: string; containerObservation?: unknown }) {
        snapshotInput(input, ['workerId', 'sdkVersion', 'imageDigest', 'containerObservation']);
        let observation: unknown = null;
        try {
            if (input.containerObservation !== undefined)
                observation = containerObservation(input.containerObservation);
        } catch {
            throw new BadRequestException('Некорректное наблюдение контейнеров.');
        }
        if (
            !snapshotUuid(input.workerId) ||
            input.sdkVersion !== '0.29.0' ||
            !/^sha256:[a-f0-9]{64}$/.test(input.imageDigest) ||
            (process.env.SNAPSHOT_VERIFIER_IMAGE_DIGEST &&
                process.env.SNAPSHOT_VERIFIER_IMAGE_DIGEST !== input.imageDigest)
        )
            throw new BadRequestException('Нужен поддерживаемый SDK и закреплённый образ исполнителя.');
        await this.repository.pool.query(
            'INSERT INTO project_snapshot_verifiers(id,last_seen,sdk_version,image_digest,container_observation) VALUES($1,now(),$2,$3,$4::jsonb) ON CONFLICT(id) DO UPDATE SET last_seen=now(),sdk_version=$2,image_digest=$3,container_observation=$4::jsonb',
            [
                input.workerId,
                input.sdkVersion,
                input.imageDigest,
                observation === null ? null : JSON.stringify(observation),
            ],
        );
        await requireFeaturesEnabled(['project_snapshots']);
        const candidate = (
            await this.repository.pool.query<SnapshotRow>(`SELECT * FROM project_snapshots WHERE status='VERIFYING'
            AND (verifier_owner IS NULL OR verifier_lease_until<=now()) ORDER BY created_at LIMIT 1`)
        ).rows[0];
        if (!candidate) return null;
        try {
            return await this.repository.transaction(
                candidate.project_id,
                { email: candidate.email, activeRole: candidate.role },
                3,
                async (client) => {
                    const claimed = (
                        await client.query<SnapshotRow>(
                            `UPDATE project_snapshots SET verifier_owner=$2,verifier_lease_until=now()+interval '2 minutes'
                    WHERE id=$1 AND status='VERIFYING' AND (verifier_owner IS NULL OR verifier_lease_until<=now()) RETURNING *`,
                            [candidate.id, input.workerId],
                        )
                    ).rows[0];
                    return claimed
                        ? {
                              snapshotId: claimed.id,
                              projectId: claimed.project_id,
                              manifest: claimed.manifest,
                              manifestSha256: claimed.manifest_sha256,
                          }
                        : null;
                },
            );
        } catch (error) {
            if (!(error instanceof ForbiddenException) && !(error instanceof NotFoundException)) throw error;
            const client = await this.repository.pool.connect();
            try {
                await client.query('BEGIN');
                const result = await client.query(
                    "UPDATE project_snapshots SET status='REJECTED',error='Проект удалён или права публикации отозваны.',verifier_owner=NULL,verifier_lease_until=NULL WHERE id=$1 AND status='VERIFYING' AND (verifier_owner IS NULL OR verifier_lease_until<=now()) RETURNING id",
                    [candidate.id],
                );
                if (result.rowCount)
                    await securityEvent(client, {
                        actor: 'snapshot-verifier',
                        action: 'snapshot.rejected',
                        resourceId: candidate.id,
                        before: { status: 'VERIFYING' },
                        after: { status: 'REJECTED', reason: 'AUTHORIZATION_REVOKED' },
                    });
                await client.query('COMMIT');
                return null;
            } catch (failure) {
                await client.query('ROLLBACK').catch(() => undefined);
                throw failure;
            } finally {
                client.release();
            }
        }
    }
    async lease(id: string, worker: string): Promise<SnapshotRow> {
        if (!snapshotUuid(id) || !snapshotUuid(worker)) throw new BadRequestException('Некорректная аренда снимка.');
        const row = (
            await this.repository.pool.query<SnapshotRow>(
                "SELECT * FROM project_snapshots WHERE id=$1 AND verifier_owner=$2 AND status='VERIFYING' AND verifier_lease_until>now()",
                [id, worker],
            )
        ).rows[0];
        if (!row) throw new ConflictException('Проверка отменена или передана другому исполнителю.');
        await this.repository.transaction(
            row.project_id,
            { email: row.email, activeRole: row.role },
            3,
            async () => undefined,
        );
        return row;
    }
    async renew(id: string, worker: string) {
        await this.lease(id, worker);
        const result = await this.repository.pool.query(
            "UPDATE project_snapshots SET verifier_lease_until=now()+interval '2 minutes' WHERE id=$1 AND verifier_owner=$2 AND status='VERIFYING' AND verifier_lease_until>now()",
            [id, worker],
        );
        if (!result.rowCount) throw new ConflictException('Аренда проверки истекла.');
        return { ok: true };
    }
    async block(id: string, worker: string, sha: string): Promise<Buffer> {
        const row = await this.lease(id, worker);
        if (!row.manifest?.files.some((file) => file.chunks.some((chunk) => chunk.sha256 === sha)))
            throw new ForbiddenException('Блок не входит в арендованный снимок.');
        return this.snapshots.storage().read(row.project_id, sha);
    }
    async complete(id: string, worker: string, result: unknown) {
        const row = await this.lease(id, worker);
        snapshotInput(result, [
            'format',
            'manifestSha256',
            'sdkVersion',
            'tables',
            'filesSha256',
            'fileCount',
            'bytes',
            'readRows',
        ]);
        const manifest = row.manifest!;
        const expected = {
            format: 'neurocenter.snapshot-verification/v1',
            manifestSha256: row.manifest_sha256,
            sdkVersion: '0.29.0',
            tables: manifest.tables,
            filesSha256: snapshotHash(manifest.files),
            fileCount: manifest.files.length,
            bytes: Number(row.total_bytes),
            readRows: manifest.tables.reduce((sum, table) => sum + table.rows, 0),
        };
        if (snapshotHash(result) !== snapshotHash(expected))
            throw new ConflictException('SDK не подтвердил полное чтение таблиц и точные файлы снимка.');
        await this.repository.verified(id, worker, () => this.snapshots.signer.signature(snapshotSignedPayload(row)));
        return { snapshotId: id, status: 'VERIFIED' };
    }
    async reject(id: string, worker: string, reason: unknown) {
        await this.lease(id, worker);
        const reasons: Record<string, string> = {
            FILES_CHANGED: 'Файлы снимка не совпали с описью.',
            LANCE_READ_FAILED: 'LanceDB не смог прочитать полный снимок.',
            RESOURCE_LIMIT: 'Проверка превысила лимит ресурсов.',
            STORAGE_UNAVAILABLE: 'Блоки снимка недоступны в хранилище.',
        };
        if (typeof reason !== 'string' || !reasons[reason]) throw new BadRequestException('Неверная причина отказа.');
        const row = await this.lease(id, worker);
        return this.repository.transaction(
            row.project_id,
            { email: row.email, activeRole: row.role },
            3,
            async (client) => {
                const result = await client.query(
                    "UPDATE project_snapshots SET status='REJECTED',error=$3,verifier_owner=NULL,verifier_lease_until=NULL WHERE id=$1 AND verifier_owner=$2 AND status='VERIFYING' AND verifier_lease_until>now()",
                    [id, worker, reasons[reason]],
                );
                if (!result.rowCount) throw new ConflictException('Аренда проверки истекла.');
                await securityEvent(client, {
                    actor: 'snapshot-verifier',
                    action: 'snapshot.rejected',
                    resourceId: id,
                    before: { status: 'VERIFYING' },
                    after: { status: 'REJECTED', reason },
                });
                return { snapshotId: id, status: 'REJECTED' };
            },
        );
    }
}
