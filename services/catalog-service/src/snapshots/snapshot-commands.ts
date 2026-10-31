import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IAccessActor } from '../access/access.model';
import { securityEvent } from '../access/security-events';
import type { CatalogService } from '../catalog/catalog.service';
import type { IPackage } from '../catalog/bundle-package';
import { checkedProjectPackage, type IProjectPinRow } from '../catalog/project-asset-pins';
import { assertInstallablePackage, packageDependencies, installationRef } from '../devices/installation-set';
import { assertProjectCatalogAsset } from '../devices/project-skill';
import {
    SnapshotRepository,
    assertSnapshotHead,
    snapshotHash,
    snapshotInput,
    snapshotUuid,
} from './snapshot-repository';
import { SnapshotSigner } from './snapshot-signature';
import type { SnapshotCommand, SnapshotHead, SnapshotProfileInput, SnapshotRow } from './snapshot-types';
import { snapshotManifestHash } from '../../../shared/project-snapshot.cjs';

export const snapshotSignedPayload = (row: SnapshotRow) => ({
    purpose: 'project-snapshot',
    schemaVersion: 1,
    projectId: row.project_id,
    snapshotId: row.id,
    manifestSha256: row.manifest_sha256,
    manifest: row.manifest,
});
/** A server head/profile refers only to an immutable verified full image, never a row-sync marker. */
export class SnapshotCommands {
    constructor(
        private readonly repository: SnapshotRepository,
        private readonly signer: SnapshotSigner,
        private readonly catalog: CatalogService,
    ) {}
    private async verified(row: SnapshotRow): Promise<void> {
        if (
            row.status !== 'VERIFIED' ||
            !row.manifest ||
            !row.signature ||
            snapshotManifestHash(row.manifest) !== row.manifest_sha256
        )
            throw new ConflictException('Нужен полный проверенный снимок.');
        await this.signer.verify(snapshotSignedPayload(row), row.signature);
    }
    async move(
        projectId: string,
        id: string,
        actor: IAccessActor,
        input: SnapshotCommand & SnapshotHead,
        kind: 'activate' | 'rollback',
    ) {
        snapshotInput(input, ['requestKey', 'expectedHeadId', 'expectedHeadRevision']);
        return this.repository.command(
            projectId,
            actor,
            input.requestKey,
            kind,
            { id, ...input },
            async (client, project) => {
                assertSnapshotHead(project, input);
                const row = await this.repository.row(client, projectId, id, true);
                await this.verified(row);
                const revision = Number(project.head_revision) + 1;
                await client.query(
                    'UPDATE projects SET head_snapshot_id=$2,head_snapshot_date=$3,head_author=$4,head_revision=$5,updated_at=now() WHERE id=$1',
                    [projectId, id, row.created_at.toISOString(), row.email, revision],
                );
                await securityEvent(client, {
                    actor: actor.email,
                    action: 'snapshot.' + kind,
                    resourceId: projectId,
                    before: { headId: project.head_snapshot_id, headRevision: Number(project.head_revision) },
                    after: { headId: id, headRevision: revision },
                });
                return { headId: id, headRevision: revision };
            },
        );
    }
    async remove(
        projectId: string,
        id: string,
        actor: IAccessActor,
        input: SnapshotCommand & { expectedManifest: string | null; gracePeriodHours?: number },
    ) {
        snapshotInput(input, ['requestKey', 'expectedManifest', 'gracePeriodHours']);
        const grace = input.gracePeriodHours ?? 24;
        if (!Number.isSafeInteger(grace) || grace < 1 || grace > 720)
            throw new BadRequestException('Период ожидания перед очисткой: от 1 до 720 часов.');
        return this.repository.command(
            projectId,
            actor,
            input.requestKey,
            'delete',
            { id, ...input },
            async (client, project) => {
                const row = await this.repository.row(client, projectId, id, true);
                if (row.manifest_sha256 !== input.expectedManifest)
                    throw new ConflictException('Опись снимка изменилась. Обновите список.');
                const pinned = await client.query(
                    'SELECT 1 FROM project_snapshot_profiles WHERE snapshot_id=$1 LIMIT 1',
                    [id],
                );
                if (project.head_snapshot_id === id || pinned.rowCount)
                    throw new ConflictException('Текущий снимок или версия релизного профиля защищены от удаления.');
                if (['UPLOADING', 'VERIFYING'].includes(row.status))
                    throw new ConflictException('Сначала отмените незавершённую публикацию.');
                if (row.status !== 'DELETED' && row.status !== 'DELETING')
                    await client.query(
                        "UPDATE project_snapshots SET status='DELETING',delete_after=now()+($2::int*interval '1 hour') WHERE id=$1",
                        [id, grace],
                    );
                await securityEvent(client, {
                    actor: actor.email,
                    action: 'snapshot.delete.request',
                    resourceId: id,
                    before: { status: row.status },
                    after: { status: row.status === 'DELETED' ? 'DELETED' : 'DELETING', gracePeriodHours: grace },
                });
                return {
                    snapshotId: id,
                    status: row.status === 'DELETED' ? 'DELETED' : 'DELETING',
                    gracePeriodHours: grace,
                };
            },
        );
    }
    async cancel(projectId: string, id: string, actor: IAccessActor, input: SnapshotCommand) {
        snapshotInput(input, ['requestKey']);
        return this.repository.command(
            projectId,
            actor,
            input.requestKey,
            'cancel',
            { id, ...input },
            async (client) => {
                const row = await this.repository.row(client, projectId, id, true);
                if (!['UPLOADING', 'VERIFYING'].includes(row.status))
                    throw new ConflictException('Публикация уже завершена. Обновите список.');
                await client.query(
                    "UPDATE project_snapshots SET status='REJECTED',error='Публикация отменена пользователем.',verifier_owner=NULL,verifier_lease_until=NULL WHERE id=$1",
                    [id],
                );
                await securityEvent(client, {
                    actor: actor.email,
                    action: 'snapshot.cancel',
                    resourceId: id,
                    before: { status: row.status },
                    after: { status: 'REJECTED' },
                });
                return { snapshotId: id, status: 'REJECTED' };
            },
        );
    }
    async profiles(projectId: string, actor: IAccessActor) {
        return this.repository.transaction(projectId, actor, 1, async (client, project) => {
            const rows = (
                await client.query(
                    'SELECT * FROM project_snapshot_profiles WHERE project_id=$1 ORDER BY revision DESC LIMIT 200',
                    [projectId],
                )
            ).rows;
            return rows.map((row) => ({
                profileId: row.id,
                snapshotId: row.snapshot_id,
                revision: Number(row.revision),
                isActive: project.active_profile_id === row.id,
                skillPins: row.skill_pins,
                capsuleSha256: row.capsule_sha256,
                createdAt: row.created_at,
            }));
        });
    }
    async release(projectId: string, actor: IAccessActor, input: SnapshotProfileInput) {
        snapshotInput(input, [
            'requestKey',
            'snapshotId',
            'skillPins',
            'expectedProfileId',
            'expectedProfileRevision',
            'moveHead',
        ]);
        if (
            !snapshotUuid(input.snapshotId) ||
            (input.expectedProfileId !== null && !snapshotUuid(input.expectedProfileId)) ||
            !Number.isSafeInteger(input.expectedProfileRevision) ||
            input.expectedProfileRevision < 0
        )
            throw new BadRequestException('Передайте снимок и актуальную ревизию релизного профиля.');
        return this.repository.command(
            projectId,
            actor,
            input.requestKey,
            'release-profile',
            input,
            async (client, project) => {
                if (
                    (project.active_profile_id ?? null) !== input.expectedProfileId ||
                    Number(project.active_profile_revision) !== input.expectedProfileRevision
                )
                    throw new ConflictException('Релизный профиль уже изменили. Обновите список.');
                const row = await this.repository.row(client, projectId, input.snapshotId, true);
                await this.verified(row);
                if (input.moveHead) assertSnapshotHead(project, input.moveHead);
                const roots = (
                    await client.query<IProjectPinRow>(
                        'SELECT * FROM project_assets WHERE project_id=$1 ORDER BY asset_kind,asset_id FOR SHARE',
                        [projectId],
                    )
                ).rows;
                const skillPins = roots
                    .filter((pin) => pin.asset_kind === 'skill')
                    .map((pin) => {
                        const pkg = checkedProjectPackage(pin);
                        return { id: pkg.plugin.id, version: pkg.plugin.version, manifest: pkg.manifest.sha256 };
                    });
                if (input.skillPins !== undefined && snapshotHash(input.skillPins) !== snapshotHash(skillPins))
                    throw new ConflictException(
                        'Состав скиллов проекта изменился. Обновите каталог перед выпуском профиля.',
                    );
                const packages = new Map<string, IPackage>(),
                    visiting = new Set<string>();
                let bytes = 0;
                const visit = async (pkg: IPackage): Promise<void> => {
                    assertInstallablePackage(pkg);
                    assertProjectCatalogAsset(pkg.plugin.kind, pkg.plugin.id, projectId);
                    const key = pkg.plugin.kind + ':' + pkg.plugin.id,
                        known = packages.get(key);
                    if (visiting.has(key)) throw new ConflictException('Зависимости релиза образуют цикл.');
                    if (known) {
                        if (
                            known.plugin.version !== pkg.plugin.version ||
                            known.manifest.sha256 !== pkg.manifest.sha256
                        )
                            throw new ConflictException('В релизе несовместимые версии одной зависимости.');
                        return;
                    }
                    bytes += pkg.files.reduce((sum, file) => sum + file.size, 0);
                    if (packages.size >= 60 || bytes > 48 * 1024 ** 2)
                        throw new ConflictException('Релиз превышает лимит60 пакетов или48МиБ ресурсов.');
                    packages.set(key, pkg);
                    visiting.add(key);
                    for (const pin of packageDependencies(pkg)) {
                        const existing = packages.get(pin.kind + ':' + pin.id),
                            dependency = existing ?? (await this.catalog.getAiPluginPackage(pin.id, pin.version));
                        if (
                            dependency.plugin.kind !== pin.kind ||
                            dependency.plugin.version !== pin.version ||
                            dependency.manifest.sha256 !== pin.manifest
                        )
                            throw new ConflictException('Закреплённая зависимость релиза недоступна.');
                        await visit(dependency);
                    }
                    visiting.delete(key);
                };
                for (const root of roots) await visit(checkedProjectPackage(root));
                const capsule = {
                    schemaVersion: 1,
                    format: 'neurocenter.project-release',
                    projectId,
                    snapshotId: row.id,
                    snapshotManifestSha256: row.manifest_sha256,
                    skillPins,
                    roots: roots.map((pin) => installationRef(checkedProjectPackage(pin))),
                    packages: [...packages.values()].sort((a, b) =>
                        (a.plugin.kind + ':' + a.plugin.id).localeCompare(b.plugin.kind + ':' + b.plugin.id),
                    ),
                };
                const hash = snapshotHash(capsule),
                    signature = await this.signer.signature(capsule),
                    id = randomUUID(),
                    revision = Number(project.active_profile_revision) + 1;
                await client.query(
                    'INSERT INTO project_snapshot_profiles(id,project_id,snapshot_id,revision,skill_pins,capsule,capsule_sha256,signature,email) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
                    [
                        id,
                        projectId,
                        row.id,
                        revision,
                        JSON.stringify(skillPins),
                        JSON.stringify(capsule),
                        hash,
                        JSON.stringify(signature),
                        actor.email,
                    ],
                );
                const head = input.moveHead
                    ? { headId: row.id, headRevision: Number(project.head_revision) + 1 }
                    : null;
                await client.query(
                    'UPDATE projects SET active_profile_id=$2,active_profile_revision=$3,updated_at=now() WHERE id=$1',
                    [projectId, id, revision],
                );
                if (head)
                    await client.query(
                        'UPDATE projects SET head_snapshot_id=$2,head_snapshot_date=$3,head_author=$4,head_revision=$5 WHERE id=$1',
                        [projectId, row.id, row.created_at.toISOString(), row.email, head.headRevision],
                    );
                await securityEvent(client, {
                    actor: actor.email,
                    action: 'snapshot.profile.release',
                    resourceId: projectId,
                    before: {
                        profileId: project.active_profile_id,
                        profileRevision: Number(project.active_profile_revision),
                    },
                    after: {
                        profileId: id,
                        profileRevision: revision,
                        snapshotId: row.id,
                        capsuleSha256: hash,
                        ...(head ? { head } : {}),
                    },
                });
                return { profileId: id, profileRevision: revision, head };
            },
        );
    }
    async capsule(projectId: string, id: string, actor: IAccessActor) {
        if (!snapshotUuid(id)) throw new BadRequestException('Неверный идентификатор профиля.');
        return this.repository.transaction(projectId, actor, 1, async (client) => {
            const row = (
                await client.query(
                    'SELECT capsule,capsule_sha256,signature FROM project_snapshot_profiles WHERE project_id=$1 AND id=$2',
                    [projectId, id],
                )
            ).rows[0];
            if (!row || snapshotHash(row.capsule) !== row.capsule_sha256)
                throw new ConflictException('Релизный профиль недоступен или повреждён.');
            await this.signer.verify(row.capsule, row.signature);
            return { profileId: id, capsule: row.capsule, sha256: row.capsule_sha256, signature: row.signature };
        });
    }
}
